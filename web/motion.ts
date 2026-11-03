import type { Frame, Unit } from '../contracts/state';

export type MotionEstimate =
  | { kind: 'unknown'; reason: string }
  | {
    kind: 'known';
    source: 'own_frames' | 'received_reports';
    speed: number;
    heading: number | null;
    eastPerTick: number;
    southPerTick: number;
    fromTick: number;
    toTick: number;
  };

const unknown = (reason: string): MotionEstimate => ({ kind: 'unknown', reason });
const finitePosition = (unit: Unit) => Number.isFinite(unit.x) && Number.isFinite(unit.y);

function difference(previous: Unit, current: Unit, fromTick: number, toTick: number, source: 'own_frames' | 'received_reports'): MotionEstimate {
  const elapsed = toTick - fromTick;
  if (!finitePosition(previous) || !finitePosition(current) || !Number.isFinite(elapsed) || elapsed <= 0) {
    return unknown('位置或时间数据不足');
  }
  const eastPerTick = (current.x - previous.x) / elapsed;
  const southPerTick = (current.y - previous.y) / elapsed;
  const speed = Math.hypot(eastPerTick, southPerTick);
  const heading = speed < 1e-9 ? null : (Math.atan2(eastPerTick, -southPerTick) * 180 / Math.PI + 360) % 360;
  return { kind: 'known', source, speed, heading, eastPerTick, southPerTick, fromTick, toTick };
}

/** Uses only public frames at or before the displayed tick; never extrapolates. */
export function deriveMotion(unitId: string, frame: Frame, history: readonly Frame[]): MotionEstimate {
  const current = frame.units.find(unit => unit.id === unitId);
  if (!current) return unknown('此帧没有该节点或接触');
  const earlier = history.filter(item => item.tick < frame.tick).sort((a, b) => b.tick - a.tick);

  if (current.side === 'blue') {
    const previousFrame = earlier[0];
    const previous = previousFrame?.units.find(unit => unit.id === unitId && unit.side === 'blue');
    if (!previous || !previousFrame) return unknown('需要两帧公开位置');
    return difference(previous, current, previousFrame.tick, frame.tick, 'own_frames');
  }

  const report = current.contact;
  if (!report || report.first_seen_tick > frame.tick || report.last_seen_tick > frame.tick || report.expires_tick <= frame.tick) {
    return unknown('此帧没有有效接触报告');
  }
  for (const previousFrame of earlier) {
    const previous = previousFrame.units.find(unit => unit.id === unitId && unit.side === 'red');
    const previousReport = previous?.contact;
    // Do not bridge an interval during which the contact was unknown or archived.
    if (!previous || !previousReport || previousReport.expires_tick <= previousFrame.tick) break;
    if (previousReport.first_seen_tick !== report.first_seen_tick) break;
    if (previousReport.last_seen_tick >= report.last_seen_tick) continue;
    if (previousReport.last_seen_tick > previousFrame.tick || previousReport.last_seen_tick < report.first_seen_tick) continue;
    return difference(previous, current, previousReport.last_seen_tick, report.last_seen_tick, 'received_reports');
  }
  return unknown('需要两份不同采样时间的已收报告');
}

/** The SVG scales x by 10 and y by 7. Project before normalizing the direction. */
export function projectedMotionVector(motion: MotionEstimate, length = 42): { x: number; y: number } | null {
  if (motion.kind !== 'known' || motion.heading === null) return null;
  const projectedX = motion.eastPerTick * 10;
  const projectedY = motion.southPerTick * 7;
  const norm = Math.hypot(projectedX, projectedY);
  if (!Number.isFinite(norm) || norm === 0) return null;
  return { x: projectedX / norm * length, y: projectedY / norm * length };
}

export const headingLabel = (motion: MotionEstimate) => motion.kind === 'unknown' ? '未知' : motion.heading === null ? '静止 / 无航向' : `${(Math.round(motion.heading) % 360).toString().padStart(3, '0')}°`;
export const speedLabel = (motion: MotionEstimate) => motion.kind === 'unknown' ? '未知' : `${motion.speed.toFixed(3)} grid/tick`;
export const shortMotionLabel = (motion: MotionEstimate) => motion.kind === 'unknown' ? '速度 / 航向未知' : `${motion.speed.toFixed(2)} g/t · ${motion.heading === null ? '静止' : headingLabel(motion)}`;
