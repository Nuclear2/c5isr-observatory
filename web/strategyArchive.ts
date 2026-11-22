import type { DecisionEvent, Frame } from '../contracts/state';
import type { BranchFrame, Delivery, FieldRecord, Material, StrategyStudy, StudyDecision, StudyReport, UnresolvedReason } from '../contracts/strategy';

function check(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error('策略对照归档有误：' + detail);
}
type Fields = Record<string, unknown>;
const object = (v: unknown): v is Fields => v !== null && typeof v === 'object' && !Array.isArray(v);
const fields = (v: unknown, keys: string): v is Fields => object(v)
  && Object.keys(v).length === keys.split(' ').length && keys.split(' ').every(k => Object.hasOwn(v, k));
const tick = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
const finding = (v: unknown) => v === 'continuous' || v === 'gap';

// Equality of JSON records ignores object key ordering, but preserves ordered receipts and citations.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}

const reportKeys = 'id kind source_id root_id root_sampled_tick sampled_tick received_tick read_tick claim';
const fieldKeys = 'id source_id sampled_tick expected_samples recorded_samples finding';
const studyKeys = 'kind schema_version case_id source_id sampled_tick fork_tick fork_seq end_tick delivery link_events frames settlement';
function isReadReport(r: unknown): r is StudyReport {
  return fields(r, reportKeys)
    && id(r.id) && id(r.source_id) && id(r.root_id) && tick(r.sampled_tick)
    && tick(r.root_sampled_tick) && r.root_sampled_tick <= r.sampled_tick
    && tick(r.received_tick) && r.sampled_tick <= r.received_tick
    && tick(r.read_tick) && r.received_tick <= r.read_tick && finding(r.claim);
}

function readFieldRecord(value: unknown, source: string, sampled: number, material?: Material): FieldRecord {
  check(fields(value, material ? fieldKeys + ' slots' : fieldKeys) && id(value.id)
    && value.source_id === source && value.sampled_tick === sampled
    && tick(value.expected_samples) && value.expected_samples > 0 && tick(value.recorded_samples)
    && value.recorded_samples <= value.expected_samples
    && value.finding === (value.recorded_samples === value.expected_samples ? 'continuous' : 'gap'), '现场底稿的样本数与结论不符。');
  if (material) {
    check(value.expected_samples === 4 && Array.isArray(value.slots) && value.slots.length === 4
      && value.slots.every(s => typeof s === 'boolean') && value.slots.filter(Boolean).length === value.recorded_samples,
      '现场底稿的四次采样记录与实收数不符。');
  }
  return value as unknown as FieldRecord;
}

interface ReplyReview {
  envelope: StudyReport;
  read: StudyReport;
  judgment: StudyDecision;
  unresolvedReason: UnresolvedReason | null;
}

function reviewReply(input: unknown, material: Material | undefined, delivery: Delivery, fork: number,
  end: number, field: FieldRecord, originals: StudyReport[], caseId: string): ReplyReview {
  const ids = originals.map(r => r.id);
  const supplement = originals[1];
  check(fields(input, material ? reportKeys + ' coverage' : reportKeys) && input.kind === 'verification'
    && id(input.id) && !ids.includes(input.id) && input.root_sampled_tick === field.sampled_tick
    && input.sampled_tick === field.sampled_tick && input.received_tick === fork + (delivery === 'normal' ? 3 : 12)
    && tick(input.read_tick) && input.read_tick > input.received_tick && input.read_tick <= end
    && input.read_tick % 3 === 0 && input.read_tick - input.received_tick <= 3, '核验件的编号、窗口或收阅时刻不符。');
  const read = input as unknown as StudyReport;
  let cited = [read.id];
  let reason: UnresolvedReason | null = null;
  let envelope: StudyReport;
  if (material === undefined) {
    // Version 1 recorded a direct counter finding. Keep its original envelope and scoring.
    check(input.source_id === 'counter-' + field.source_id && input.root_id === field.id
      && input.claim === field.finding, '旧版独立核验的原稿或结论不符。');
    envelope = { ...read, claim: null, read_tick: null };
  } else {
    check(input.id === 'verification-' + caseId, '核验件编号与本案不符。');
    const { coverage, ...header } = read;
    envelope = { ...header, source_id: 'verification-desk-' + field.source_id, root_id: null, read_tick: null, claim: null };
    if (material === 'copy') {
      const scope = [1, 2, 3, 4].map(slot => ({ slot, present: null }));
      check(input.source_id === supplement.source_id && input.root_id === supplement.root_id
        && input.claim === supplement.claim && same(coverage, scope), '同源副本与现场补报的原稿、窗口或断言不符。');
      cited = [supplement.id, read.id];
      reason = 'same_source';
    } else {
      const readings = field.slots!.slice(0, material === 'partial' ? 3 : 4);
      const scope = readings.map((present, index) => ({ slot: index + 1, present }));
      const independentRoot = 'counter-log-' + field.source_id + '-' + field.sampled_tick;
      const knownFinding = readings.includes(false) ? 'gap' : readings.length === 4 ? 'continuous' : null;
      check(input.source_id === 'counter-' + field.source_id && input.root_id === independentRoot
        && originals.every(r => r.root_id !== independentRoot) && independentRoot !== field.id
        && same(coverage, scope) && input.claim === knownFinding, '独立记录的原稿、逐次覆盖或断言不符。');
      if (knownFinding === null) reason = 'partial_coverage';
    }
  }
  const judgment: StudyDecision = { tick: input.read_tick, action: reason === null ? 'conclude' : 'insufficient',
    finding: reason === null ? read.claim : null, read_ids: [...ids, read.id], evidence_ids: cited };
  return { envelope, read, judgment, unresolvedReason: reason };
}

