import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArchive } from '../web/archive.ts';
import { reportSeriesAtFrame } from '../web/reportComparison.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let child, base;
before(async () => {
  child = spawn(path.join(root, 'target', 'debug', `c5isr-server${process.platform === 'win32' ? '.exe' : ''}`), [], {
    cwd: root, windowsHide: true, env: { ...process.env, C5ISR_PORT: '0', C5ISR_DISABLE_MODEL: '1', C5ISR_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server readiness timeout')), 15_000);
    child.once('error', err => { clearTimeout(timeout); reject(err); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)); });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
});
after(() => { child?.kill(); });

async function get(route) {
  const response = await fetch(base + route);
  assert.equal(response.status, 200);
  return response.json();
}
async function post(route, body, status = 200) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test('serves compiled frontend and a coherent initial contract', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/);
  const state = await get('/api/state');
  assert.equal(state.tick, 0);
  assert.equal(state.running, false);
  assert.equal(state.units.length, 8);
  assert.ok(state.units.every(u => u.side === 'blue'));
  assert.ok(state.history.every(frame => frame.units.every(u => u.side === 'blue')));
  assert.equal(state.perception.active_contacts, 0);
  assert.equal(state.perception.cycle_ticks, 8);
  assert.equal(state.automation.mode, 'manual');
  assert.equal(state.automation.interval_seconds, 60);
  assert.ok(state.observations.length > 0);
  assert.ok(state.proposals.some(p => p.status === 'pending'));
  assert.ok(Array.isArray(state.decision_log));
  assert.ok(state.decision_log.some(event => event.kind === 'created'));
  assert.ok(state.history.every(frame => Number.isSafeInteger(frame.decision_seq)));
  assert.equal(state.model.available, false);
  assert.ok(state.units.every(u => u.x >= 0 && u.x <= 100));
});

