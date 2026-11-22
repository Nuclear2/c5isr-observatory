import type {
  BatchRow, LabArchive, LabBranch, LabConfig, LabDecision, LabFrame, LabMetrics,
  LabReport, LabRun, RecordedAdvice,
} from '../contracts/evidence';

export const MAX_LAB_ARCHIVE_BYTES = 8 * 1024 * 1024;
const END_TICK = 48;
const MAX_SEED = 0xffff_ffff;
type Fields = Record<string, unknown>;

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fields(value: unknown, required: string[], optional: string[] = []): Fields {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value), '实验归档中的记录格式有误。');
  const keys = Object.keys(value);
  requireValid(required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key)),
    '实验归档中的记录字段有误。');
  return value as Fields;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function shortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= 2 * max && value.trim() !== '' && [...value].length <= max;
}

function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 5
    && value.every(id => typeof id === 'string' && /^R[1-5]$/.test(id)) && new Set(value).size === value.length;
}

/** Property order is immaterial for JSON objects; receipt and audit array order is significant. */
function matches(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matches(actual[i], v));
  }
  if (expected === null || typeof expected !== 'object' || actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const entries = Object.entries(expected);
  return Object.keys(actual).length === entries.length
    && entries.every(([k, v]) => Object.hasOwn(actual, k) && matches((actual as Fields)[k], v));
}

function readConfig(input: unknown): LabConfig {
  const config = fields(input, ['seed', 'read_interval'], ['fork_tick', 'cited_ids']);
  requireValid(integer(config.seed, 0, MAX_SEED) && integer(config.read_interval, 1, 6)
    && (config.fork_tick == null || integer(config.fork_tick, 1, 36))
    && (config.cited_ids == null || ids(config.cited_ids)), '种子、审核间隔、分岔时间或人工引用有误。');
  return config as unknown as LabConfig;
}

// Schema v1 describes one sampling period. Source names and notes are recorded presentation data.
const statements = [
  { id: 'R1', root_id: 'R1', kind: 'direct', claim: 'normal', derived_from: null, revises: null },
  { id: 'R2', root_id: 'R1', kind: 'relay', claim: 'normal', derived_from: 'R1', revises: null },
  { id: 'R3', root_id: 'R3', kind: 'self_check', claim: 'interrupted', derived_from: null, revises: null },
  { id: 'R4', root_id: 'R1', kind: 'correction', claim: 'interrupted', derived_from: null, revises: 'R1' },
  { id: 'R5', root_id: 'R1', kind: 'clarification', claim: 'interrupted', derived_from: null, revises: 'R1' },
] as const;

function readLedger(input: unknown, review: boolean, config: LabConfig, fork: number): LabReport[] {
  const count = review ? 5 : 4;
  requireValid(Array.isArray(input) && input.length === count, '终帧的报告账本不完整。');
  const ledger: LabReport[] = [];
  let available = 0;
  for (const raw of input) {
    const report = fields(raw, ['id', 'root_id', 'source', 'kind', 'claim', 'derived_from', 'revises',
      'period_start', 'period_end', 'issued_tick', 'received_tick', 'read_tick', 'note']);
    const version = statements.slice(0, count).find(v => v.id === report.id);
    requireValid(version && !ledger.some(r => r.id === version.id)
      && Object.entries(version).every(([key, v]) => report[key] === v), '报告编号、来源关系或更正版本有误。');
    requireValid(shortText(report.source, 128) && shortText(report.note, 800) && report.period_start === 0 && report.period_end === 1
      && integer(report.issued_tick, 1, END_TICK) && integer(report.received_tick, report.issued_tick, END_TICK),
    '报告的说明、采样区间或签发与收件时间有误。');
    const previous = ledger.at(-1);
    requireValid(!previous || previous.received_tick < report.received_tick
      || (previous.received_tick === report.received_tick && report.id === 'R5'), '报告的收件顺序有误。');
    const firstSlot = Math.ceil(report.received_tick / config.read_interval) * config.read_interval;
    const readAt = Math.max(firstSlot, available);
    requireValid(readAt <= END_TICK && report.read_tick === readAt, '报告的阅读时间不符合审核席的先进先出队列。');
    available = readAt + config.read_interval;
    ledger.push(report as unknown as LabReport);
  }
  const [direct, relay, selfCheck, correction] = ledger.filter(r => r.kind !== 'clarification');
  requireValid(matches([direct.id, relay.id, selfCheck.id, correction.id], ['R1', 'R2', 'R3', 'R4'])
    && new Set([direct.source, relay.source, selfCheck.source]).size === 3 && correction.source === direct.source
    && direct.issued_tick === 1 && integer(direct.received_tick, 2, 3)
    && relay.issued_tick === direct.received_tick && integer(relay.received_tick - direct.received_tick, 1, 2)
    && selfCheck.issued_tick === 2 && integer(selfCheck.received_tick - relay.received_tick, 1, 3)
    && integer(correction.received_tick, 18, 25) && correction.issued_tick === correction.received_tick - 2,
  '外部采样、更正或转述来源与本版实验的记录不符。');
  const clarification = ledger.find(r => r.kind === 'clarification');
  requireValid(!clarification || (clarification.source === direct.source && clarification.issued_tick === fork + 1
    && integer(clarification.received_tick - fork, 2, 5)), '请求复核的回报时间或来源有误。');
  return ledger;
}

