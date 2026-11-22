import type { CenterView, FieldAudit, FieldStatus, ReceiptStudy, StatusReceipt } from '../contracts/receipt';
import type { DecisionEvent, Frame } from '../contracts/state';

type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const fields = (v: unknown, keys: string): v is Row => object(v) && keys.split(' ').every(k => Object.hasOwn(v, k))
  && Object.keys(v).length === keys.split(' ').length;
const tick = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
function requireFact(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error('中心知情对照归档有误：' + reason);
}
function matches(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length && expected.every((x, i) => matches(value[i], x));
  return object(value) && object(expected) && Object.keys(value).length === Object.keys(expected).length
    && Object.keys(expected).every(k => Object.hasOwn(value, k) && matches(value[k], expected[k]));
}

function readAudit(input: unknown, status: FieldStatus, caseId: string, start: number, end: number, delivered: boolean): FieldAudit {
  const suffix = status === 'sampled_buffered' ? 'buffered' : 'not-sampled';
  requireFact(fields(input, 'status as_of_tick sampled_tick sent_tick received_tick receipt_id')
    && input.status === status && tick(input.as_of_tick) && input.as_of_tick >= start
    && input.sampled_tick === (status === 'sampled_buffered' ? input.as_of_tick : null)
    && tick(input.sent_tick) && input.sent_tick >= input.as_of_tick && input.sent_tick <= end
    && (delivered ? input.received_tick === end && end > input.sent_tick : input.received_tick === null && end > input.sent_tick)
    && input.receipt_id === 'ack-' + caseId + '-' + suffix, '现场时刻、回执身份或传输记录不符。');
  return input as unknown as FieldAudit;
}

function localApproval(frames: unknown[], id: string, seq: number, start: number, cutoff: number): NonNullable<CenterView['request']> {
  for (const f of frames) {
    if (!object(f) || !object(f.buffered) || f.buffered.request == null) continue;
    const r = f.buffered.request;
    requireFact(fields(r, 'id approved_tick approval_seq') && r.id === id && r.approval_seq === seq
      && tick(r.approved_tick) && r.approved_tick >= start && r.approved_tick <= cutoff, '本地批准记录缺失或无效。');
    return { id, approved_tick: r.approved_tick, approval_seq: seq };
  }
  throw new Error('中心知情对照缺少本地批准记录。');
}

export function parseReceiptStudy(input: unknown): ReceiptStudy {
  requireFact(fields(input, 'kind schema_version case_id source_id approval_seq start_tick end_tick delivery frames field_audit')
    && input.kind === 'c5isr-receipt-study' && input.schema_version === 1, '无法识别文件类型或版本。');
  const { case_id: caseId, source_id: source, approval_seq: seq, start_tick: start, end_tick: end, frames } = input;
  requireFact(identifier(caseId) && identifier(source) && tick(seq) && seq > 0 && tick(start) && tick(end) && end >= start
    && Array.isArray(frames) && frames.length === end - start + 1 && frames.length <= 360
    && (input.delivery === 'delivered' || input.delivery === 'lost') && fields(input.field_audit, 'buffered not_sampled'), '时间线或送达条件无效。');
  const delivered = input.delivery === 'delivered';
  const positive = readAudit(input.field_audit.buffered, 'sampled_buffered', caseId, start, end, delivered);
  const negative = readAudit(input.field_audit.not_sampled, 'not_sampled', caseId, start, end, delivered);
  requireFact(positive.as_of_tick === negative.as_of_tick && positive.sent_tick === negative.sent_tick
    && positive.received_tick === negative.received_tick, '两边应共用状态截至时刻及传输时间。');
  const approved = localApproval(frames, caseId, seq, start, positive.as_of_tick);
  const schedule = frames.find(f => object(f) && object(f.buffered) && f.buffered.expected_tick != null);
  const expected = object(schedule) && object(schedule.buffered) && schedule.buffered.expected_tick;
  requireFact(tick(expected) && expected > approved.approved_tick && expected - 1 <= end, '缺少本地登记的预期采样时刻。');
  for (const [i, frame] of frames.entries()) {
    const at = start + i;
    requireFact(fields(frame, 'tick buffered not_sampled') && frame.tick === at && object(frame.buffered)
      && typeof frame.buffered.link_enabled === 'boolean', '回放帧缺失或顺序无效。');
    for (const [key, audit] of [['buffered', positive], ['not_sampled', negative]] as const) {
      const receipt: StatusReceipt | null = audit.received_tick !== null && audit.received_tick <= at ? {
        id: audit.receipt_id, source_id: source, case_id: caseId, status: audit.status, as_of_tick: audit.as_of_tick,
        sampled_tick: audit.sampled_tick, sent_tick: audit.sent_tick, received_tick: audit.received_tick,
      } : null;
      const center: CenterView = {
        link_enabled: frame.buffered.link_enabled, request: at >= approved.approved_tick ? approved : null,
        expected_tick: at >= expected - 1 ? expected : null,
        receipts: receipt ? [receipt] : [], knowledge: receipt ? { status: receipt.status, as_of_tick: receipt.as_of_tick,
          known_tick: receipt.received_tick, receipt_id: receipt.id } : null,
      };
      requireFact(matches(frame[key], center), 'T+' + at + ' 的中心显示无法由本地请求与已送达回执重建。');
    }
  }
  return input as unknown as ReceiptStudy;
}

