import assert from 'node:assert/strict';
import test from 'node:test';
import { reportMilestones, reportSeriesAtFrame } from './reportComparison.ts';

const unit = id => ({ id, side: 'blue' });
const version = (v, sampled, field, center, source = 'local') => ({
  source_id: source, version: v, sampled_tick: sampled,
  report_id: `${source}-${v}`, proposal_id: v > 1 ? `p-${v}` : null,
  field_received_tick: field, center_received_tick: center,
});
const frame = (tick, enabled = true, decision_seq = 20) => ({
  tick, decision_seq, units: [unit('local'), unit('peer'), { id: 'other', side: 'red' }],
  links: [{ from: 'local', to: 'command', enabled }],
});
const ledger = [version(1, 0, 0, 0), version(2, 3, 4, 9), version(3, 11, 12, 14), version(1, 0, 0, 0, 'peer')];

test('each recipient sees only the versions and receipts known at frame end', () => {
  for (const [tick, field, center] of [[0, 1, 1], [3, 1, 1], [4, 2, 1], [8, 2, 1], [9, 2, 2]]) {
    const [series] = reportSeriesAtFrame(ledger, frame(tick, tick >= 6));
    assert.equal(series.source_id, 'local');
    assert.equal(series.field.version, field);
    assert.equal(series.center.version, center);
    assert.ok(series.versions.every(row => row.sampled_tick <= tick));
    assert.ok(series.versions.every(row => [row.field_received_tick, row.center_received_tick].every(t => t === null || t <= tick)));
  }
  assert.equal(ledger[1].center_received_tick, 9, 'scrubbing must not edit the archive');
  assert.equal(reportSeriesAtFrame([version(2, 0, 2, 4, 'other')], frame(12)).length, 0);
});

test('a late older receipt is visible for that version without replacing the held edition', () => {
  const late = [version(1, 0, 0, 0), version(2, 3, 4, 12), version(3, 7, 8, 10)];
  for (const tick of [10, 11, 12, 13]) {
    const [series] = reportSeriesAtFrame(late, frame(tick));
    assert.equal(series.center.version, 3);
    assert.equal(series.versions.find(v => v.version === 2).center_received_tick, tick >= 12 ? 12 : null);
  }
});

test('transport distinguishes confirmed arrivals from reconnection, send, and window-start offline state', () => {
  const rows = [frame(2, false), frame(3, false), frame(4, false), frame(5, false), frame(6, true, 7), frame(9, true)];
  const report = ledger[1];
  const logged = (kind, tick, seq) => ({ kind, tick, seq, report_id: 'local-2', proposal_id: 'p-2' });
  const events = [logged('buffered', 3, 5), logged('sent', 6, 8), logged('received', 9, 9)];
  const beforeSent = reportMilestones(report, rows[4], rows, events);
  assert.deepEqual(beforeSent.map(step => [step.kind, step.tick]), [
    ['offline_at_start', 2], ['sample', 3], ['buffered', 3], ['field', 4], ['restored', 6],
  ]);
  assert.ok(!beforeSent.some(step => step.kind === 'sent' || step.kind === 'center'));
  assert.deepEqual(reportMilestones(report, rows[5], rows, events).slice(-2), [{ kind: 'sent', tick: 6 }, { kind: 'center', tick: 9 }]);
});

test('unreceived terminal versions preserve previous center holdings and never gain a receipt', () => {
  const current = version(2, 3, 4, null);
  const history = [frame(8)];
  const [series] = reportSeriesAtFrame([ledger[0], current], history[0]);
  assert.equal(series.center.version, 1);
  const drop = { kind: 'dropped', tick: 5, seq: 10, report_id: current.report_id, proposal_id: current.proposal_id };
  const milestones = reportMilestones(current, history[0], history, [drop]);
  assert.ok(milestones.some(e => e.kind === 'dropped'));
  assert.ok(!milestones.some(e => e.kind === 'center'));
});
