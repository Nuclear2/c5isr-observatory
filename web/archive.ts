import type { DecisionEvent, Frame, Link, Observation, Proposal, ReportVersion, Unit } from '../contracts/state';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

type Fields = Record<string, unknown>;
const record = (v: unknown): v is Fields => v !== null && typeof v === 'object' && !Array.isArray(v);
const tick = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const string = (v: unknown): v is string => typeof v === 'string';
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(string);
const oneOf = (v: unknown, choices: readonly string[]) => typeof v === 'string' && choices.includes(v);

function isUnit(v: unknown): v is Unit {
  if (!record(v)) return false;
  const c = v.contact;
  return [v.id, v.name, v.type_label, v.model_label, v.role].every(string)
    && oneOf(v.affiliation, ['PLA', 'US', 'TW', 'JP', 'KR']) && oneOf(v.side, ['blue', 'red'])
    && oneOf(v.domain, ['air', 'surface', 'subsurface', 'ground', 'space'])
    && oneOf(v.connection, ['online', 'degraded', 'offline']) && typeof v.conceptual === 'boolean'
    && [v.x, v.y, v.readiness].every(number)
    && (c === undefined ? v.side === 'blue' : record(c) && [c.first_seen_tick, c.last_seen_tick, c.expires_tick].every(tick));
}

function isLink(v: unknown): v is Link {
  return record(v) && [v.id, v.from, v.to].every(string)
    && number(v.quality) && tick(v.latency_ticks) && typeof v.enabled === 'boolean';
}

function isFrame(v: unknown): v is Frame {
  if (!record(v) || !tick(v.tick) || !record(v.metrics) || !record(v.perception)) return false;
  const m = v.metrics;
  const p = v.perception;
  return (v.decision_seq === undefined || tick(v.decision_seq))
    && Array.isArray(v.units) && v.units.every(isUnit) && Array.isArray(v.links) && v.links.every(isLink)
    && [m.delivered, m.dropped, m.pending_messages, m.completed_tasks].every(tick)
    && [m.avg_latency_ticks, m.freshness].every(number)
    && [p.cycle_ticks, p.next_scan_tick, p.active_contacts, p.total_discovered, p.total_archived].every(tick);
}

function isObservation(v: unknown): v is Observation {
  return record(v) && [v.id, v.unit_id, v.source_id, v.note].every(string)
    && tick(v.observed_tick) && tick(v.received_tick) && v.observed_tick <= v.received_tick && number(v.confidence);
}

function isProposal(v: unknown): v is Proposal {
  return record(v) && [v.id, v.title, v.rationale, v.subject_id, v.expected_effect].every(string)
    && oneOf(v.action, ['review_data', 'restore_link', 'request_observation', 'hold'])
    && oneOf(v.source, ['baseline', 'codex']) && strings(v.evidence_ids) && strings(v.uncertainties)
    && oneOf(v.status, ['pending', 'approved', 'rejected', 'executing', 'completed', 'stale'])
    && tick(v.created_tick) && (v.completed_tick === null || tick(v.completed_tick))
    && (v.outcome === null || string(v.outcome));
}

function isDecision(v: unknown): v is DecisionEvent {
  if (!record(v) || !tick(v.seq) || v.seq === 0 || !tick(v.tick) || !string(v.proposal_id)) return false;
  const at = v.tick;
  return oneOf(v.kind, ['created', 'approved', 'rejected', 'executing', 'completed', 'stale', 'buffered', 'sent', 'received', 'dropped', 'expired'])
    && (v.actor == null || oneOf(v.actor, ['human', 'ai']))
    && (v.proposal == null || (isProposal(v.proposal) && v.proposal.id === v.proposal_id && v.proposal.created_tick <= at))
    && (v.evidence == null || (Array.isArray(v.evidence) && v.evidence.every(o => isObservation(o) && o.received_tick <= at)))
    && (v.report_id == null || string(v.report_id)) && (v.note == null || string(v.note))
    && (v.sampled_tick == null || (tick(v.sampled_tick) && v.sampled_tick <= at));
}

