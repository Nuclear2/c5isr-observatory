import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArchiveData } from './archive.ts';
import { parseReceiptAttachments, parseReceiptStudy } from './receiptArchive.ts';

const example = JSON.parse(readFileSync(new URL('../examples/two-node-replay.json', import.meta.url), 'utf8'));
const { history, decision_log: log } = example.snapshot;
const studies = example.receipt_studies;
const delivered = studies.find(s => s.delivery === 'delivered');
const lost = studies.find(s => s.delivery === 'lost');

test('each recorded centre knows only what its inbox proves at the selected tick', () => {
  assert.deepEqual(parseArchiveData(example).receipt_studies, studies);
  const legacy = structuredClone(example);
  delete legacy.receipt_studies;
  assert.equal(parseArchiveData(legacy).receipt_studies, undefined);
  for (const s of studies) {
    assert.deepEqual(parseReceiptStudy(s), s);
    for (const f of s.frames) {
      if (s.delivery === 'lost' || f.tick < 9) {
        assert.deepEqual(f.buffered, f.not_sampled);
        assert.equal(f.buffered.knowledge, null);
        assert.deepEqual(f.buffered.receipts, []);
      } else {
        for (const [key, status] of [['buffered', 'sampled_buffered'], ['not_sampled', 'not_sampled']]) {
          const { receipts, knowledge } = f[key];
          assert.deepEqual(knowledge, { status, as_of_tick: 3, known_tick: 9, receipt_id: receipts[0].id });
          assert.equal(receipts[0].id, s.field_audit[key].receipt_id);
          assert.equal(receipts[0].source_id, s.source_id);
        }
      }
    }
  }
});

test('standalone imports reject future knowledge, leaked field data and misleading citations', () => {
  for (const change of [
    s => s.frames[3].buffered.knowledge = s.frames.at(-1).buffered.knowledge,
    s => s.frames[3].not_sampled.expected_tick = null,
    s => s.frames[3].buffered.extra = 'buffered',
    s => s.frames[8].not_sampled.receipts = s.frames.at(-1).not_sampled.receipts,
    s => s.frames.at(-1).buffered.knowledge.receipt_id = s.field_audit.not_sampled.receipt_id,
    s => s.frames.at(-1).not_sampled.knowledge.as_of_tick = 9,
    s => { for (const a of Object.values(s.field_audit)) a.received_tick = 8; },
    s => s.field_audit.not_sampled.sampled_tick = 3,
    s => s.frames[3].not_sampled.link_enabled = true,
  ]) {
    const s = structuredClone(delivered);
    change(s);
    assert.throws(() => parseReceiptStudy(s), /知情对照/);
  }
  const forged = structuredClone(lost);
  forged.frames.at(-1).not_sampled.knowledge = delivered.frames.at(-1).not_sampled.knowledge;
  assert.throws(() => parseReceiptStudy(forged), /知情对照/);
});

test('parent anchors fix the complete outage, execution, recovery and actual receipt evidence', () => {
  const clipped = structuredClone(lost);
  clipped.start_tick++;
  clipped.frames.shift();
  assert.throws(() => parseReceiptAttachments([clipped], log, history), /起始步/);
  const wrong = structuredClone(delivered);
  wrong.frames[4].buffered.link_enabled = wrong.frames[4].not_sampled.link_enabled = true;
  assert.throws(() => parseReceiptAttachments([wrong], log, history), /中心链路/);
  const truncated = history.slice(1);
  assert.throws(() => parseReceiptAttachments(studies, log, truncated), /保留范围/);
  const noRecovery = structuredClone(history);
  noRecovery[6].link_changes = [];
  assert.throws(() => parseReceiptAttachments(studies, log, noRecovery), /恢复/);
  const forged = structuredClone(log);
  forged.find(e => e.kind === 'received' && e.proposal_id === delivered.case_id).evidence[0].source_id = 'unrelated';
  assert.throws(() => parseReceiptAttachments(studies, forged, history), /最后到达/);
  assert.throws(() => parseReceiptAttachments([lost, lost], log, history), /重复/);
});

test('later same-tick link changes cannot rewrite the last observation at arrival', () => {
  const changed = structuredClone(history);
  const last = changed.find(f => f.tick === delivered.end_tick);
  const link = last.links.find(l => l.from === delivered.source_id && l.to === 'command');
  const extra = structuredClone(history[0].link_changes.find(c => c.link_id === link.id));
  extra.seq = last.decision_seq + 1;
  last.link_changes.push(extra);
  link.enabled = false;
  assert.deepEqual(parseReceiptAttachments(studies, log, changed), studies);
});
