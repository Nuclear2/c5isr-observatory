import type { DecisionEvent, Frame, ReportVersion } from '../contracts/state';
import { eventsAtFrame } from './decisions.ts';

export interface ReportSeries {
  source_id: string;
  versions: ReportVersion[];
  field: ReportVersion | null;
  center: ReportVersion | null;
}

function receivedBy(receipt: number | null, atTick: number): number | null {
  return receipt !== null && receipt <= atTick ? receipt : null;
}

/** Only frame-end facts are returned, including in the chooser and transport timeline. */
export function reportSeriesAtFrame(
  ledger: readonly ReportVersion[],
  frame: Pick<Frame, 'tick' | 'units' | 'links'>,
): ReportSeries[] {
  const bySource = new Map<string, ReportVersion[]>();
  const ownSources = new Set(frame.units.filter(unit => unit.side === 'blue' && unit.id !== 'command').map(unit => unit.id));
  for (const row of ledger) {
    if (row.sampled_tick > frame.tick || !ownSources.has(row.source_id)) continue;
    const versions = bySource.get(row.source_id) ?? [];
    versions.push({
      ...row,
      field_received_tick: receivedBy(row.field_received_tick, frame.tick),
      center_received_tick: receivedBy(row.center_received_tick, frame.tick),
    });
    bySource.set(row.source_id, versions);
  }
  const series = Array.from(bySource, ([source_id, versions]) => {
    versions.sort((a, b) => b.version - a.version);
    return {
      source_id, versions,
      field: versions.find(row => row.field_received_tick !== null) ?? null,
      center: versions.find(row => row.center_received_tick !== null) ?? null,
    };
  });
  const down = new Set(frame.links.filter(link => !link.enabled && link.to === 'command').map(link => link.from));
  const diverged = (item: ReportSeries) => Number(item.field?.version !== item.center?.version);
  return series.sort((a, b) => diverged(b) - diverged(a)
    || Number(down.has(b.source_id)) - Number(down.has(a.source_id))
    || b.versions[0].sampled_tick - a.versions[0].sampled_tick);
}

export type MilestoneKind = 'offline' | 'offline_at_start' | 'restored' | 'sample' | 'field' | 'buffered' | 'sent' | 'center' | 'dropped' | 'expired';
interface Milestone { kind: MilestoneKind; tick: number }

export function reportMilestones(
  report: ReportVersion, frame: Frame, history: readonly Frame[], log: readonly DecisionEvent[] | undefined,
): Milestone[] {
  if (report.sampled_tick > frame.tick) return [];
  const timeline: Milestone[] = [];
  const transport = eventsAtFrame(log, frame).filter(e => e.report_id === report.report_id && e.proposal_id === report.proposal_id);
  // Link history is independent of report receipts. Reconnection alone never confirms delivery.
  const closedAt = transport.find(e => e.kind === 'dropped' || e.kind === 'expired')?.tick ?? report.center_received_tick;
  let priorEnabled: boolean | undefined;
  let offlineAt: Milestone | null = null;
  for (const item of history) {
    if (item.tick > frame.tick || (closedAt !== null && item.tick > closedAt)) break;
    const enabled = item.links.find(link => link.from === report.source_id && link.to === 'command')?.enabled;
    if (enabled === false && priorEnabled !== false) {
      offlineAt = { kind: priorEnabled === undefined ? 'offline_at_start' : 'offline', tick: item.tick };
      if (item.tick >= report.sampled_tick) timeline.push(offlineAt);
    } else if (enabled && priorEnabled === false && item.tick >= report.sampled_tick) {
      timeline.push({ kind: 'restored', tick: item.tick });
    }
    if (item.tick === report.sampled_tick && enabled === false && offlineAt !== null && offlineAt.tick < item.tick) {
      timeline.push(offlineAt);
    }
    priorEnabled = enabled;
  }
  timeline.push({ kind: 'sample', tick: report.sampled_tick });
  for (const event of transport) {
    if (event.kind === 'buffered' || event.kind === 'sent' || event.kind === 'dropped' || event.kind === 'expired') {
      timeline.push({ kind: event.kind, tick: event.tick });
    }
  }
  if (report.field_received_tick !== null && report.field_received_tick <= frame.tick) timeline.push({ kind: 'field', tick: report.field_received_tick });
  if (report.center_received_tick !== null && report.center_received_tick <= frame.tick) timeline.push({ kind: 'center', tick: report.center_received_tick });
  return timeline.sort((a, b) => a.tick - b.tick);
}