test('SSE immediately supplies a typed state event', async () => {
  const abort = new AbortController();
  const response = await fetch(base + '/api/events', { signal: abort.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  try {
    let text = '';
    while (!text.includes('\n\n')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /event: state/);
    assert.equal(JSON.parse(text.match(/data: (.+)/)[1]).schema_version, 1);
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
});

test('approval, simulation advance, feedback and export form a complete loop', async () => {
  await post('/api/control', { action: 'reset', value: 777 });
  const initial = await get('/api/state');
  const proposal = initial.proposals.find(p => p.action === 'restore_link');
  assert.ok(proposal);
  await post('/api/control', { action: 'step' });
  let state = await get('/api/state');
  assert.equal(state.metrics.completed_tasks, 0);
  await post(`/api/proposals/${proposal.id}/review`, { run_id: initial.run_id, approve: true });
  await post(`/api/proposals/${proposal.id}/review`, { run_id: initial.run_id, approve: true }, 400);
  for (let i = 0; i < 4; i++) state = await post('/api/control', { action: 'step' });
  const completed = state.proposals.find(p => p.id === proposal.id);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.outcome);
  assert.ok(state.links.find(l => l.id === proposal.subject_id).quality > initial.links.find(l => l.id === proposal.subject_id).quality);
  const archive = await get('/api/export');
  assert.equal(archive.snapshot.tick, state.tick);
  assert.ok(archive.journal.some(e => e.kind === 'review'));
  assert.ok(archive.snapshot.history.length > 1);
});

test('a delayed approve or reject cannot act on a reused ID after reset', async () => {
  const reset = () => post('/api/control', { action: 'reset', value: 20261022 });
  const old = await reset();
  const current = await reset();
  const id = old.proposals[0].id;
  const route = `/api/proposals/${id}/review`;
  assert.notEqual(old.run_id, current.run_id);
  assert.ok(current.proposals.some(p => p.id === id && p.status === 'pending'));
  for (const approve of [true, false]) {
    await post(route, { run_id: old.run_id, approve }, 409);
  }
  const malformed = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"approve":true}' });
  assert.equal(malformed.status, 422);
  const recorded = await get('/api/export');
  assert.deepEqual(recorded.snapshot.decision_log, current.decision_log);
  assert.equal(recorded.journal.some(e => e.kind === 'review'), false);
  const valid = await post(route, { run_id: current.run_id, approve: true });
  assert.equal(valid.proposals.find(p => p.id === id).status, 'approved');
});

test('fault injection changes state and recover clears the outage', async () => {
  const fault = await post('/api/inject', { kind: 'link_loss' });
  assert.ok(fault.links.some(l => !l.enabled));
  const recovery = await post('/api/inject', { kind: 'recover' });
  assert.ok(recovery.links.every(l => l.enabled));
  await post('/api/inject', { kind: 'unsupported' }, 400);
  await post('/api/control', { action: 'speed', value: 99 }, 400);
  await post('/api/model/analyze', {}, 503);
});

test('approved refresh waits for link recovery, arrives without backdating, and replays its original evidence', async () => {
  await post('/api/control', { action: 'reset', value: 20261022 });
  const fault = await post('/api/inject', { kind: 'link_loss' });
  const offline = fault.links.find(link => !link.enabled);
  assert.ok(offline);
  const proposal = fault.proposals.find(candidate =>
    candidate.action === 'request_observation' && candidate.subject_id === offline.from && candidate.status === 'pending');
  assert.ok(proposal, 'a disconnected source must offer a reviewable refresh request');
  const created = fault.decision_log.find(event => event.proposal_id === proposal.id && event.kind === 'created');
  assert.ok(created?.proposal);
  assert.equal(created.proposal.status, 'pending');
  assert.deepEqual(created.evidence.map(observation => observation.id).sort(), [...proposal.evidence_ids].sort());
  assert.ok(created.evidence.length > 0);
  assert.ok(created.evidence.every(observation => observation.received_tick <= created.tick));
  const creationFrame = structuredClone(fault.history.at(-1));
  const originalEvidence = structuredClone(created.evidence);

  let state = await post('/api/control', { action: 'step' });
  assert.ok(!state.decision_log.some(event => event.proposal_id === proposal.id && event.kind === 'buffered'));
  const approved = await post(`/api/proposals/${proposal.id}/review`, { run_id: fault.run_id, approve: true });
  const approvalEvent = approved.decision_log.find(event => event.proposal_id === proposal.id && event.kind === 'approved');
  assert.equal(approvalEvent.actor, 'human');
  assert.deepEqual(approvalEvent.evidence, originalEvidence);
  const approvalFrame = structuredClone(approved.history.at(-1));
  for (let step = 0; step < 5; step++) state = await post('/api/control', { action: 'step' });
  const buffered = state.decision_log.find(event => event.proposal_id === proposal.id && event.kind === 'buffered');
  assert.ok(buffered?.report_id, 'approved execution must create an identifiable buffered report');
  const reportId = buffered.report_id;
  const sampledTick = buffered.sampled_tick;
  assert.ok(Number.isSafeInteger(sampledTick) && sampledTick > approvalEvent.tick);
  assert.equal(state.proposals.find(candidate => candidate.id === proposal.id).status, 'completed');
  assert.ok(!state.observations.some(observation => observation.id === reportId));
  assert.ok(!state.decision_log.some(event => event.report_id === reportId && event.kind === 'received'));
  const bufferedFrame = structuredClone(state.history.at(-1));

  state = await post('/api/inject', { kind: 'recover' });
  const sent = state.decision_log.find(event => event.report_id === reportId && event.kind === 'sent');
  assert.ok(sent, 'the unexpired original report must be sent after recovery');
  assert.equal(sent.sampled_tick, sampledTick);
  assert.ok(sent.tick > sampledTick);
  assert.ok(!state.observations.some(observation => observation.id === reportId));
  const latency = state.links.find(link => link.id === offline.id).latency_ticks;
  const sendFrame = structuredClone(state.history.at(-1));
  let received;
  for (let step = 0; step < latency + 3; step++) {
    state = await post('/api/control', { action: 'step' });
    received = state.decision_log.find(event => event.report_id === reportId && event.kind === 'received');
    if (received) break;
    assert.ok(!state.observations.some(observation => observation.id === reportId));
  }
  assert.ok(received, 'the fixed-seed recovery fixture must deliver its queued report');
  assert.equal(received.tick, state.tick);
  assert.equal(received.sampled_tick, sampledTick);
  assert.ok(received.tick >= sent.tick + latency);
  assert.ok(received.tick <= sent.tick + latency + 2);
  const observation = state.observations.find(candidate => candidate.id === reportId);
  assert.ok(observation);
  assert.equal(observation.observed_tick, sampledTick);
  assert.equal(observation.received_tick, received.tick);
  assert.ok(observation.received_tick > observation.observed_tick);
  assert.deepEqual(received.evidence.find(candidate => candidate.id === reportId), observation);

  const atFrame = frame => state.decision_log.filter(event => event.seq <= frame.decision_seq);
  const createdAtFrame = atFrame(creationFrame).filter(event => event.proposal_id === proposal.id);
  assert.equal(createdAtFrame.at(-1).kind, 'created');
  assert.deepEqual(createdAtFrame.at(-1).evidence, originalEvidence);
  assert.equal(atFrame(approvalFrame).filter(event => event.proposal_id === proposal.id).at(-1).kind, 'approved');
  assert.equal(atFrame(approvalFrame).filter(event => event.proposal_id === proposal.id).at(-1).actor, 'human');
  assert.ok(atFrame(bufferedFrame).some(event => event.report_id === reportId && event.kind === 'buffered'));
  assert.ok(!atFrame(bufferedFrame).some(event => event.report_id === reportId && event.kind === 'sent'));
  for (const frame of state.history.filter(frame => frame.tick < received.tick)) {
    assert.ok(!atFrame(frame).some(event => event.report_id === reportId && event.kind === 'received'));
    assert.ok(!atFrame(frame).some(event => event.evidence?.some(candidate => candidate.id === reportId)));
  }
  assert.ok(atFrame(sendFrame).some(event => event.report_id === reportId && event.kind === 'sent'));
  assert.ok(!atFrame(sendFrame).some(event => event.report_id === reportId && event.kind === 'received'));
  assert.ok(atFrame(state.history.at(-1)).some(event => event.report_id === reportId && event.kind === 'received'));
  assert.deepEqual(state.decision_log.find(event => event.seq === created.seq).evidence, originalEvidence);
  assert.ok(state.decision_log.every((event, index, events) => index === 0 || event.seq > events[index - 1].seq));

  const archive = await get('/api/export');
  assert.deepEqual(archive.snapshot.decision_log, state.decision_log);
  assert.deepEqual(archive.snapshot.history, state.history);
  const replay = parseArchive(JSON.stringify(archive));
  assert.deepEqual(replay.history, state.history);
  assert.deepEqual(replay.decision_log, state.decision_log);
  assert.equal(replay.history.at(-1).decision_seq, state.history.at(-1).decision_seq);
  assert.ok(archive.journal.some(entry => entry.kind === 'review' && entry.payload.id === proposal.id));
  assert.deepEqual(archive.model_runs, [], 'HTTP acceptance must remain offline');
});

test('both node views replay the same report revision and their own receipt across an outage', async () => {
  const initial = await post('/api/control', { action: 'reset', value: 20261022 });
  const senders = initial.units.filter(unit => unit.side === 'blue' && unit.id !== 'command');
  assert.deepEqual(initial.report_versions.map(row => row.source_id).sort(), senders.map(unit => unit.id).sort());
  for (const row of initial.report_versions) {
    assert.ok(initial.observations.some(o => o.id === row.report_id && o.source_id === row.source_id));
    assert.deepEqual([row.version, row.sampled_tick, row.field_received_tick, row.center_received_tick, row.proposal_id],
      [1, 0, 0, 0, null]);
  }

  let state = await post('/api/inject', { kind: 'link_loss' });
  const source = state.links.find(link => !link.enabled).from;
  const proposal = state.proposals.find(p => p.action === 'request_observation' && p.subject_id === source);
  const original = initial.report_versions.find(row => row.source_id === source);
  const seenLive = new Map();
  let reportId;
  for (let tick = 0; tick <= 9; tick++) {
    if (tick > 0) state = await post('/api/control', { action: 'step' });
    if (tick === 1) state = await post(`/api/proposals/${proposal.id}/review`, { run_id: initial.run_id, approve: true });
    if (tick === 6) state = await post('/api/inject', { kind: 'recover' });
    assert.equal(state.tick, tick);
    const rows = state.report_versions.filter(row => row.source_id === source);
    const series = reportSeriesAtFrame(state.report_versions, state.history.at(-1)).find(item => item.source_id === source);
    assert.deepEqual([series.field?.version, series.center?.version], [tick >= 4 ? 2 : 1, tick >= 9 ? 2 : 1]);
    assert.deepEqual(rows.find(row => row.version === 1), original);
    if (tick < 3) {
      assert.equal(rows.length, 1, 'approval alone must not issue another version');
    } else {
      assert.equal(rows.length, 2, 'each approved sample produces exactly one revision for both recipients');
      if (tick === 3) {
        reportId = state.decision_log.find(e => e.proposal_id === proposal.id && e.kind === 'buffered').report_id;
        assert.notEqual(reportId, original.report_id);
      }
      assert.deepEqual(rows.find(row => row.version === 2), {
        source_id: source, version: 2, report_id: reportId, sampled_tick: 3, proposal_id: proposal.id,
        field_received_tick: tick >= 4 ? 4 : null, center_received_tick: tick >= 9 ? 9 : null,
      });
      assert.equal(state.observations.some(o => o.id === reportId), tick === 9,
        'only the center receipt publishes the sample as pooled evidence');
    }
    seenLive.set(tick, series);
  }
  const events = state.decision_log.filter(event => event.report_id === reportId);
  assert.deepEqual(events.map(event => [event.kind, event.tick]), [['buffered', 3], ['sent', 6], ['received', 9]]);

  const archive = await get('/api/export');
  const replay = parseArchive(JSON.stringify(archive));
  assert.deepEqual(replay.report_versions, state.report_versions);
  for (const frame of replay.history) {
    const series = reportSeriesAtFrame(replay.report_versions, frame).find(item => item.source_id === source);
    assert.deepEqual(series, seenLive.get(frame.tick), `replayed view must match the actual live view at tick ${frame.tick}`);
  }

  delete archive.snapshot.report_versions;
  assert.throws(() => parseArchive(JSON.stringify(archive)), 'a marked desk archive needs its receipt ledger');
  delete archive.snapshot.desk_review_version;
  const legacyLog = replay.decision_log.filter(event => !event.kind.startsWith('desk_'));
  archive.snapshot.decision_log = legacyLog;
  const oldArchive = parseArchive(JSON.stringify(archive));
  assert.equal(oldArchive.report_versions, undefined);
  assert.equal(oldArchive.desk_review_version, undefined);
  assert.deepEqual(oldArchive.decision_log, legacyLog);
  const reset = await post('/api/control', { action: 'reset', value: 20261022 });
  assert.deepEqual(reset.report_versions, initial.report_versions);
});

test('live desk reads actual outage reports and freezes the basis of each judgment in replay', async () => {
  const seed = 20261022;
  const initial = await post('/api/control', { action: 'reset', value: seed });
  const fault = await post('/api/inject', { kind: 'link_loss' });
  const source = fault.links.find(link => !link.enabled).from;
  const task = fault.proposals.find(p => p.action === 'request_observation' && p.subject_id === source);
  const desk = state => state.decision_log.filter(e => e.proposal_id === task.id && e.kind.startsWith('desk_'));
  const path = '/api/review-desk/judgments';
  const step = () => post('/api/control', { action: 'step' });
  assert.equal(initial.desk_review_version, 1);
  await step();
  await post(`/api/proposals/${task.id}/review`, { run_id: initial.run_id, approve: true });
  await step();
  let state = await step();
  const relay = desk(state)[0].desk_report;
  const cached = initial.report_versions.find(row => row.source_id === source);
  assert.deepEqual([relay.kind, relay.root_id, relay.root_sampled_tick, relay.received_tick, relay.claim],
    ['relay', cached.report_id, cached.sampled_tick, 3, null]);
  const reportId = state.decision_log.find(e => e.proposal_id === task.id && e.kind === 'buffered').report_id;
  assert.deepEqual(desk(state).map(e => e.kind), ['desk_received']);
  const command = (seq, ids) => ({ run_id: initial.run_id, case_id: task.id, expected_read_seq: seq, evidence_ids: ids });
  await post(path, command(0, [relay.id]), 400);
  for (let i = 0; i < 3; i++) state = await step();
  const relayRead = desk(state).find(e => e.kind === 'desk_read');
  assert.equal(relayRead.tick, 6);
  assert.equal(relayRead.desk_report.claim, 'continuous');
  await post(path, command(relayRead.seq, [reportId]), 400);
  const firstCommand = command(relayRead.seq, [relay.id]);
  state = await post(path, firstCommand);
  const frozen = desk(state).at(-1);
  assert.deepEqual(frozen.desk_judgment, {
    actor: 'human', finding: 'continuous', read_ids: [relay.id], evidence_ids: [relay.id],
  });
  await post(path, firstCommand, 400);
  await post('/api/inject', { kind: 'recover' });
  for (let i = 0; i < 3; i++) state = await step();
  const arrival = desk(state).at(-1);
  assert.equal(arrival.kind, 'desk_received');
  assert.deepEqual([arrival.tick, arrival.desk_report.id, arrival.desk_report.received_tick, arrival.desk_report.claim],
    [9, reportId, 9, null]);
  assert.equal(state.report_versions.find(v => v.report_id === reportId).center_received_tick, arrival.tick);
  assert.equal(desk(state).filter(e => e.kind === 'desk_read').length, 1);
  for (let i = 0; i < 3; i++) state = await step();
  const secondRead = desk(state).find(e => e.kind === 'desk_read' && e.desk_report.id === reportId);
  assert.deepEqual([secondRead.tick, secondRead.desk_report.sampled_tick, secondRead.desk_report.claim], [12, 3, 'gap']);
  const both = [relay.id, reportId];
  const conflict = desk(state).at(-1);
  assert.deepEqual(desk(state).at(-1).desk_judgment, { actor: 'rule', finding: 'conflict', read_ids: both, evidence_ids: both });
  await post(path, command(relayRead.seq, [relay.id]), 400);
  await post(path, command(secondRead.seq, [reportId, reportId]), 400);
  const finalCommand = command(secondRead.seq, [reportId]);
  const submit = () => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(finalCommand),
  });
  const concurrent = await Promise.all([submit(), submit()]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 400]);
  const original = await get('/api/state');
  const studyPath = '/api/strategy-study';
  const fork = { run_id: original.run_id, case_id: task.id, conflict_seq: conflict.seq };
  await post(studyPath, { ...fork, conflict_seq: desk(original).at(-1).seq, delivery: 'normal' }, 400);
  await post(studyPath, { ...fork, case_id: 'absent', delivery: 'normal' }, 400);
  await post(studyPath, { ...fork, delivery: 'delayed', material: 'copy' }, 400);
  await post(studyPath, { ...fork, delivery: 'lost', material: 'partial' }, 400);
  const studies = [];
  const conditions = [['normal', 'complete'], ['normal', 'copy'], ['normal', 'partial'], ['delayed', 'complete'], ['lost', 'complete']];
  for (const [delivery, material] of conditions) {
    const body = { ...fork, delivery, material };
    const result = await post(studyPath, body);
    studies.push(result);
    assert.deepEqual(await post(studyPath, body), result);
    assert.equal(result.schema_version, 2);
    assert.equal(result.material, material);
    assert.deepEqual(result.frames[0].immediate.decisions[0].evidence_ids, [reportId]);
    assert.deepEqual(result.frames[0].verify.decisions[0].evidence_ids, both);
    assert.deepEqual(result.frames[0].immediate.reports, result.frames[0].verify.reports);
    assert.deepEqual(result.settlement.field_record, studies[0].settlement.field_record);
    assert.equal(result.settlement.immediate.wrong, 1);
    assert.equal(result.settlement.verify.verification_requests, 1);
    const concludeAt = material === 'complete' ? { normal: 18, delayed: 27, lost: null }[delivery] : null;
    const score = result.settlement.verify;
    assert.equal(score.decision_tick, concludeAt);
    assert.equal(score.unresolved, Number(concludeAt === null));
    assert.equal(score.wait_ticks, (concludeAt ?? 30) - 12);
    const reason = delivery === 'lost' ? 'not_received' : { complete: null, copy: 'same_source', partial: 'partial_coverage' }[material];
    assert.equal(score.unresolved_reason, reason);
  }
  assert.deepEqual(await post(studyPath, { ...fork, delivery: 'normal' }), studies[0], 'older clients default to the full independent record');
  for (const study of studies.filter(s => s.delivery === 'normal')) {
    assert.deepEqual(study.link_events, studies[0].link_events);
    assert.deepEqual(study.frames.map(f => f.immediate), studies[0].frames.map(f => f.immediate));
    const at = tick => study.frames.find(f => f.tick === tick).verify;
    assert.deepEqual(at(15), studies[0].frames.find(f => f.tick === 15).verify, 'unread envelopes reveal no material differences');
    const unopened = at(15).reports[2];
    assert.equal(unopened.received_tick, 15);
    assert.equal(unopened.read_tick, null);
    assert.equal(unopened.claim, null);
    assert.equal(unopened.root_id, null);
    assert.equal(unopened.coverage, undefined);
    const read = at(18).reports[2];
    const decision = at(18).decisions.at(-1);
    const copy = study.material === 'copy';
    assert.equal(read.read_tick, 18);
    assert.equal(read.root_id === reportId, copy);
    assert.deepEqual(read.coverage.map(row => row.slot), study.material === 'partial' ? [1, 2, 3] : [1, 2, 3, 4]);
    assert.ok(read.coverage.every(row => row.present === (copy ? null : true)));
    assert.equal(decision.action, study.material === 'complete' ? 'conclude' : 'insufficient');
    assert.deepEqual(decision.read_ids, [...both, read.id]);
    assert.deepEqual(decision.evidence_ids, copy ? [reportId, read.id] : [read.id]);
  }
  assert.equal(studies.at(-1).frames.at(-1).verify.reports.length, 2, 'no reply is invented at the deadline');
  assert.deepEqual(await get('/api/state'), original, 'the fork must not advance or mutate the live experiment');
  assert.doesNotMatch(JSON.stringify(original), /field_record|recorded_samples|verification-proposal|strategy_studies/);
  const recorded = parseArchive(JSON.stringify(await get('/api/export')));
  assert.deepEqual(recorded.strategy_studies, studies);
  assert.equal(recorded.desk_review_version, 1);
  const judgments = desk(recorded).filter(e => e.kind === 'desk_judged');
  assert.deepEqual(judgments.find(e => e.seq === frozen.seq), frozen);
  assert.deepEqual(judgments.at(-1).desk_judgment, { actor: 'human', finding: 'gap', read_ids: both, evidence_ids: [reportId] });
  assert.equal(judgments.filter(e => e.desk_judgment.actor === 'human').length, 2);
  const sample = parseArchive(JSON.stringify(await get('/examples/two-node-replay.json')));
  assert.deepEqual(desk(sample), desk(recorded), 'bundled desk timeline must match the live run');
  assert.deepEqual(sample.history, recorded.history);
  assert.deepEqual(sample.strategy_studies, studies, 'the bundled forks must reproduce the live server results');
  await post('/api/control', { action: 'reset', value: seed });
  await post(path, finalCommand, 409);
  await post(studyPath, { ...fork, delivery: 'normal' }, 409);
  assert.deepEqual((await get('/api/export')).strategy_studies, []);
  assert.deepEqual(desk(await get('/api/state')), []);
});