export function parseStrategyStudy(input: unknown): StrategyStudy {
  check(object(input) && input.kind === 'c5isr-strategy-study' && (input.schema_version === 1
    ? fields(input, studyKeys) : input.schema_version === 2 && fields(input, studyKeys + ' material')), '未知的实验类型或版本。');
  const { case_id, source_id, sampled_tick, fork_seq, fork_tick, end_tick, delivery, frames, link_events, settlement } = input;
  const material = input.material;
  check(material === 'complete' || material === 'copy' || material === 'partial'
    || (material === undefined && input.schema_version === 1), '未知的核验材料。');
  check(material === undefined || material === 'complete' || delivery === 'normal', '材料对照需要固定的常规收阅条件。');
  check(id(case_id) && id(source_id) && tick(sampled_tick) && tick(fork_tick) && sampled_tick <= fork_tick
    && tick(end_tick) && end_tick - fork_tick === 18 && tick(fork_seq) && fork_seq > 0
    && (delivery === 'normal' || delivery === 'delayed' || delivery === 'lost'), '分岔、截止或回报条件有误。');
  check(Array.isArray(frames) && frames.length === end_tick - fork_tick + 1 && Array.isArray(link_events), '共同时间线不完整。');

  let previousTick = -1, previousSeq = 0;
  let enabled: boolean | undefined;
  for (const e of link_events) {
    check(fields(e, 'tick enabled seq origin') && tick(e.tick) && e.tick >= previousTick && e.tick <= end_tick
      && typeof e.enabled === 'boolean' && e.enabled !== enabled, '链路开关时间或状态有误。');
    if (e.origin === 'recorded') {
      check(e.tick <= fork_tick && tick(e.seq) && e.seq > previousSeq && e.seq <= fork_seq, '原回放链路游标有误。');
      previousSeq = e.seq;
    } else {
      check(e.origin === 'scenario' && e.tick > fork_tick && e.tick > previousTick && e.seq === null, '分岔后的链路设定有误。');
    }
    enabled = e.enabled;
    previousTick = e.tick;
  }
  const recordedLinks = link_events.filter(e => e.origin === 'recorded');
  const scenario = link_events.filter(e => e.origin === 'scenario');
  const onlineAtFork = recordedLinks.at(-1)?.enabled ?? (scenario[0]?.tick !== fork_tick + 1);
  const expectedScenario = [];
  const change = (offset: number, enabled: boolean) => ({ tick: fork_tick + offset, enabled, origin: 'scenario', seq: null });
  if (!onlineAtFork) expectedScenario.push(change(1, true));
  if (delivery !== 'normal') expectedScenario.push(change(2, false));
  if (delivery === 'delayed') expectedScenario.push(change(11, true));
  check(same(scenario, expectedScenario), '分岔后的共同故障记录与回报条件不符。');

  check(fields(settlement, 'field_record immediate verify'), '缺少终局结算。');
  const field = readFieldRecord(settlement.field_record, source_id, sampled_tick, material);
  const first = frames[0]?.immediate;
  check(object(first) && Array.isArray(first.reports) && first.reports.length === 2, '须从当时的两份冲突报告分岔。');
  const [relay, supplement]: unknown[] = first.reports;
  check(isReadReport(relay) && isReadReport(supplement) && relay.kind === 'relay' && supplement.kind === 'supplement'
    && relay.source_id === source_id && supplement.source_id === source_id && relay.sampled_tick === sampled_tick
    && supplement.sampled_tick === sampled_tick && relay.read_tick! < supplement.read_tick! && supplement.read_tick === fork_tick
    && relay.id !== supplement.id && relay.root_id !== supplement.root_id && relay.root_id !== relay.id
    && supplement.root_id === supplement.id && supplement.root_sampled_tick === sampled_tick
    && relay.claim !== supplement.claim, '两份原始报告的阅读时间、来源或说法不符。');
  const reports = [relay, supplement];
  const ids = reports.map(r => r.id);
  const immediate: BranchFrame = { reports, decisions: [{ tick: fork_tick, action: 'conclude', finding: supplement.claim,
    read_ids: ids, evidence_ids: [supplement.id] }] };
  const request = { tick: fork_tick, action: 'request_verification' as const, finding: null, read_ids: ids, evidence_ids: ids };
  const finalInbox = frames.at(-1)?.verify?.reports;
  check(Array.isArray(finalInbox) && finalInbox.length === (delivery === 'lost' ? 2 : 3), '核验回报与送达条件不符。');
  const reply = delivery === 'lost' ? null : reviewReply(finalInbox[2], material, delivery, fork_tick, end_tick, field, reports, case_id);

  for (const [index, frame] of frames.entries()) {
    const at = fork_tick + index;
    const verify: BranchFrame = { reports: [...reports], decisions: [request] };
    if (reply && at >= reply.envelope.received_tick) {
      const opened = at >= reply.judgment.tick;
      verify.reports.push(opened ? reply.read : reply.envelope);
      if (opened) verify.decisions.push(reply.judgment);
    }
    check(fields(frame, 'tick immediate verify') && frame.tick === at && same(frame.immediate, immediate)
      && same(frame.verify, verify), 'T+' + at + ' 的已读清单、冻结引用或收件状态与当时记录不符。');
  }
  const decided = reply?.judgment.action === 'conclude' ? reply.judgment.tick : null;
  const reason = reply ? reply.unresolvedReason : 'not_received';
  check(same(settlement.immediate, { wrong: Number(supplement.claim !== field.finding), unresolved: 0,
    wait_ticks: 0, verification_requests: 0, decision_tick: fork_tick, ...(material && { unresolved_reason: null }) })
    && same(settlement.verify, { wrong: Number(decided !== null && reply?.judgment.finding !== field.finding),
      unresolved: Number(decided === null), wait_ticks: (decided ?? end_tick) - fork_tick, verification_requests: 1,
      decision_tick: decided, ...(material && { unresolved_reason: reason }) }), '误判、未决、等待步数或核验次数与判断记录不符。');
  return input as unknown as StrategyStudy;
}

