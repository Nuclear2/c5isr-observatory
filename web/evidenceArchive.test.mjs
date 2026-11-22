import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_LAB_ARCHIVE_BYTES, parseEvidenceArchive, parseEvidenceArchiveData } from './evidenceArchive.ts';

const sample = readFileSync(new URL('../examples/evidence-review.json', import.meta.url), 'utf8');
const fresh = () => JSON.parse(sample);
function rejects(change) {
  const file = fresh();
  change(file);
  assert.throws(() => parseEvidenceArchiveData(file));
}

test('both import paths accept the bundled complete paired archive across JSON property order', () => {
  const file = fresh();
  assert.deepEqual(parseEvidenceArchive(sample), file);
  file.review.frames = file.review.frames.map(f => Object.fromEntries(Object.entries(f).reverse()));
  assert.deepEqual(parseEvidenceArchiveData(file), file);
  const noExtras = fresh();
  delete noExtras.batch;
  delete noExtras.advice;
  delete noExtras.config.cited_ids;
  delete noExtras.config.fork_tick;
  assert.deepEqual(parseEvidenceArchiveData(noExtras), noExtras);
});

test('invalid format, byte size, config, or timeline do not import', () => {
  assert.throws(() => parseEvidenceArchive('{'));
  assert.throws(() => parseEvidenceArchive('汉'.repeat(Math.ceil(MAX_LAB_ARCHIVE_BYTES / 3))), /8 MiB/);
  rejects(a => { a.schema_version++; });
  rejects(a => { a.config.seed = 2 ** 32; });
  rejects(a => { a.config.read_interval = 0; });
  rejects(a => { a.config.fork_tick = a.fork_tick + 1; });
  rejects(a => { a.config.cited_ids = []; });
  rejects(a => { a.end_tick--; });
  rejects(a => { a.review.frames.pop(); });
});

test('historical frames contain only arrived reports, known read times, effective roots and present metrics', () => {
  rejects(a => { a.immediate.frames[0].reports = a.immediate.frames[3].reports; });
  rejects(a => { a.immediate.frames[6].reports[2].read_tick = 9; });
  rejects(a => { a.review.frames[6].queue_ids = []; });
  rejects(a => { a.immediate.frames[17].metrics.corrected_approvals = 1; });
  rejects(a => { a.review.frames[11].conflict = false; });
  rejects(a => { a.review.frames[12].active_ids.push('R2'); });
  rejects(a => { a.immediate.frames[6].independent_roots.push('R2'); });
  rejects(a => { a.immediate.frames[48].reports[3].read_tick--; });
  rejects(a => { a.immediate.metrics.conflict_ticks++; });
});

test('approvals freeze actor, read set, exact citations and independent sources at their approval tick', () => {
  rejects(a => { a.immediate.frames[6].decisions[0].evidence_ids = ['R3']; });
  rejects(a => { a.immediate.frames[18].decisions[0].read_ids.push('R4'); });
  rejects(a => { a.review.frames[6].decisions[0].actor = 'human'; });
  rejects(a => { a.immediate.frames[8].decisions[0].independent_roots.push('R2'); });
  rejects(a => { a.immediate.frames[6].decisions[0].claim = 'interrupted'; });
  rejects(a => { a.immediate.frames[6].decisions[0].tick++; });
  const file = fresh();
  file.config.cited_ids = ['R2'];
  for (const f of file.immediate.frames.slice(file.fork_tick)) {
    f.decisions[0].actor = 'human';
    f.decisions[0].evidence_ids = ['R2'];
  }
  assert.deepEqual(parseEvidenceArchiveData(file), file);
  rejects(a => { a.config.cited_ids = ['R1', 'R1']; });
});

test('the paired record must share the external tape and the entire pre-fork prefix', () => {
  rejects(a => { a.review.frames[2].reports[0].note += '备注'; });
  rejects(a => {
    for (const f of a.review.frames) {
      for (const r of f.reports) if (r.id === 'R3') r.note += '更换版本';
    }
  });
  rejects(a => { a.review.frames[48].reports[1].root_id = 'R2'; });
  rejects(a => { a.review.frames[48].reports.find(r => r.id === 'R5').received_tick = a.fork_tick; });
});

test('batch rows use contiguous bounded seeds, valid event counts and the first baseline pair', () => {
  rejects(a => { a.batch = []; });
  rejects(a => { a.batch = Array(33).fill(a.batch[0]); });
  rejects(a => { a.batch[1].seed++; });
  rejects(a => { a.batch[2].immediate.corrected_approvals = -1; });
  rejects(a => { a.batch[3].review.corrected_approvals = 1; });
  rejects(a => { a.batch[3].review.review_requests = 0; });
  rejects(a => { a.batch[3].immediate.conflict_ticks = 7; });
  rejects(a => { a.batch[3].review.conflict_ticks = a.batch[3].immediate.conflict_ticks + 3; });
  rejects(a => { a.batch[0].immediate.conflict_ticks++; });
  rejects(a => { a.config.seed = 0xffffffff; a.batch[0].seed = a.config.seed; a.batch[1].seed = a.config.seed + 1; });
});

test('recorded model advice cites the identified branch and exact read set; a wrong model estimate may be preserved', () => {
  const advice = {
    provider: 'codex', branch: 'immediate', tick: 6, read_ids: ['R1', 'R2'], action: 'hold',
    evidence_ids: ['R1', 'R2'], source_count: 2, verified_source_count: 1, reason: '待核对转述。',
    uncertainties: ['原始计数尚未收到。'],
  };
  const file = fresh();
  file.advice = [advice, { ...advice }];
  assert.deepEqual(parseEvidenceArchiveData(file), file);
  for (const bad of [
    { tick: 0 }, { action: 'approve' }, { provider: 'baseline' }, { read_ids: ['R1'] }, { evidence_ids: [] },
    { evidence_ids: ['R3'] }, { evidence_ids: ['R2', 'R2'] }, { source_count: 3 }, { verified_source_count: 2 },
    { reason: ' ' }, { uncertainties: ['🙂'.repeat(301)] },
  ]) rejects(a => { a.advice = [{ ...advice, ...bad }]; });
  rejects(a => { a.advice = Array(257).fill(advice); });
});