function roots(reports: LabReport[]): string[] {
  return [...new Set(reports.map(r => r.root_id))].sort();
}

function effective(read: LabReport[]): LabReport[] {
  const revisions = new Map<string, LabReport>();
  for (const report of read) {
    if (!report.revises) continue;
    const previous = revisions.get(report.root_id);
    if (!previous || previous.issued_tick < report.issued_tick
      || (previous.issued_tick === report.issued_tick && previous.id < report.id)) revisions.set(report.root_id, report);
  }
  return read.filter(r => !revisions.has(r.root_id) || revisions.get(r.root_id)?.id === (r.derived_from ?? r.id));
}

function consensus(reports: LabReport[]): LabDecision['claim'] {
  return reports.length && reports.every(r => r.claim === reports[0].claim) ? reports[0].claim : 'undetermined';
}

function corrected(decision: LabDecision, read: LabReport[]): boolean {
  return decision.action === 'conclude' && read.some(revision => revision.revises && revision.read_tick! > decision.tick
    && read.some(r => decision.evidence_ids.includes(r.id) && (r.derived_from ?? r.id) === revision.revises));
}

function checkRun(input: unknown, branch: LabBranch, config: LabConfig, fork: number): LabRun {
  const run = fields(input, ['frames', 'metrics']);
  requireValid(Array.isArray(run.frames) && run.frames.length === END_TICK + 1, '分支的历史帧缺失。');
  const ledger = readLedger(run.frames[END_TICK]?.reports, branch === 'review', config, fork);
  if (config.fork_tick == null) {
    requireValid(fork === ledger.find(r => r.kind === 'relay')?.read_tick, '默认分岔应在首次读完原报和转述时发生。');
  }
  let conflictTicks = 0;
  const decisions: LabDecision[] = [];
  for (let tick = 0; tick <= END_TICK; tick++) {
    const received = ledger.filter(r => r.received_tick <= tick);
    const read = received.filter(r => r.read_tick! <= tick);
    const active = effective(read);
    const conflict = active.length > 0 && consensus(active) === 'undetermined';
    if (conflict) conflictTicks++;
    const atReview = branch === 'review' && tick === fork;
    if (tick === fork || read.some(r => r.kind === 'clarification' && r.read_tick === tick)) {
      const selection = branch === 'immediate' ? config.cited_ids : null;
      const cited = selection ? selection.map(id => {
        const r = active.find(report => report.id === id);
        requireValid(r, '人工批准引用了未知、未读或已被更正的报告。');
        return r;
      }) : active;
      requireValid(cited.length, '审批时没有已读的有效报告。');
      decisions.push({
        tick, actor: selection ? 'human' : 'baseline', action: atReview ? 'request_review' : 'conclude',
        claim: atReview ? 'undetermined' : consensus(cited), evidence_ids: cited.map(r => r.id),
        read_ids: read.map(r => r.id), independent_roots: roots(cited),
      });
    }
    const expected: LabFrame = {
      tick, reports: received.map(r => ({ ...r, read_tick: r.read_tick! <= tick ? r.read_tick : null })),
      queue_ids: received.filter(r => r.read_tick! > tick).map(r => r.id), active_ids: active.map(r => r.id),
      independent_roots: roots(active), conflict, decisions,
      metrics: { conflict_ticks: conflictTicks, corrected_approvals: decisions.filter(d => corrected(d, read)).length,
        review_requests: decisions.filter(d => d.action === 'request_review').length },
    };
    requireValid(matches(run.frames[tick], expected), `分支 ${branch === 'immediate' ? 'A' : 'B'} 的 T+${tick} 帧与当时的收件、阅读、审批或指标不符。`);
  }
  requireValid(matches(run.metrics, run.frames[END_TICK].metrics), '分支的最终指标与终帧不一致。');
  return run as unknown as LabRun;
}

