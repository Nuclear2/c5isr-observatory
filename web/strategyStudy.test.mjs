import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { strategyAtCursor } from './strategyStudy.ts';

const { strategy_studies: studies } = JSON.parse(readFileSync(new URL('../examples/two-node-replay.json', import.meta.url), 'utf8'));

test('scrubbing back from revealed settlement hides truth, scores and later link changes', () => {
  assert.deepEqual(studies.map(s => s.delivery).sort(), ['delayed', 'lost', 'normal']);
  for (const study of studies) {
    const last = study.frames.length - 1;
    assert.equal(strategyAtCursor(study, last, false).settlement, null);
    assert.equal(strategyAtCursor(study, last, true).settlement, study.settlement);
    for (let index = last - 1; index >= 0; index--) {
      const view = strategyAtCursor(study, index, true);
      assert.equal(view.settlement, null);
      assert.deepEqual(view.links, study.link_events.filter(l => l.tick <= view.frame.tick));
    }
  }
});

test('paired playback distinguishes an unread counter report, a cited reading and a missing response', () => {
  for (const study of studies) {
    const fork = strategyAtCursor(study, 0, false).frame;
    assert.deepEqual(fork.immediate.reports, fork.verify.reports);
    const counter = study.frames.at(-1).verify.reports.find(r => r.kind === 'verification');
    if (study.delivery === 'lost') {
      assert.equal(counter, undefined);
      assert.ok(study.frames.every(f => f.verify.decisions.every(d => d.action === 'request_verification')));
      continue;
    }
    assert.ok(counter.received_tick < counter.read_tick);
    for (const [index, stored] of study.frames.entries()) {
      const { frame } = strategyAtCursor(study, index, false);
      const envelope = frame.verify.reports.find(r => r.kind === 'verification');
      const decision = frame.verify.decisions.find(d => d.action === 'conclude');
      if (stored.tick < counter.received_tick) assert.equal(envelope, undefined);
      else if (stored.tick < counter.read_tick) {
        assert.equal(envelope.read_tick, null);
        assert.equal(envelope.claim, null);
        assert.equal(decision, undefined);
      } else {
        assert.deepEqual(decision.read_ids, frame.verify.reports.map(r => r.id));
        assert.deepEqual(decision.evidence_ids, [counter.id]);
      }
    }
  }
});
