import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseArchive } from './archive.ts';

const frame = (tick, decision_seq) => ({
  tick, decision_seq, units: [], links: [],
  metrics: { delivered: 0, dropped: 0, pending_messages: 0, completed_tasks: 0, avg_latency_ticks: 0, freshness: 1 },
  perception: { cycle_ticks: 8, next_scan_tick: 8, active_contacts: 0, total_discovered: 0, total_archived: 0 },
});
const archive = (history, decision_log, report_versions) => JSON.stringify({
  kind: 'c5isr-synthetic-experiment', schema_version: 1, snapshot: { history, decision_log, report_versions },
  journal: [{ kind: 'irrelevant' }], model_runs: ['irrelevant'],
});
const event = (seq, tick) => ({ seq, tick, kind: 'sent', proposal_id: 'P1', sampled_tick: tick, report_id: 'R1' });

test('reader only exposes the recorded frames and decisions and accepts retention gaps', () => {
  const history = [frame(3, 8), frame(4, 12)];
  const decisions = [event(7, 2), event(9, 4), event(12, 4)];
  assert.deepEqual(parseArchive(archive(history, decisions)), { history, decision_log: decisions });
});

test('reader accepts older own-view exports without fabricating decision cutoffs', () => {
  const parsed = parseArchive(archive([frame(3)], undefined));
  assert.equal(parsed.history[0].decision_seq, undefined);
  assert.equal(parsed.report_versions, undefined);
  assert.deepEqual(parsed.decision_log, []);
  assert.throws(() => parseArchive(archive([frame(3, 1)], undefined)));
});

test('link transitions survive an online frame ending and a clipped left edge, with one cursor shared with reports', () => {
  const up = { enabled: true, latency_ticks: 2, quality: 0.93 };
  const down = { enabled: false, latency_ticks: 9, quality: 0.08 };
  const link = { id: 'link-a', from: 'node-a', to: 'command', ...up };
  const earlier = { ...frame(5, 7), links: [link], link_changes: [] };
  const later = { ...frame(6, 12), links: [link], link_changes: [
    { seq: 8, link_id: link.id, cause: 'link_loss', before: up, after: down },
    { seq: 10, link_id: link.id, cause: 'recover', before: down, after: up },
  ] };
  const log = [event(7, 4), event(9, 6), event(12, 6)];
  for (const frames of [[earlier, later], [later]]) {
    assert.deepEqual(parseArchive(archive(frames, log)).history.at(-1).link_changes, later.link_changes);
  }
  for (const corrupt of [
    f => { f.link_changes.reverse(); },
    f => { f.link_changes[0].seq = 7; },
    f => { f.link_changes[0].seq = 9; },
    f => { f.link_changes[1].seq = 13; },
    f => { f.link_changes[0].link_id = 'other'; },
    f => { f.link_changes[0].before.quality = .8; },
    f => { f.link_changes[1].before.quality = .8; },
    f => { f.link_changes[1].after.enabled = false; },
    f => { f.link_changes[1].after.latency_ticks = 0; },
    f => { f.link_changes[1].cause = 'unknown'; },
    f => { delete f.link_changes; },
  ]) {
    // Clone through JSON so the end profile and individual transitions are independent records.
    const f = JSON.parse(JSON.stringify(later));
    corrupt(f);
    assert.throws(() => parseArchive(archive([earlier, f], log)));
  }
});

test('archive distinguishes a missing comparison ledger from an observed but undelivered edition', () => {
  const own = { id: 'station', name: '现场节点', type_label: '信息节点', model_label: 'SIM', role: '记录',
    affiliation: 'PLA', side: 'blue', domain: 'ground', connection: 'online', conceptual: true, x: 1, y: 1, readiness: 1 };
  const end = { ...frame(8, 0), units: [own] };
  // A rolling window can retain nonconsecutive editions as its opening state.
  const previous = { source_id: own.id, version: 1, report_id: 'O1', sampled_tick: 0, proposal_id: null, field_received_tick: 0, center_received_tick: 0 };
  const latest = { source_id: own.id, version: 4, report_id: 'O9', sampled_tick: 3, proposal_id: 'P3', field_received_tick: 4, center_received_tick: null };
  assert.deepEqual(parseArchive(archive([end], [], [previous, latest])).report_versions, [previous, latest]);
  for (const invalid of [
    { ...latest, center_received_tick: 9 }, { ...latest, field_received_tick: 2 },
    { ...latest, source_id: 'other' }, { ...latest, report_id: 'O1' }, { ...latest, version: 1, proposal_id: null },
  ]) {
    assert.throws(() => parseArchive(archive([end], [], [previous, invalid])));
  }
});

