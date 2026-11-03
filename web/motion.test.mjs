import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveMotion, projectedMotionVector } from './motion.ts';

const own = (x, y) => ({ id: 'own', side: 'blue', x, y });
const contact = (x, y, lastSeen, firstSeen = 2) => ({ id: 'contact', side: 'red', x, y, contact: { first_seen_tick: firstSeen, last_seen_tick: lastSeen, expires_tick: lastSeen + 48 } });
const frame = (tick, ...units) => ({ tick, units });

test('own-node difference uses elapsed ticks and north-clockwise headings', () => {
  const history = [frame(2, own(10, 10))];
  const north = deriveMotion('own', frame(4, own(10, 6)), history);
  assert.equal(north.kind, 'known');
  assert.equal(north.speed, 2);
  assert.equal(north.heading, 0);
  for (const [x, y, expected] of [[14, 10, 90], [10, 14, 180], [6, 10, 270]]) {
    assert.equal(deriveMotion('own', frame(4, own(x, y)), history).heading, expected);
  }
});

test('contact difference ignores repeated reception frames and uses sample times', () => {
  const history = [frame(4, contact(10, 10, 2)), frame(7, contact(10, 10, 2)), frame(12, contact(16, 18, 7))];
  const motion = deriveMotion('contact', frame(15, contact(16, 18, 7)), history);
  assert.equal(motion.kind, 'known');
  assert.equal(motion.speed, 2);
  assert.equal(motion.fromTick, 2);
  assert.equal(motion.toTick, 7);
  assert.equal(motion.eastPerTick, 1.2);
  assert.equal(motion.southPerTick, 1.6);
});

test('first report and history gaps stay unknown; future frames never supply motion', () => {
  assert.equal(deriveMotion('own', frame(0, own(10, 10)), [frame(1, own(20, 20))]).kind, 'unknown');
  assert.equal(deriveMotion('contact', frame(5, contact(10, 10, 2)), [frame(4, contact(10, 10, 2)), frame(9, contact(15, 10, 7))]).kind, 'unknown');
  assert.equal(deriveMotion('contact', frame(10, contact(20, 20, 8)), [frame(9), frame(4, contact(10, 10, 2))]).kind, 'unknown');
});

test('stationary data has zero speed and no invented direction', () => {
  const motion = deriveMotion('own', frame(4, own(10, 10)), [frame(2, own(10, 10))]);
  assert.equal(motion.speed, 0);
  assert.equal(motion.heading, null);
  assert.equal(projectedMotionVector(motion), null);
});

test('direction vector follows the same anisotropic projection as map positions', () => {
  const motion = deriveMotion('own', frame(2, own(11, 11)), [frame(1, own(10, 10))]);
  assert.equal(motion.heading, 135);
  const vector = projectedMotionVector(motion);
  assert.ok(vector);
  assert.ok(Math.abs(vector.y / vector.x - 0.7) < 1e-12);
  assert.ok(Math.abs(Math.hypot(vector.x, vector.y) - 42) < 1e-12);
});
