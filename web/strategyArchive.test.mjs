import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArchiveData } from './archive.ts';
import { parseStrategyStudy } from './strategyArchive.ts';

const example = JSON.parse(readFileSync(new URL('../examples/two-node-replay.json', import.meta.url), 'utf8'));
const studies = example.strategy_studies;
const normal = studies.find(s => s.delivery === 'normal' && s.material === 'complete');
const lost = studies.find(s => s.delivery === 'lost');
const partial = studies.find(s => s.material === 'partial');
const replica = studies.find(s => s.material === 'copy');

test('all five saved comparisons can be imported standalone or with their actual parent conflict', () => {
  assert.deepEqual(studies.map(s => s.delivery + '/' + s.material).sort(),
    ['delayed/complete', 'lost/complete', 'normal/complete', 'normal/copy', 'normal/partial']);
  assert.deepEqual(parseArchiveData(example).strategy_studies, studies);
  for (const study of example.strategy_studies) assert.deepEqual(parseStrategyStudy(study), study);
  const legacy = structuredClone(example);
  delete legacy.strategy_studies;
  assert.equal(parseArchiveData(legacy).strategy_studies, undefined);
  const clipped = structuredClone(example);
  clipped.snapshot.history.shift();
  assert.deepEqual(parseArchiveData(clipped).strategy_studies, example.strategy_studies,
    'an already-recorded attachment retains its original outage after the parent window rolls');
});

test('0.1.4 comparison with an aggregate counter finding still imports without invented slot data', () => {
  const parent = structuredClone(example);
  const old = structuredClone(normal);
  parent.strategy_studies = [old];
  old.schema_version = 1;
  delete old.material;
  delete old.settlement.field_record.slots;
  delete old.settlement.immediate.unresolved_reason;
  delete old.settlement.verify.unresolved_reason;
  for (const f of old.frames) {
    const receipt = f.verify.reports[2];
    if (!receipt) continue;
    delete receipt.coverage;
    receipt.root_id = 'field-pla-kj700-3';
    receipt.source_id = 'counter-pla-kj700';
  }
  assert.deepEqual(parseStrategyStudy(old), old);
  assert.deepEqual(parseArchiveData(parent).strategy_studies, [old]);
  assert.equal('slots' in old.settlement.field_record, false);
  assert.equal('coverage' in old.frames.at(-1).verify.reports[2], false);
});

test('replay import refuses early knowledge, revised citations and invented scores', () => {
  for (const alter of [
    s => { s.frames[0].verify.settlement = s.settlement; },
    s => { s.frames[1].immediate.decisions[0].evidence_ids.push('later-report'); },
    s => { s.frames[3].verify.reports[2].claim = 'continuous'; },
    s => { s.frames[2].verify.reports.push(s.frames[3].verify.reports[2]); },
    s => { s.frames[8].verify.decisions.pop(); },
    s => { s.settlement.verify.wait_ticks--; },
    s => { s.settlement.field_record.recorded_samples--; },
    s => { s.link_events.push({ tick: 14, seq: null, enabled: false, origin: 'scenario' }); },
  ]) {
    const copy = structuredClone(normal);
    alter(copy);
    assert.throws(() => parseStrategyStudy(copy), /策略对照/);
  }
  const copy = structuredClone(lost);
  copy.settlement.verify.wait_ticks = 0;
  assert.throws(() => parseStrategyStudy(copy), /等待步数/);
});