export function parseReceiptAttachments(input: unknown, log: DecisionEvent[], history: Frame[]): ReceiptStudy[] {
  requireFact(Array.isArray(input) && input.length <= log.length * 2, '附件数量无效。');
  const studies = input.map(parseReceiptStudy);
  const seen = new Set<string>();
  const siblings = new Map<number, ReceiptStudy>();
  for (const s of studies) {
    const events = log.filter(e => e.proposal_id === s.case_id);
    const approval = events.find(e => e.seq === s.approval_seq && e.kind === 'approved');
    const created = events.find(e => e.kind === 'created');
    const execution = events.find(e => e.kind === 'executing');
    requireFact(approval && created?.proposal?.action === 'request_observation' && created.proposal.subject_id === s.source_id
      && created.seq < approval.seq && execution && execution.seq > approval.seq, '未找到本事项的本地批准与执行记录。');
    const audit = s.field_audit.buffered;
    const buffered = events.find(e => ['buffered', 'sent', 'dropped', 'expired'].includes(e.kind));
    requireFact(buffered?.kind === 'buffered' && identifier(buffered.report_id) && buffered.seq > execution.seq
      && buffered.tick === buffered.sampled_tick && buffered.tick === audit.as_of_tick, '未找到采样当步的初次暂存记录。');
    const transport = events.filter(e => e.seq > buffered.seq && e.report_id === buffered.report_id && e.sampled_tick === buffered.tick);
    const arrived = transport.find(e => ['received', 'expired', 'dropped'].includes(e.kind));
    const sent = arrived && transport.filter(e => e.seq < arrived.seq && ['sent', 'buffered'].includes(e.kind)).at(-1);
    requireFact(arrived?.kind === 'received' && sent?.kind === 'sent' && sent.tick === audit.sent_tick
      && arrived.evidence?.some(o => o.id === buffered.report_id && o.source_id === s.source_id
        && o.observed_tick === buffered.tick && o.received_tick === arrived.tick)
      && (s.delivery === 'lost' || arrived.tick === audit.received_tick)
      && s.end_tick === arrived.tick, '对照与原案的暂存、发出或最后到达不符。');
    const key = s.approval_seq + '/' + s.delivery;
    requireFact(!seen.has(key), '同一事项存在重复条件。');
    seen.add(key);
    const previous = siblings.get(s.approval_seq);
    if (previous) requireFact(previous.start_tick === s.start_tick && previous.end_tick === s.end_tick
      && previous.frames.every((f, i) => f.buffered.link_enabled === s.frames[i].buffered.link_enabled
        && matches(f.buffered.request, s.frames[i].buffered.request) && f.buffered.expected_tick === s.frames[i].buffered.expected_tick),
    '同一事项两个条件的本地时间线不一致。');
    siblings.set(s.approval_seq, s);
    requireFact(history[0]?.tick <= s.start_tick, '附件起始已超出父档保留范围。');
    const switches = history.flatMap(f => {
      const link = f.links.find(l => l.from === s.source_id && l.to === 'command');
      return (f.link_changes ?? []).filter(c => c.link_id === link?.id && c.before.enabled !== c.after.enabled)
        .map(c => ({ tick: f.tick, seq: c.seq, enabled: c.after.enabled }));
    });
    const outage = switches.filter(c => c.seq < buffered.seq).at(-1);
    const recovery = switches.filter(c => c.seq < sent.seq).at(-1);
    requireFact(outage && !outage.enabled && s.start_tick === Math.min(approval.tick, outage.tick), '起始步与首次暂存前的断链不符。');
    requireFact(recovery && recovery.enabled && recovery.seq > buffered.seq,
      '缺少暂存至最终发出之间的链路恢复。');
    for (const frame of s.frames) {
      const parent = history.find(f => f.tick === frame.tick);
      requireFact(parent && parent.decision_seq != null && (frame.tick !== arrived.tick || parent.decision_seq >= arrived.seq),
        '回放缺少已包含原件收件事件的父档记录。');
      requireFact((frame.buffered.request?.approved_tick ?? null) === (parent.decision_seq >= approval.seq ? approval.tick : null)
        && frame.buffered.expected_tick === (parent.decision_seq >= execution.seq ? execution.tick + 1 : null), '本地请求时刻与父档不一致。');
      const link = parent?.links.find(l => l.from === s.source_id && l.to === 'command');
      const afterArrival = frame.tick === arrived.tick ? parent?.link_changes?.find(c => c.link_id === link?.id && c.seq > arrived.seq) : undefined;
      requireFact(link && (afterArrival?.before.enabled ?? link.enabled) === frame.buffered.link_enabled, '中心链路与父档不一致。');
    }
  }
  return studies;
}
