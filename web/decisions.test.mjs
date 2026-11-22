import assert from 'node:assert/strict';
import test from 'node:test';
import { eventsAtFrame, rebuildDecisions, latestReportEvents } from './decisions.ts';

const proposal = { id: 'proposal-1', title: '补充报告', rationale: '链路中断', action: 'request_observation', subject_id: 'own-1', evidence_ids: ['obs-1'], uncertainties: [], expected_effect: '获得报告', status: 'pending', created_tick: 4, completed_tick: null, source: 'baseline', outcome: null };
const evidence = { id: 'obs-1', unit_id: 'own-1', source_id: 'own-1', observed_tick: 2, received_tick: 3, confidence: .6, note: '创建时证据' };
const created = { seq: 1, tick: 4, proposal_id: proposal.id, kind: 'created', proposal, evidence: [evidence] };
const approved = { seq: 2, tick: 4, proposal_id: proposal.id, kind: 'approved', actor: 'human', evidence: [{ ...evidence, confidence: .8, note: '审核时证据' }] };

test('same-tick sequence cutoffs exclude later approval and preserve the earlier frozen basis', () => {
  const log = [created, approved, { seq: 3, tick: 5, proposal_id: proposal.id, kind: 'completed', note: '已采样' }];
  const atCreation = rebuildDecisions(eventsAtFrame(log, { tick: 4, decision_seq: 2 }, 1))[0];
  assert.equal(atCreation.proposal.status, 'pending');
  assert.equal(atCreation.evidence[0].note, '创建时证据');
  assert.equal(atCreation.events.length, 1);
  const atApproval = rebuildDecisions(eventsAtFrame(log, { tick: 4, decision_seq: 2 }))[0];
  assert.equal(atApproval.proposal.status, 'approved');
  assert.equal(atApproval.events.at(-1).actor, 'human');
  assert.equal(atApproval.evidence[0].note, '审核时证据');
  assert.equal(atApproval.events[0].evidence[0].note, '创建时证据');
  assert.equal(proposal.status, 'pending', 'reconstruction must not mutate the source archive');
});

test('task completion and actual report arrival are independent, with failure and arrival ticks retained', () => {
  const log = [created, approved,
    { seq: 3, tick: 5, proposal_id: proposal.id, kind: 'completed', note: '采样动作已完成' },
    { seq: 4, tick: 5, proposal_id: proposal.id, kind: 'buffered', report_id: 'report-1', sampled_tick: 5 },
    { seq: 5, tick: 8, proposal_id: proposal.id, kind: 'sent', report_id: 'report-1', sampled_tick: 5 },
    { seq: 6, tick: 9, proposal_id: proposal.id, kind: 'dropped', report_id: 'report-1', sampled_tick: 5 },
    { seq: 7, tick: 11, proposal_id: proposal.id, kind: 'received', report_id: 'report-2', sampled_tick: 7, evidence: [{ ...evidence, id: 'report-2', note: '实际送达正文', observed_tick: 7, received_tick: 11 }] }];
  const beforeArrival = rebuildDecisions(eventsAtFrame(log, { tick: 9, decision_seq: 6 }))[0];
  assert.equal(beforeArrival.proposal.status, 'completed');
  assert.equal(beforeArrival.proposal.completed_tick, 5);
  assert.deepEqual(latestReportEvents(beforeArrival.events).map(event => [event.kind, event.tick]), [['dropped', 9]]);
  const afterArrival = rebuildDecisions(eventsAtFrame(log, { tick: 11, decision_seq: 7 }))[0];
  assert.equal(afterArrival.evidence[0].note, '审核时证据', 'arrived report cannot rewrite earlier decision evidence');
  assert.equal(afterArrival.events.at(-1).evidence[0].note, '实际送达正文');
});

test('legacy frames without sequence metadata cannot expose current or future decision records', () => {
  assert.deepEqual(eventsAtFrame([created, approved], { tick: 100 }), []);
  assert.deepEqual(eventsAtFrame(undefined, { tick: 100, decision_seq: 999 }), []);
  assert.deepEqual(eventsAtFrame([created, approved], { tick: 0, decision_seq: 999 }), []);
  assert.deepEqual(rebuildDecisions(eventsAtFrame([created], { tick: 4, decision_seq: 0 })), []);
});