function checkAdvice(input: unknown, runs: Record<LabBranch, LabRun>): RecordedAdvice[] {
  requireValid(Array.isArray(input) && input.length <= 256, '实验归档最多保存 256 条模型意见。');
  for (const raw of input) {
    const a = fields(raw, ['provider', 'branch', 'tick', 'read_ids', 'action', 'evidence_ids', 'source_count',
      'verified_source_count', 'reason', 'uncertainties']);
    requireValid(a.provider === 'codex' && (a.branch === 'immediate' || a.branch === 'review')
      && integer(a.tick, 0, END_TICK) && ids(a.evidence_ids)
      && (a.action === 'hold' || a.action === 'request_review' || a.action === 'conclude')
      && shortText(a.reason, 800) && Array.isArray(a.uncertainties) && a.uncertainties.length <= 5
      && a.uncertainties.every(u => shortText(u, 300)), '模型意见的类型、动作或说明有误。');
    const read = runs[a.branch].frames[a.tick].reports.filter(r => r.read_tick !== null);
    const selected = a.evidence_ids;
    const cited = read.filter(r => selected.includes(r.id));
    requireValid(matches(a.read_ids, read.map(r => r.id)) && cited.length === selected.length
      && integer(a.source_count, 0, cited.length) && a.verified_source_count === roots(cited).length,
    '模型意见与该帧已读报告、引用或核验后的独立来源数不符。');
  }
  return input as RecordedAdvice[];
}

function batchMetrics(input: unknown, review: boolean): LabMetrics {
  const m = fields(input, ['conflict_ticks', 'corrected_approvals', 'review_requests']);
  requireValid(integer(m.conflict_ticks, 0, END_TICK) && integer(m.corrected_approvals, 0, review ? 0 : 1)
    && m.review_requests === (review ? 1 : 0), '批量行的指标与本分支可产生的事件数不符。');
  return m as unknown as LabMetrics;
}

function checkBatch(input: unknown, archive: Pick<LabArchive, 'config' | 'fork_tick' | 'immediate' | 'review'>): BatchRow[] {
  requireValid(Array.isArray(input) && integer(input.length, 1, 32), '归档应包含 1 至 32 对连续种子的批量结果。');
  for (const [i, raw] of input.entries()) {
    const row = fields(raw, ['seed', 'immediate', 'review']);
    requireValid(integer(row.seed, 0, MAX_SEED) && row.seed === archive.config.seed + i, '批量种子有重复、跳号或越界。');
    const immediate = batchMetrics(row.immediate, false);
    const review = batchMetrics(row.review, true);
    // Conflict opens and closes only on reading slots. A's self-check precedes the routine correction;
    // B's additional correcting report can only shorten this interval.
    const interval = archive.config.read_interval;
    requireValid(immediate.conflict_ticks > 0 && review.conflict_ticks <= immediate.conflict_ticks
      && immediate.conflict_ticks % interval === 0 && review.conflict_ticks % interval === 0,
    '批量行的冲突时长与审核席阅读节奏或复核时间序列不符。');
    if (i === 0) {
      // Batches always cite all effective reports, including when single-seed A has a human selection.
      const baseline = archive.immediate.frames[archive.fork_tick];
      const correctedAtEnd = corrected({ ...baseline.decisions[0], evidence_ids: baseline.active_ids },
        archive.immediate.frames[END_TICK].reports);
      requireValid(matches(immediate, { ...archive.immediate.metrics, corrected_approvals: Number(correctedAtEnd) })
        && matches(review, archive.review.metrics), '本种子批量行与对应的规则基线回放不符。');
    }
  }
  return input as BatchRow[];
}

export function parseEvidenceArchiveData(input: unknown): LabArchive {
  const archive = fields(input, ['kind', 'schema_version', 'config', 'fork_tick', 'end_tick', 'immediate', 'review'], ['advice', 'batch']);
  requireValid(archive.kind === 'c5isr-evidence-lab' && archive.schema_version === 1, '证据实验归档类型或版本不受支持。');
  const config = readConfig(archive.config);
  const fork = archive.fork_tick;
  requireValid(archive.end_tick === END_TICK && integer(fork, 1, 36) && (config.fork_tick == null || fork === config.fork_tick),
    '归档分岔时刻或回放终点有误。');
  const immediate = checkRun(archive.immediate, 'immediate', config, fork);
  const review = checkRun(archive.review, 'review', config, fork);
  const commonTape = (run: LabRun) => run.frames[END_TICK].reports.filter(r => r.kind !== 'clarification')
    .map(r => ({ ...r, read_tick: null }));
  requireValid(matches(commonTape(immediate), commonTape(review))
    && matches(immediate.frames.slice(0, fork), review.frames.slice(0, fork)), '两组的外部收件记录或分岔前历史不相同。');
  const result: LabArchive = {
    kind: archive.kind, schema_version: 1, config, fork_tick: fork, end_tick: END_TICK, immediate, review,
  };
  if (archive.advice !== undefined) result.advice = checkAdvice(archive.advice, result);
  if (archive.batch !== undefined) result.batch = checkBatch(archive.batch, result);
  return result;
}

export function parseEvidenceArchive(text: string): LabArchive {
  if (text.length > MAX_LAB_ARCHIVE_BYTES || new Blob([text]).size > MAX_LAB_ARCHIVE_BYTES) throw new Error('证据实验归档超过 8 MiB 上限。');
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new Error('证据实验归档的 JSON 解析失败。'); }
  return parseEvidenceArchiveData(data);
}
