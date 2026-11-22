import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArchiveData } from './archive.ts';
import { parseStrategyStudy } from './strategyArchive.ts';

const example = JSON.parse(readFileSync(new URL('../examples/two-node-replay.json', import.meta.url), 'utf8'));
const [normal, delayed, lost] = example.strategy_studies;

test('all three saved branches can be imported standalone or with their actual parent conflict', () => {
  assert.deepEqual(parseArchiveData(example).strategy_studies, [normal, delayed, lost]);
  for (const study of example.strategy_studies) assert.deepEqual(parseStrategyStudy(study), study);
  const legacy = structuredClone(example);
  delete legacy.strategy_studies;
  assert.equal(parseArchiveData(legacy).strategy_studies, undefined);
  const clipped = structuredClone(example);
  clipped.snapshot.history.shift();
  assert.deepEqual(parseArchiveData(clipped).strategy_studies, example.strategy_studies,
    'an already-recorded attachment retains its original outage after the parent window rolls');
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
  noReply.settlement.field_record.finding = 'gap';
  noReply.settlement.immediate.wrong = 0;
  parseStrategyStudy(noReply);
  assert.throws(() => parseArchiveData(mismatched), /现场底稿不一致/);
});
