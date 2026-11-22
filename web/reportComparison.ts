import type { DecisionEvent, Frame, LinkChange, ReportVersion } from '../contracts/state';
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

export type MilestoneKind = 'offline' | 'offline_at_start' | 'restored' | 'degraded' | 'profile_restored' | 'repaired'
  | 'sample' | 'field' | 'buffered' | 'sent' | 'center' | 'dropped' | 'expired';
interface Milestone { kind: MilestoneKind; tick: number; seq?: number }

function legacyLinkMilestones(report: ReportVersion, frame: Frame, history: readonly Frame[], closedAt: number | null): Milestone[] {
  const timeline: Milestone[] = [];
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
  return timeline;
}

function changeKind(change: LinkChange): MilestoneKind {
  if (change.cause === 'restore_link') return 'repaired';
  if (change.before.enabled !== change.after.enabled) return change.after.enabled ? 'restored' : 'offline';
  return change.cause === 'link_loss' ? 'degraded' : 'profile_restored';
}

function recordedLinkMilestones(
  report: ReportVersion, frame: Frame, history: readonly Frame[], closedAt: number | null, closedSeq?: number,
): Milestone[] {
  const timeline: Milestone[] = [];
  // Initial editions reached both desks during setup, before the first experimental command.
  if (report.proposal_id === null) return timeline;
  let activeOutage: Milestone | undefined;
  for (const item of history) {
    if (item.tick > frame.tick || (closedAt !== null && item.tick > closedAt)) break;
    const link = item.links.find(l => l.from === report.source_id && l.to === 'command');
    if (!link) continue;
    const changes = item.link_changes!.filter(c => c.link_id === link.id);
    if (item === history[0] && !(changes[0]?.before.enabled ?? link.enabled)) {
      activeOutage = { kind: 'offline_at_start', tick: item.tick };
    }
    if (item.tick >= report.sampled_tick && activeOutage) {
      timeline.push(activeOutage);
      activeOutage = undefined;
    }
    for (const change of changes) {
      if (change.seq > frame.decision_seq! || (item.tick === closedAt && (closedSeq === undefined || change.seq > closedSeq))) break;
      const moment = { kind: changeKind(change), tick: item.tick, seq: change.seq };
      if (item.tick >= report.sampled_tick) timeline.push(moment);
      else activeOutage = change.after.enabled ? undefined : moment;
    }
  }
  return timeline;
}

export function reportMilestones(
  report: ReportVersion, frame: Frame, history: readonly Frame[], log: readonly DecisionEvent[] | undefined,
): Milestone[] {
  if (report.sampled_tick > frame.tick) return [];
  const entries = log?.filter(e => e.report_id === report.report_id && e.proposal_id === report.proposal_id);
  const transport = eventsAtFrame(entries, frame);
  const terminal = transport.find(e => e.kind === 'dropped' || e.kind === 'expired' || e.kind === 'received');
  // If a same-tick receipt has a sequence, a smaller cursor still sees the report in transit.
  // Retained older editions can lack the transport group and still have a valid receipt tick.
  const receipt = entries?.find(e => e.kind === 'received');
  const centerTick = !receipt || terminal?.kind === 'received' ? report.center_received_tick : null;
  const closedAt = terminal?.tick ?? centerTick;
  const recorded = history[0]?.link_changes !== undefined;
  const timeline = recorded ? recordedLinkMilestones(report, frame, history, closedAt, terminal?.seq)
    : legacyLinkMilestones(report, frame, history, closedAt);
  timeline.push({ kind: 'sample', tick: report.sampled_tick });
  for (const event of transport) {
    if (event.kind === 'buffered' || event.kind === 'sent' || event.kind === 'dropped' || event.kind === 'expired') {
      timeline.push({ kind: event.kind, tick: event.tick, ...(recorded && { seq: event.seq }) });
    }
  }
  if (report.field_received_tick !== null && report.field_received_tick <= frame.tick) timeline.push({ kind: 'field', tick: report.field_received_tick });
  if (centerTick !== null && centerTick <= frame.tick) {
    timeline.push({ kind: 'center', tick: centerTick, ...(recorded && terminal?.kind === 'received' && { seq: terminal.seq }) });
  }
  // Tick-only facts are marked separately in the view. A global sequence orders all
  // retained link changes and transport events, even when the frame ends back online.
  return timeline.sort((a, b) => a.tick - b.tick || (a.seq ?? 0) - (b.seq ?? 0));
}