test('reader rejects malformed DTOs, reversed sequence numbers and premature reports', () => {
  assert.throws(() => parseArchive('{}'));
  assert.throws(() => parseArchive(archive([{ ...frame(4, 1), units: [{}] }], [])));
  assert.throws(() => parseArchive(archive([frame(4, 3)], [event(3, 1), event(2, 2)])));
  assert.throws(() => parseArchive(archive([frame(1, 3), frame(4, 3)], [event(3, 2)])));
  assert.throws(() => parseArchive(archive([frame(4, 2)], [event(3, 2)])));
  const observation = { id: 'O1', unit_id: 'U1', source_id: 'U1', observed_tick: 1, received_tick: 3, confidence: .8, note: 'sample' };
  assert.throws(() => parseArchive(archive([frame(4, 3)], [{ ...event(3, 2), evidence: [observation] }])));
});

const example = readFileSync(new URL('../examples/two-node-replay.json', import.meta.url), 'utf8');

function caseEntries(log) {
  const report = (kind, reportKind) => log.find(e => e.kind === kind && e.desk_report?.kind === reportKind);
  const judgment = (actor, count) => log.find(e => e.kind === 'desk_judged' && e.desk_judgment.actor === actor && e.desk_judgment.read_ids.length === count);
  return {
    relay: report('desk_received', 'relay'), readRelay: report('desk_read', 'relay'),
    supplement: report('desk_received', 'supplement'), readOriginal: report('desk_read', 'supplement'),
    initialRule: judgment('rule', 1), initialHuman: judgment('human', 1),
    finalRule: judgment('rule', 2), finalHuman: judgment('human', 2),
  };
}

test('desk audit keeps received headers, read bodies and cited subsets with their original sequence', () => {
  const parsed = parseArchive(example);
  const c = caseEntries(parsed.decision_log);
  const { id, source_id, root_id } = c.relay.desk_report;
  const original = c.supplement.desk_report.id;
  assert.equal(parsed.desk_review_version, 1);
  assert.equal(c.relay.desk_report.claim, null);
  assert.equal(c.readRelay.desk_report.claim, 'continuous');
  assert.deepEqual(c.initialHuman.desk_judgment.read_ids, [id]);
  assert.deepEqual(c.finalRule.desk_judgment.evidence_ids, [id, original]);
  assert.deepEqual(c.finalHuman.desk_judgment.evidence_ids, [original]);
  assert.deepEqual(c.finalHuman.desk_judgment.read_ids, [id, original]);
  // Old editions and groups can leave the rolling window while a newer group remains protected.
  const recording = JSON.parse(example);
  delete recording.strategy_studies;
  delete recording.receipt_studies;
  const s = recording.snapshot;
  s.history = [{ ...s.history.at(-1), tick: 410 }];
  s.report_versions = s.report_versions.filter(r => r.report_id !== root_id || r.source_id !== source_id);
  assert.equal(parseArchive(JSON.stringify(recording)).desk_review_version, 1);
});