test('play/pause uses the server clock and single-step refuses to race it', async () => {
  const start = await post('/api/control', { action: 'play' });
  await post('/api/control', { action: 'step' }, 400);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const pause = await post('/api/control', { action: 'pause' });
  assert.ok(pause.tick > start.tick);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await get('/api/state')).tick, pause.tick);
});

test('rejects cross-origin writes and unknown API paths', async () => {
  const crossOrigin = await fetch(base + '/api/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{"action":"play"}',
  });
  assert.equal(crossOrigin.status, 403);
  const unknown = await fetch(base + '/api/missing');
  assert.equal(unknown.status, 404);
});

test('own-side view discovers dynamic contacts only after reports and archives expired contacts', async () => {
  let state = await post('/api/control', { action: 'reset', value: 20261022 });
  assert.ok(!JSON.stringify(state).includes('us-f35'));
  await post('/api/control', { action: 'observation_cycle', value: 32 });
  for (let i = 0; i < 31; i++) state = await post('/api/control', { action: 'step' });
  assert.equal(state.perception.total_discovered, 0);
  assert.ok(state.units.every(unit => unit.side === 'blue'));
  state = await post('/api/control', { action: 'observation_cycle', value: 4 });
  assert.equal(state.perception.next_scan_tick, state.tick + 4);
  await post('/api/control', { action: 'observation_cycle', value: 5 }, 400);
  const firstSeen = new Map();
  for (let i = 0; i < 130; i++) {
    state = await post('/api/control', { action: 'step' });
    for (const unit of state.units.filter(unit => unit.side === 'red')) {
      assert.ok(unit.contact);
      assert.ok(unit.contact.last_seen_tick <= state.tick);
      assert.ok(unit.contact.expires_tick > state.tick);
      if (!firstSeen.has(unit.id)) {
        firstSeen.set(unit.id, state.tick);
        assert.ok(state.history.filter(frame => frame.tick < state.tick).every(frame => !frame.units.some(old => old.id === unit.id)));
        assert.ok(state.events.some(event => event.kind === 'contact_discovered' && event.related_id === unit.id));
      }
    }
  }
  assert.ok(firstSeen.size > 1);
  assert.ok(state.perception.total_archived > 0);
  assert.ok([...firstSeen.keys()].some(id => !state.units.some(unit => unit.id === id)));
  const archive = await get('/api/export');
  assert.equal(archive.scenario_version, 'archipelago-2-own-view');
  assert.equal(archive.snapshot.perception.total_archived, state.perception.total_archived);
  assert.ok(!('hidden_units' in archive.snapshot));
  assert.ok(archive.snapshot.report_versions.every(row => row.version === 1
    && state.units.some(unit => unit.id === row.source_id && unit.side === 'blue' && unit.id !== 'command')),
  'ordinary samples and reportable contacts never create new own-network report editions');
});