/** Attachments must match the parent experiment at the rule event, even if a human judged later in the same tick. */
export function parseStudyAttachments(input: unknown, decisions: DecisionEvent[], history: Frame[]): StrategyStudy[] {
  check(Array.isArray(input) && input.length <= history.length * 5, '策略附件数量有误。');
  const studies = input.map(parseStrategyStudy);
  const groups = new Map<number, StrategyStudy[]>();
  for (const study of studies) {
    const anchor = decisions.find(e => e.seq === study.fork_seq);
    check(anchor?.kind === 'desk_judged' && anchor.proposal_id === study.case_id && anchor.tick === study.fork_tick
      && anchor.desk_judgment?.actor === 'rule' && anchor.desk_judgment.finding === 'conflict', '找不到原审核席的规则冲突。');
    const frame = history.find(f => f.tick === anchor.tick);
    const link = frame?.links.find(l => l.from === study.source_id);
    check(frame && link && frame.link_changes && (frame.decision_seq ?? 0) >= anchor.seq, '缺少原分岔帧或链路记录。');
    const prefix = decisions.filter(e => e.proposal_id === study.case_id && e.kind === 'desk_read' && e.seq < anchor.seq)
      .map(e => ({ ...e.desk_report, read_tick: e.tick }));
    check(same(study.frames[0].immediate.reports, prefix), '分岔材料与当时实际阅读的原件有出入。');
    const recorded = history.flatMap(f => (f.link_changes ?? []).filter(c => c.link_id === link.id && c.seq <= anchor.seq
      && c.before.enabled !== c.after.enabled).map(c => ({ tick: f.tick, seq: c.seq, origin: 'recorded', enabled: c.after.enabled })));
    check(same(recorded, study.link_events.filter(e => e.origin === 'recorded' && e.tick >= history[0].tick)), '共同链路记录与原回放有出入。');
    const atFork = frame.link_changes.find(c => c.seq > anchor.seq && c.link_id === link.id)?.before.enabled ?? link.enabled;
    const earlyRecovery = study.link_events.some(e => e.origin === 'scenario' && e.tick === anchor.tick + 1 && e.enabled);
    check(atFork === !earlyRecovery, '分岔时的链路状态与原回放有出入。');
    const group = groups.get(anchor.seq) ?? [];
    check(!group.some(s => s.delivery === study.delivery && s.material === study.material)
      && (!group.length || same(group[0].settlement.field_record, study.settlement.field_record)),
      '同一冲突的条件重复或现场底稿不一致。');
    const paired = group.find(s => s.delivery === study.delivery);
    check(!paired || same(paired.link_events, study.link_events), '材料对照的共同故障时间线不一致。');
    group.push(study);
    groups.set(anchor.seq, group);
  }
  return studies;
}
