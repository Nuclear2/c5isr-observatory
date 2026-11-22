import type { DecisionEvent, Frame, Observation, Proposal } from '../contracts/state';

export interface DecisionRecord {
  proposal: Proposal;
  events: DecisionEvent[];
  evidence: Observation[] | null;
  evidenceAt?: DecisionEvent;
  recorded: boolean;
}

export const decisionKindNames: Record<DecisionEvent['kind'], string> = {
  created: '生成建议', approved: '批准', rejected: '驳回', executing: '开始执行',
  completed: '执行完成', stale: '建议过期', buffered: '报告缓存', sent: '报告发出',
  received: '报告送达', dropped: '传输失败', expired: '缓存过期',
};

export const isReportEvent = (event: DecisionEvent) => ['buffered', 'sent', 'received', 'dropped', 'expired'].includes(event.kind);

/** Missing sequence metadata is unknown history, never permission to use live records. */
export function eventsAtFrame(log: readonly DecisionEvent[] | undefined, frame: Pick<Frame, 'tick' | 'decision_seq'>, cursor?: number | null): DecisionEvent[] {
  if (!Array.isArray(log) || typeof frame.decision_seq !== 'number' || !Number.isSafeInteger(frame.decision_seq)) return [];
  const cutoff = Math.min(frame.decision_seq, cursor ?? frame.decision_seq);
  return log.filter(event => event.seq <= cutoff && event.tick <= frame.tick).sort((a, b) => a.seq - b.seq);
}

/** Reconstruct proposal state only from records visible at the selected sequence. */
export function rebuildDecisions(events: readonly DecisionEvent[]): DecisionRecord[] {
  const records = new Map<string, DecisionRecord>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    let record = records.get(event.proposal_id);
    if (!record && event.proposal) {
      record = { proposal: { ...event.proposal }, evidence: null, events: [], recorded: true };
      records.set(event.proposal_id, record);
    }
    if (!record) continue;
    if (event.proposal) record.proposal = { ...event.proposal };
    // Arrival evidence belongs to a new report, not to the earlier approval basis.
    if (event.evidence && ['created', 'approved', 'rejected'].includes(event.kind)) {
      record.evidence = [...event.evidence];
      record.evidenceAt = event;
    }
    const status = event.kind === 'created' ? 'pending' : event.kind;
    if (['pending', 'approved', 'rejected', 'executing', 'completed', 'stale'].includes(status)) {
      record.proposal.status = status as Proposal['status'];
      if (status === 'completed') record.proposal.completed_tick = event.tick;
      if (event.note && ['completed', 'stale', 'rejected'].includes(status)) record.proposal.outcome = event.note;
    }
    record.events.push(event);
  }
  return [...records.values()].sort((a, b) => Number(b.proposal.status === 'pending') - Number(a.proposal.status === 'pending') || b.proposal.created_tick - a.proposal.created_tick);
}

export function latestReportEvents(events: readonly DecisionEvent[]): DecisionEvent[] {
  const latest = new Map<string, DecisionEvent>();
  for (const event of events) if (isReportEvent(event) && event.report_id) latest.set(event.report_id, event);
  return [...latest.values()];
}