test('unavailable AI never silently starts a rule-only automatic mode and manual stop pauses', async () => {
  await post('/api/automation', { mode: 'ai' }, 503);
  assert.equal((await get('/api/state')).automation.mode, 'manual');
  await post('/api/automation', { mode: 'unsupported' }, 400);
  await post('/api/control', { action: 'play' });
  const stopped = await post('/api/automation', { mode: 'manual' });
  assert.equal(stopped.running, false);
  assert.equal(stopped.automation.mode, 'manual');
  assert.equal(stopped.automation.next_run_in_seconds, null);
});

const evidenceConfig = { seed: 20261022, read_interval: 3 };

test('bundled evidence example reproduces both branches with the same read queues and citations', async () => {
  const example = await get('/examples/evidence-review.json');
  assert.equal(example.kind, 'c5isr-evidence-lab');
  const before = await get('/api/state');
  const live = await post('/api/evidence/run', example.config);
  const { advice = [], batch = [], ...recorded } = example;
  assert.deepEqual(live, recorded);
  assert.deepEqual(advice, [], 'bundled example must not claim a model opinion');
  if (batch.length) assert.deepEqual(await post('/api/evidence/batch', { config: example.config, count: batch.length }), batch);
  assert.deepEqual(live.immediate.frames.slice(0, live.fork_tick), live.review.frames.slice(0, live.fork_tick));
  let sawUnread = false, sawCorrection = false;
  for (const branch of [live.immediate, live.review]) {
    for (const frame of branch.frames) {
      const received = new Map(frame.reports.map(report => [report.id, report]));
      assert.ok(frame.reports.every(report => report.received_tick <= frame.tick));
      assert.deepEqual(frame.queue_ids, frame.reports.filter(report => report.read_tick === null).map(report => report.id));
      sawUnread ||= frame.queue_ids.length > 0;
      for (const id of frame.active_ids) assert.ok(Number.isSafeInteger(received.get(id)?.read_tick));
      for (const decision of frame.decisions) {
        assert.ok(decision.tick <= frame.tick);
        for (const id of decision.evidence_ids) {
          const report = received.get(id);
          assert.ok(decision.read_ids.includes(id) && Number.isSafeInteger(report?.read_tick) && report.read_tick <= decision.tick);
        }
      }
      sawCorrection ||= frame.active_ids.some(id => received.get(id).revises === 'R1');
    }
  }
  assert.ok(sawUnread && sawCorrection);
  const decision = live.immediate.frames[live.fork_tick].decisions.at(-1);
  assert.deepEqual(decision.evidence_ids, ['R1', 'R2']);
  assert.deepEqual(decision.independent_roots, ['R1']);
  assert.equal(live.review.frames[live.fork_tick].decisions.at(-1).action, 'request_review');
  assert.deepEqual(await get('/api/state'), before, 'running a lab or opening its example never changes the live system');
});

