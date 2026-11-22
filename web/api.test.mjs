import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from './api.ts';

test('a timed-out stop HTTP attempt is aborted and a separate retry can still confirm success', async t => {
  let attempts = 0;
  let timedOutSignal;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/automation');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { mode: 'manual' });
    if (++attempts === 1) {
      timedOutSignal = options.signal;
      return await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }
    return Response.json({ running: false, automation: { mode: 'manual' } });
  });
  await assert.rejects(request('/api/automation', { mode: 'manual' }, { timeoutMs: 10 }), /尚未收到服务端确认/);
  assert.equal(timedOutSignal.aborted, true);
  const response = await request('/api/automation', { mode: 'manual' }, { timeoutMs: 100 });
  assert.equal(response.running, false);
  assert.equal(attempts, 2);
});