function isReportVersion(v: unknown, endTick: number): v is ReportVersion {
  if (!record(v) || !tick(v.sampled_tick) || v.sampled_tick > endTick) return false;
  const sampled = v.sampled_tick;
  const validReceipt = (at: unknown) => at === null || (tick(at) && at >= sampled && at <= endTick);
  return string(v.source_id) && string(v.report_id) && v.report_id.length > 0
    && tick(v.version) && v.version > 0
    && (v.version === 1 ? v.proposal_id === null : string(v.proposal_id) && v.proposal_id.length > 0)
    && validReceipt(v.field_received_tick) && validReceipt(v.center_received_tick);
}

function readReportVersions(input: unknown, lastFrame: Frame): ReportVersion[] {
  if (!Array.isArray(input)) throw new Error('双节点收件记录格式有误。');
  const ownSources = new Set(lastFrame.units.filter(u => u.side === 'blue' && u.id !== 'command').map(u => u.id));
  const reportIds = new Set<string>();
  const editions = new Map<string, Set<number>>();
  const versions: ReportVersion[] = [];
  for (const row of input) {
    if (!isReportVersion(row, lastFrame.tick) || !ownSources.has(row.source_id)) {
      throw new Error('报告来源、版本或实际收件时间有误。');
    }
    const seen = editions.get(row.source_id) ?? new Set<number>();
    if (reportIds.has(row.report_id) || seen.has(row.version)) {
      throw new Error('双节点记录包含重复的报告编号或来源版本。');
    }
    seen.add(row.version);
    editions.set(row.source_id, seen);
    reportIds.add(row.report_id);
    versions.push(row);
  }
  return versions;
}

/** Only recorded public data reaches the viewer. Journal and provider data stay unused. */
export function parseArchive(text: string): { history: Frame[]; decision_log: DecisionEvent[]; report_versions?: ReportVersion[] } {
  if (text.length > MAX_ARCHIVE_BYTES || new Blob([text]).size > MAX_ARCHIVE_BYTES) {
    throw new Error('文件超过 64 MiB 的回看上限。');
  }
  let file: unknown;
  try { file = JSON.parse(text); }
  catch { throw new Error('无法读取 JSON，请选择从实验界面导出的完整文件。'); }
  if (!record(file) || file.kind !== 'c5isr-synthetic-experiment' || file.schema_version !== 1 || !record(file.snapshot)) {
    throw new Error('无法识别实验归档类型或版本。');
  }
  const { history, decision_log } = file.snapshot;
  if (file.scenario_version === 'archipelago-1') {
    throw new Error('这份早期场景没有记录本方视角历史帧和决策依据，无法回放。');
  }
  if (!Array.isArray(history) || history.length === 0 || history.length > 360 || !history.every(isFrame)) {
    throw new Error('实验归档的历史帧缺失或格式有误。');
  }
  const decisions: unknown = decision_log === undefined ? [] : decision_log;
  if (!Array.isArray(decisions) || !decisions.every(isDecision)) throw new Error('决策记录的内容或时间有误。');
  for (let i = 0; i < decisions.length; i++) {
    const previous = decisions[i - 1];
    if (previous && (previous.seq >= decisions[i].seq || previous.tick > decisions[i].tick)) {
      throw new Error('决策记录的顺序有误。');
    }
  }
  // Pruning completed groups may leave gaps in the sequence. A frame can point into such a gap.
  let idx = 0;
  for (let i = 0; i < history.length; i++) {
    const frame = history[i];
    const previous = history[i - 1];
    if ((previous && previous.tick >= frame.tick) || (decision_log === undefined) !== (frame.decision_seq === undefined)) {
      throw new Error('历史帧的时间或决策游标有误。');
    }
    if (frame.decision_seq === undefined) continue;
    if (previous && previous.decision_seq! > frame.decision_seq) throw new Error('历史帧中的决策游标发生倒退。');
    while (idx < decisions.length && decisions[idx].seq <= frame.decision_seq) {
      if (decisions[idx].tick > frame.tick) throw new Error('历史帧包含尚未发生的决策记录。');
      idx++;
    }
    if (idx < decisions.length && decisions[idx].tick < frame.tick) throw new Error('历史帧缺少此前已发生的决策。');
  }
  if (idx !== decisions.length) throw new Error('实验归档包含超出最后一帧的决策。');
  if (file.snapshot.report_versions !== undefined) {
    return { history, decision_log: decisions, report_versions: readReportVersions(file.snapshot.report_versions, history[history.length - 1]) };
  }
  return { history, decision_log: decisions };
}