test('paired seed batches match independent runs and custom citations belong to the selected frame', async () => {
  const count = 3;
  const rows = await post('/api/evidence/batch', { config: evidenceConfig, count });
  assert.equal(rows.length, count);
  for (const [offset, row] of rows.entries()) {
    const seed = evidenceConfig.seed + offset;
    const run = await post('/api/evidence/run', { ...evidenceConfig, seed });
    assert.deepEqual(row, { seed, immediate: run.immediate.metrics, review: run.review.metrics });
  }
  const custom = await post('/api/evidence/run', { ...evidenceConfig, cited_ids: ['R2'] });
  const decision = custom.immediate.frames[custom.fork_tick].decisions.at(-1);
  assert.equal(decision.actor, 'human');
  assert.deepEqual(decision.evidence_ids, ['R2']);
  assert.deepEqual(decision.independent_roots, ['R1']);
  for (const config of [
    { ...evidenceConfig, read_interval: 0 }, { ...evidenceConfig, read_interval: 7 },
    { ...evidenceConfig, fork_tick: 0 }, { ...evidenceConfig, fork_tick: 37 },
    { ...evidenceConfig, cited_ids: [] }, { ...evidenceConfig, cited_ids: ['R1','R1'] },
    { ...evidenceConfig, cited_ids: ['R4'] },
  ]) await post('/api/evidence/run', config, 400);
  for (const batch of [
    { config: evidenceConfig, count: 0 }, { config: evidenceConfig, count: 33 },
    { config: { ...evidenceConfig, seed: 4294967295 }, count: 2 },
    { config: { ...evidenceConfig, cited_ids: ['R2'] }, count: 2 },
  ]) await post('/api/evidence/batch', batch, 400);
});