test('desk imports reject future claims, foreign roots, forged receipts, and premature or changed judgments', () => {
  const changes = [
    [/审核席记录版本/, s => { delete s.desk_review_version; }],
    [/审核席记录版本/, s => { s.desk_review_version = 2; }],
    [/决策记录的内容/, (_, c) => { c.relay.desk_report.claim = 'gap'; }],
    [/中心尚未持有/, (s, c) => { c.relay.desk_report.root_id = s.report_versions.find(r => r.source_id !== c.relay.desk_report.source_id).report_id; }],
    [/中心尚未持有/, (_, c) => { c.relay.desk_report.root_sampled_tick++; }],
    [/中心尚未持有/, (s, c) => {
      const root = s.report_versions.find(r => r.report_id === c.relay.desk_report.root_id);
      root.center_received_tick = c.relay.tick;
      root.version = 2;
      root.proposal_id = 'prior-case';
      s.report_versions.find(r => r.report_id === c.supplement.desk_report.id).version = 3;
      // The origin was received one event after the relay, within the same tick.
      const next = c.relay.seq + 1;
      for (const e of s.decision_log) if (e.seq >= next) e.seq++;
      s.decision_log.splice(s.decision_log.indexOf(c.relay) + 1, 0, {
        seq: next, tick: c.relay.tick, kind: 'received', proposal_id: root.proposal_id,
        report_id: root.report_id, sampled_tick: root.sampled_tick,
      });
      for (const f of s.history) if (f.decision_seq >= next) f.decision_seq++;
    }],
    [/来源、采样或送达/, (_, c) => { c.relay.desk_report.source_id = 'foreign'; }],
    [/队列顺序/, (_, c) => { c.readRelay.desk_report.root_id = 'changed'; }],
    [/队列顺序/, (_, c) => { c.readRelay.desk_report.received_tick++; }],
    [/阅读时刻/, (s, c) => {
      for (const e of [c.readRelay, c.initialRule, c.initialHuman]) e.tick = c.relay.tick;
      for (const f of s.history) f.decision_seq = s.decision_log.findLast(e => e.tick <= f.tick).seq;
    }],
    [/冻结的已读清单/, (_, c) => { c.initialRule.desk_judgment.read_ids.push(c.supplement.desk_report.id); }],
    [/引用了未读报告/, (_, c) => { c.initialRule.desk_judgment.evidence_ids = [c.supplement.desk_report.id]; }],
    [/来源、采样或送达/, (_, c) => { c.supplement.desk_report.received_tick--; }],
    [/离线缓存记录/, (_, c) => { c.readOriginal.proposal_id = 'different-case'; }],
    [/冻结结论/, (_, c) => { c.finalRule.desk_judgment.finding = 'continuous'; }],
    [/决策记录的内容/, (_, c) => { c.finalHuman.desk_judgment.evidence_ids.push(c.supplement.desk_report.id); }],
    [/决策记录的内容/, (_, c) => { c.finalHuman.desk_judgment.evidence_ids = []; }],
    [/决策记录的内容/, (_, c) => { c.finalHuman.desk_judgment.actor = 'ai'; }],
    [/规则判断应在/, (_, c) => { c.finalHuman.desk_judgment.actor = 'rule'; }],
    [/队列顺序/, (s, c) => { s.decision_log = s.decision_log.filter(e => e !== c.relay); }],
    [/缺少当时的规则判断/, (s, c) => { s.decision_log = s.decision_log.filter(e => e !== c.finalRule); }],
    [/补报送达事件/, s => { delete s.decision_log.find(e => e.kind === 'received').evidence; }],
    [/采样版本不一致/, (s, c) => {
      s.report_versions.find(r => r.report_id === c.supplement.desk_report.id).proposal_id = 'different-case';
    }],
    [/中心收件台账/, (s, c) => {
      s.decision_log = s.decision_log.filter(e => e.kind !== 'received' && ![c.supplement, c.readOriginal, c.finalRule, c.finalHuman].includes(e));
    }],
  ];
  for (const [reason, change] of changes) {
    const recording = JSON.parse(example);
    const s = recording.snapshot;
    change(s, caseEntries(s.decision_log));
    assert.throws(() => parseArchive(JSON.stringify(recording)), reason, change.toString());
  }
});

test('a local sampling deadline can open a review even when the field has issued nothing', () => {
  const recording = JSON.parse(example);
  delete recording.strategy_studies;
  delete recording.receipt_studies;
  const s = recording.snapshot;
  const { relay } = caseEntries(s.decision_log);
  s.history = s.history.filter(f => f.tick <= relay.tick);
  s.decision_log = s.decision_log.filter(e => e.seq <= relay.seq);
  s.history.at(-1).decision_seq = relay.seq;
  s.report_versions = s.report_versions.filter(r => r.proposal_id !== relay.proposal_id);
  assert.equal(parseArchive(JSON.stringify(recording)).decision_log.at(-1).desk_expectation_seq, relay.desk_expectation_seq);
  const execution = s.decision_log.find(e => e.seq === relay.desk_expectation_seq);
  assert.equal(execution.kind, 'executing');
  relay.desk_expectation_seq--;
  assert.throws(() => parseArchive(JSON.stringify(recording)), /已批准请求/);
  relay.desk_expectation_seq = execution.seq;
  s.decision_log = s.decision_log.filter(e => e.kind !== 'approved');
  assert.throws(() => parseArchive(JSON.stringify(recording)), /已批准请求/);
  delete relay.desk_expectation_seq;
  assert.throws(() => parseArchive(JSON.stringify(recording)), /离线缓存记录/);
});
