import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let child, base;
before(async () => {
  child = spawn(path.join(root, 'target', 'debug', `c5isr-server${process.platform === 'win32' ? '.exe' : ''}`), [], {
    cwd: root, windowsHide: true, env: { ...process.env, C5ISR_PORT: '0', C5ISR_DISABLE_MODEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server readiness timeout')), 15_000);
    child.once('error', err => { clearTimeout(timeout); reject(err); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)); });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
});
after(() => { child?.kill(); });

async function get(route) {
  const response = await fetch(base + route);
  assert.equal(response.status, 200);
  return response.json();
}
async function post(route, body, status = 200) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test('serves compiled frontend and a coherent initial contract', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/);
  const state = await get('/api/state');
  assert.equal(state.tick, 0);
  assert.equal(state.running, false);
  assert.equal(state.units.length, 8);
  assert.ok(state.units.every(u => u.side === 'blue'));
  assert.ok(state.history.every(frame => frame.units.every(u => u.side === 'blue')));
  assert.equal(state.perception.active_contacts, 0);
  assert.equal(state.perception.cycle_ticks, 8);
  assert.equal(state.automation.mode, 'manual');
  assert.equal(state.automation.interval_seconds, 60);
  assert.ok(state.observations.length > 0);
  assert.ok(state.proposals.some(p => p.status === 'pending'));
  assert.equal(state.model.available, false);
  assert.ok(state.units.every(u => u.x >= 0 && u.x <= 100));
});

test('SSE immediately supplies a typed state event', async () => {
  const abort = new AbortController();
  const response = await fetch(base + '/api/events', { signal: abort.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  try {
    let text = '';
    while (!text.includes('\n\n')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /event: state/);
    assert.equal(JSON.parse(text.match(/data: (.+)/)[1]).schema_version, 1);
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
});

test('approval, simulation advance, feedback and export form a complete loop', async () => {
  await post('/api/control', { action: 'reset', value: 777 });
  const initial = await get('/api/state');
  const proposal = initial.proposals.find(p => p.action === 'restore_link');
  assert.ok(proposal);
  await post('/api/control', { action: 'step' });
  let state = await get('/api/state');
  assert.equal(state.metrics.completed_tasks, 0);
  await post(`/api/proposals/${proposal.id}/review`, { approve: true });
  await post(`/api/proposals/${proposal.id}/review`, { approve: true }, 400);
  for (let i = 0; i < 4; i++) state = await post('/api/control', { action: 'step' });
  const completed = state.proposals.find(p => p.id === proposal.id);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.outcome);
  assert.ok(state.links.find(l => l.id === proposal.subject_id).quality > initial.links.find(l => l.id === proposal.subject_id).quality);
  const archive = await get('/api/export');
  assert.equal(archive.snapshot.tick, state.tick);
  assert.ok(archive.journal.some(e => e.kind === 'review'));
  assert.ok(archive.snapshot.history.length > 1);
});

test('fault injection changes state and recover clears the outage', async () => {
  const fault = await post('/api/inject', { kind: 'link_loss' });
  assert.ok(fault.links.some(l => !l.enabled));
  const recovery = await post('/api/inject', { kind: 'recover' });
  assert.ok(recovery.links.every(l => l.enabled));
  await post('/api/inject', { kind: 'unsupported' }, 400);
  await post('/api/control', { action: 'speed', value: 99 }, 400);
  await post('/api/model/analyze', {}, 503);
});

test('play/pause uses the server clock and single-step refuses to race it', async () => {
  const start = await post('/api/control', { action: 'play' });
  await post('/api/control', { action: 'step' }, 400);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const pause = await post('/api/control', { action: 'pause' });
  assert.ok(pause.tick > start.tick);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await get('/api/state')).tick, pause.tick);
});

test('rejects cross-origin writes and unknown API paths', async () => {
  const crossOrigin = await fetch(base + '/api/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{"action":"play"}',
  });
  assert.equal(crossOrigin.status, 403);
  const unknown = await fetch(base + '/api/missing');
  assert.equal(unknown.status, 404);
});

test('own-side view discovers dynamic contacts only after reports and archives expired contacts', async () => {
  let state = await post('/api/control', { action: 'reset', value: 20261022 });
  assert.ok(!JSON.stringify(state).includes('us-f35'));
  await post('/api/control', { action: 'observation_cycle', value: 32 });
  for (let i = 0; i < 31; i++) state = await post('/api/control', { action: 'step' });
  assert.equal(state.perception.total_discovered, 0);
  assert.ok(state.units.every(unit => unit.side === 'blue'));
  state = await post('/api/control', { action: 'observation_cycle', value: 4 });
  assert.equal(state.perception.next_scan_tick, state.tick + 4);
  await post('/api/control', { action: 'observation_cycle', value: 5 }, 400);
  const firstSeen = new Map();
  for (let i = 0; i < 130; i++) {
    state = await post('/api/control', { action: 'step' });
    for (const unit of state.units.filter(unit => unit.side === 'red')) {
      assert.ok(unit.contact);
      assert.ok(unit.contact.last_seen_tick <= state.tick);
      assert.ok(unit.contact.expires_tick > state.tick);
      if (!firstSeen.has(unit.id)) {
        firstSeen.set(unit.id, state.tick);
        assert.ok(state.history.filter(frame => frame.tick < state.tick).every(frame => !frame.units.some(old => old.id === unit.id)));
        assert.ok(state.events.some(event => event.kind === 'contact_discovered' && event.related_id === unit.id));
      }
    }
  }
  assert.ok(firstSeen.size > 1);
  assert.ok(state.perception.total_archived > 0);
  assert.ok([...firstSeen.keys()].some(id => !state.units.some(unit => unit.id === id)));
  const archive = await get('/api/export');
  assert.equal(archive.scenario_version, 'archipelago-2-own-view');
  assert.equal(archive.snapshot.perception.total_archived, state.perception.total_archived);
  assert.ok(!('hidden_units' in archive.snapshot));
});

test('unavailable AI never silently starts a rule-only automatic mode and manual stop pauses', async () => {
  await post('/api/automation', { mode: 'ai' }, 503);
  assert.equal((await get('/api/state')).automation.mode, 'manual');
  await post('/api/automation', { mode: 'unsupported' }, 400);
  await post('/api/control', { action: 'play' });
  const stopped = await post('/api/automation', { mode: 'manual' });
  assert.equal(stopped.running, false);
  assert.equal(stopped.automation.mode, 'manual');
  assert.equal(stopped.automation.next_run_in_seconds, null);
});