test('attachments must trace back to the same conflict, source reports and fault switches', () => {
  for (const alter of [
    s => { s.fork_seq++; },
    s => { s.case_id = 'unrelated'; },
    s => { for (const f of s.frames) for (const b of [f.immediate, f.verify]) b.reports[0].root_id = 'another-original'; },
    s => { s.link_events[0].seq--; },
  ]) {
    const copy = structuredClone(example);
    alter(copy.strategy_studies[0]);
    assert.throws(() => parseArchiveData(copy), /策略对照/);
  }
  const copy = structuredClone(example);
  copy.strategy_studies.push(copy.strategy_studies[0]);
  assert.throws(() => parseArchiveData(copy), /条件重复/);
  const mismatched = structuredClone(example);
  const noReply = mismatched.strategy_studies.find(s => s.delivery === 'lost');
  noReply.settlement.field_record.recorded_samples--;
  noReply.settlement.field_record.slots[3] = false;
  noReply.settlement.field_record.finding = 'gap';
  noReply.settlement.immediate.wrong = 0;
  parseStrategyStudy(noReply);
  assert.throws(() => parseArchiveData(mismatched), /现场底稿不一致/);
  const differingHistory = structuredClone(example);
  differingHistory.snapshot.history.shift();
  const other = differingHistory.strategy_studies.find(s => s.material === 'copy');
  other.link_events[0].seq--;
  parseStrategyStudy(other);
  assert.throws(() => parseArchiveData(differingHistory), /共同故障时间线不一致/);
});

test('unread return cannot reveal the material, its roots, or its coverage', () => {
  for (const study of [normal, replica, partial]) {
    const arrived = study.frames.find(f => f.tick === 15).verify.reports[2];
    assert.equal(arrived.read_tick, null);
    assert.equal(arrived.root_id, null);
    assert.equal(Object.hasOwn(arrived, 'coverage'), false);
    for (const change of [
      (r, final) => { r.root_id = final.root_id; },
      (r, final) => { r.coverage = final.coverage; },
      (r, final) => { r.source_id = final.source_id; },
    ]) {
      const altered = structuredClone(study);
      change(altered.frames[3].verify.reports[2], altered.frames.at(-1).verify.reports[2]);
      assert.throws(() => parseStrategyStudy(altered), /T\+15/);
    }
  }
});

test('a copied source, partial reading, and unreceived return carry distinct bases and cannot be interchanged', () => {
  for (const [study, mutate] of [
    [replica, r => { r.root_id = normal.frames.at(-1).verify.reports[2].root_id; }],
    [replica, r => { r.coverage[1].present = true; }],
    [partial, r => { r.coverage.push({ slot: 4, present: true }); }],
    [partial, r => { r.coverage[2].slot = 4; }],
    [partial, r => { r.claim = 'continuous'; }],
    [normal, r => { r.coverage[3].present = false; }],
  ]) {
    const altered = structuredClone(study);
    for (const f of altered.frames.filter(f => f.tick >= 18)) mutate(f.verify.reports[2]);
    assert.throws(() => parseStrategyStudy(altered), /策略对照/);
  }
  for (const study of [replica, partial]) {
    const altered = structuredClone(study);
    for (const f of altered.frames.filter(f => f.tick >= 18)) f.verify.decisions[1].evidence_ids = [f.verify.reports[0].id];
    assert.throws(() => parseStrategyStudy(altered), /T\+18/);
    const confused = structuredClone(study);
    confused.settlement.verify.unresolved_reason = 'not_received';
    assert.throws(() => parseStrategyStudy(confused), /未决/);
  }
  const confused = structuredClone(lost);
  confused.settlement.verify.unresolved_reason = 'partial_coverage';
  assert.throws(() => parseStrategyStudy(confused), /未决/);
});

test('a missing sample observed within partial coverage is sufficient to establish a gap', () => {
  const study = structuredClone(partial);
  const field = study.settlement.field_record;
  field.slots[1] = false;
  field.recorded_samples = 3;
  field.finding = 'gap';
  for (const frame of study.frames.filter(f => f.tick >= 18)) {
    const report = frame.verify.reports[2];
    report.coverage[1].present = false;
    report.claim = 'gap';
    Object.assign(frame.verify.decisions[1], { action: 'conclude', finding: 'gap' });
  }
  study.settlement.immediate.wrong = 0;
  Object.assign(study.settlement.verify, { unresolved: 0, unresolved_reason: null, decision_tick: 18, wait_ticks: 6 });
  assert.deepEqual(parseStrategyStudy(study), study);
});
