import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { eventsAtFrame, rebuildDecisions } from './decisions.ts';
import { reviewCases } from './liveReviewDesk.ts';

const { snapshot } = JSON.parse(readFileSync(new URL('../examples/two-node-replay.json', import.meta.url), 'utf8'));
const log = snapshot.decision_log;
const desksAt = (tick, cursor) => reviewCases(eventsAtFrame(log, snapshot.history.find(f => f.tick === tick), cursor));
const received = log.filter(e => e.kind === 'desk_received');
const readings = log.filter(e => e.kind === 'desk_read');
const [relay, supplement] = received.map(e => e.desk_report);

test('the desk knows only what was received, then read, by the selected event', () => {
  assert.deepEqual(desksAt(received[0].tick, received[0].seq - 1), []);
  const [beforeReading] = desksAt(readings[0].tick, readings[0].seq - 1);
  assert.equal(beforeReading.entries[0].readTick, null);
  assert.equal(beforeReading.entries[0].report.claim, null);
  const [afterReading] = desksAt(readings[0].tick, readings[0].seq);
  assert.equal(afterReading.entries[0].readSeq, readings[0].seq);
  assert.equal(afterReading.entries[0].report.claim, 'continuous');
  assert.equal(afterReading.judgments.length, 0);
  assert.ok(relay.root_sampled_tick < relay.sampled_tick);
  assert.equal(relay.sampled_tick, supplement.sampled_tick);
  assert.equal(desksAt(received[1].tick, received[1].seq - 1)[0].entries.length, 1);
  const [waiting] = desksAt(received[1].tick);
  assert.deepEqual(waiting.entries.map(e => [e.report.received_tick, e.readTick, e.report.claim]),
    [[3, 6, 'continuous'], [9, null, null]]);
  assert.equal(waiting.lastReadSeq, readings[0].seq);
  const [bothRead] = desksAt(readings[1].tick, readings[1].seq);
  assert.equal(bothRead.lastReadSeq, readings[1].seq);
  assert.equal(bothRead.entries[1].report.claim, 'gap');
  assert.ok(bothRead.judgments.every(j => j.tick < readings[1].tick));
});

test('reopening a judgment at the last frame preserves its scope and its cited editions', () => {
  const [finished] = desksAt(12);
  const [firstRule, firstHuman, secondRule, secondHuman] = finished.judgments;
  assert.equal(firstRule.judgment.actor, 'rule');
  assert.deepEqual(firstHuman.read.map(e => [e.report.id, e.report.root_id, e.readTick]), [[relay.id, relay.root_id, 6]]);
  assert.deepEqual(firstHuman.judgment.evidence_ids, [relay.id]);
  assert.equal(secondRule.judgment.finding, 'conflict');
  assert.deepEqual(secondRule.judgment.evidence_ids, [relay.id, supplement.id]);
  assert.equal(secondHuman.judgment.actor, 'human');
  assert.equal(secondHuman.judgment.finding, 'gap');
  assert.deepEqual(secondHuman.read.map(e => [e.report.id, e.report.claim]), [[relay.id, 'continuous'], [supplement.id, 'gap']]);
  assert.deepEqual(secondHuman.judgment.evidence_ids, [supplement.id]);
  const [earlier] = desksAt(firstHuman.tick, firstHuman.seq);
  assert.deepEqual(earlier.judgments, [firstRule, firstHuman]);
  assert.equal(earlier.entries.length, 1);
  assert.equal(received[1].desk_report.claim, null, 'later readings do not mutate the receipt');
});

test('transport history stays within the case, and desk judgments stay out of proposal approvals', () => {
  const caseId = received[0].proposal_id;
  const otherCase = { ...received[0], proposal_id: 'another-case', desk_report: { ...relay, id: 'another-relay' } };
  const events = [received[0], readings[0], otherCase, { proposal_id: caseId, kind: 'expired', tick: 40 }];
  const [other, original] = reviewCases(events);
  assert.equal(other.id, 'another-case');
  assert.equal(other.transport, undefined);
  assert.equal(other.entries[0].readSeq, null);
  assert.equal(original.transport.kind, 'expired');
  assert.deepEqual(original.entries.map(e => e.report.id), [relay.id]);
  assert.deepEqual(reviewCases(eventsAtFrame(log, { tick: 12 })), []);
  const proposal = rebuildDecisions(log).find(record => record.proposal.id === caseId);
  assert.equal(proposal.proposal.status, 'completed');
  assert.equal(proposal.events.filter(e => e.kind === 'approved').length, 1);
  assert.ok(proposal.events.every(e => !e.kind.startsWith('desk_')));
});