test('advice uses server-reconstructed evidence and disabled models and unowned cancellations leave no jobs', async () => {
  const initial = await get('/api/state');
  const baseRequest = { config: evidenceConfig, tick: 24, branch: 'immediate', request_id: 'offline-http-test' };
  await post('/api/evidence/advice', { ...baseRequest, tick: 0 }, 400);
  await post('/api/evidence/advice', { ...baseRequest, tick: 1000 }, 400);
  await post('/api/evidence/advice', { ...baseRequest, request_id: '../invalid' }, 400);
  const injected = await fetch(base + '/api/evidence/advice', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...baseRequest, reports: [{ id: 'R4', read_tick: 1 }] }),
  });
  assert.equal(injected.status, 422);
  for (const branch of ['immediate', 'review']) {
    const disabled = await post('/api/evidence/advice', { ...baseRequest, branch }, 503);
    assert.match(disabled.error, /C5ISR_DISABLE_MODEL/);
    assert.ok(!('provider' in disabled));
  }
  await post('/api/evidence/advice/cancel', { request_id: baseRequest.request_id }, 409);
  const end = await get('/api/state');
  assert.equal(end.model.busy, false);
  assert.deepEqual(end, initial);
  assert.deepEqual((await get('/api/export')).model_runs, []);
});
