import assert from 'node:assert/strict';
import test from 'node:test';
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
