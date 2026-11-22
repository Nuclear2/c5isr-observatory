import type { DecisionEvent, DeskReport, Frame, ReportVersion } from '../contracts/state';

type Fields = Record<string, unknown>;
const object = (v: unknown): v is Fields => v !== null && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const tick = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
// A case contains the cached relay and, on successful delivery, the supplementary report.
const reportIds = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 2
  && v.every(identifier) && new Set(v).size === v.length;

export function isDeskEventPayload(event: Fields): boolean {
  const r = event.desk_report;
  const j = event.desk_judgment;
  if (event.desk_expectation_seq != null && !(event.kind === 'desk_received' && object(r) && r.kind === 'relay'
    && tick(event.desk_expectation_seq) && event.desk_expectation_seq > 0 && tick(event.seq) && event.desk_expectation_seq < event.seq)) return false;
  if (typeof event.kind === 'string' && event.kind.startsWith('desk_')
    && ['actor', 'proposal', 'evidence', 'report_id', 'sampled_tick', 'note'].some(key => event[key] != null)) return false;
  if (event.kind === 'desk_received' || event.kind === 'desk_read') {
    return j == null && object(r) && Object.keys(r).length === 8
      && identifier(r.id) && identifier(r.source_id) && identifier(r.root_id)
      && (r.kind === 'relay' || r.kind === 'supplement')
      && tick(r.sampled_tick) && tick(r.received_tick) && r.sampled_tick <= r.received_tick
      && tick(r.root_sampled_tick) && r.root_sampled_tick <= r.received_tick
      && (event.kind === 'desk_received' ? r.claim === null : r.claim === 'continuous' || r.claim === 'gap');
  }
  if (event.kind === 'desk_judged') {
    return r == null && object(j) && Object.keys(j).length === 4
      && (j.actor === 'rule' || j.actor === 'human') && ['continuous', 'gap', 'conflict'].some(f => f === j.finding)
      && reportIds(j.read_ids) && reportIds(j.evidence_ids);
  }
  return r == null && j == null;
}

function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('审核席记录有误：' + message);
}

interface DeskCase {
  source: string;
  buffered?: DecisionEvent;
  delivered?: DecisionEvent;
  relay?: DeskReport;
  supplement?: DeskReport;
  read: DeskReport[];
  humanJudged: boolean;
}

/** Whole proposal groups survive log pruning. Other groups and older cached editions may be absent. */
export function validateDeskHistory(log: DecisionEvent[], versions: ReportVersion[], last: Frame, firstTick: number) {
  const sources = new Set(last.units.filter(u => u.side === 'blue' && u.id !== 'command').map(u => u.id));
  const editions = new Map(versions.map(row => [row.report_id, row]));
  // A later delivery at the very same tick is still future evidence for an earlier event.
  const receiptSequences = new Map(log.filter(e => e.kind === 'received' && e.report_id).map(e => [e.report_id!, e.seq]));
  const subjects = new Map<string, string>();
  const approved = new Set<string>();
  const executions = new Map<string, DecisionEvent>();
  const cases = new Map<string, DeskCase>();
  const receivedIds = new Set<string>();
  const readOrigins = new Map<string, DeskReport>();
  const inbox: DeskReport[] = [];
  let nextRead = 0;
  let lastReadTick = -1;
  let awaitingRule: string | null = null;
  for (const event of log) {
    const id = event.proposal_id;
    if (awaitingRule !== null) {
      requireFact(id === awaitingRule && event.kind === 'desk_judged' && event.tick === lastReadTick
        && event.desk_judgment?.actor === 'rule', '阅读后缺少当时的规则判断。');
    }
    if (event.kind === 'created' && event.proposal?.action === 'request_observation') subjects.set(id, event.proposal.subject_id);
    if (event.kind === 'approved' && subjects.has(id)) approved.add(id);
    if (event.kind === 'executing' && approved.has(id)) executions.set(id, event);
    let current = cases.get(id);
    if (event.kind === 'desk_received' && event.desk_expectation_seq != null) {
      const execution = executions.get(id);
      const source = subjects.get(id);
      requireFact(source && sources.has(source) && execution?.seq === event.desk_expectation_seq
        && execution.tick + 1 === event.desk_report!.sampled_tick, '转述缺少对应的中心采样预期或已批准请求。');
      if (!current) {
        current = { source, read: [], humanJudged: false };
        cases.set(id, current);
      }
    }
    if (event.kind === 'buffered' && !current?.buffered) {
      const source = subjects.get(id);
      requireFact(source && sources.has(source) && identifier(event.report_id) && tick(event.sampled_tick),
        '离线缓存缺少对应的本方补报任务。');
      const issue = editions.get(event.report_id);
      requireFact(issue ? issue.proposal_id === id && issue.source_id === source && issue.sampled_tick === event.sampled_tick
        : event.sampled_tick < firstTick, '离线缓存与本事项的采样版本不一致。');
      if (current) current.buffered = event;
      else cases.set(id, { source, buffered: event, read: [], humanJudged: false });
      continue;
    }
    if (event.kind === 'received' && current) {
      requireFact(!current.delivered && (!current.buffered || event.report_id === current.buffered.report_id && event.sampled_tick === current.buffered.sampled_tick)
        && event.evidence?.some(o => o.id === event.report_id && o.source_id === current.source && o.observed_tick === event.sampled_tick
          && o.received_tick === event.tick), '补报送达事件与缓存的采样记录不一致。');
      current.delivered = event;
    }
    if (!event.kind.startsWith('desk_')) continue;
    requireFact(current, '缺少本次复核对应的采样预期或离线缓存记录。');
    if (event.kind === 'desk_received') {
      const r = event.desk_report!;
      requireFact(event.tick === r.received_tick && r.source_id === current.source
        && !receivedIds.has(r.id), '收件编号、来源、采样或送达时间不一致。');
      if (r.kind === 'relay') {
        const origin = editions.get(r.root_id);
        const issue = current.buffered?.report_id && editions.get(current.buffered.report_id);
        const prompted = event.desk_expectation_seq != null;
        requireFact(!current.relay && !editions.has(r.id) && r.id !== r.root_id && r.root_id !== current.buffered?.report_id
          && r.id !== current.buffered?.report_id && (prompted || current.buffered && r.received_tick === current.buffered.tick
            && r.sampled_tick === current.buffered.sampled_tick), '转述与原件、缓存或此前收件不一致。');
        // A rolling history may drop an old edition. Within a complete history its root must still exist.
        requireFact((!prompted || r.root_sampled_tick < r.sampled_tick) && (origin ? (!issue || origin.version < issue.version) && origin.source_id === r.source_id && origin.sampled_tick === r.root_sampled_tick
          && origin.center_received_tick !== null && origin.center_received_tick <= event.tick
          && (receiptSequences.get(r.root_id) ?? 0) < event.seq
          : r.root_sampled_tick < firstTick), '转述引用了当时中心尚未持有的原件。');
        current.relay = r;
      } else {
        requireFact(current.relay && !current.supplement && current.delivered?.tick === event.tick
          && r.id === r.root_id && r.id === current.delivered.report_id && r.sampled_tick === current.delivered.sampled_tick
          && r.root_sampled_tick === r.sampled_tick,
          '审核席补报缺少已实际送达的原件。');
        const edition = editions.get(r.id);
        requireFact(edition ? edition.source_id === current.source && edition.proposal_id === id && edition.sampled_tick === r.sampled_tick
          && edition.center_received_tick === r.received_tick : r.received_tick < firstTick, '审核席补报与双节点收件记录不一致。');
        current.supplement = r;
      }
      receivedIds.add(r.id);
      inbox.push(r);
    } else if (event.kind === 'desk_read') {
      const r = event.desk_report!;
      const header = inbox[nextRead];
      requireFact(header?.id === r.id && (r.id === current.relay?.id || r.id === current.supplement?.id)
        && header.received_tick === r.received_tick && header.sampled_tick === r.sampled_tick && header.source_id === r.source_id
        && header.root_id === r.root_id && header.root_sampled_tick === r.root_sampled_tick && header.kind === r.kind,
        '阅读记录与本事项的收件内容或队列顺序不符。');
      requireFact(r.received_tick < event.tick && event.tick % 3 === 0 && lastReadTick < event.tick, '报告阅读时刻不符合收件与阅读顺序。');
      const previousOrigin = readOrigins.get(r.root_id);
      requireFact(!previousOrigin || previousOrigin.source_id === r.source_id && previousOrigin.root_sampled_tick === r.root_sampled_tick
        && previousOrigin.claim === r.claim, '同一原件在不同阅读记录中的来源、采样时刻或说法发生改变。');
      readOrigins.set(r.root_id, r);
      nextRead++;
      lastReadTick = event.tick;
      current.read.push(r);
      current.humanJudged = false;
      awaitingRule = id;
    } else {
      const judgment = event.desk_judgment!;
      const read = current.read;
      requireFact(judgment.read_ids.length === read.length && read.every((r, i) => judgment.read_ids[i] === r.id),
        '判断时冻结的已读清单与该时刻不符。');
      const cited = judgment.evidence_ids.map(evidence => read.find(r => r.id === evidence));
      requireFact(cited.every((r): r is DeskReport => r !== undefined), '判断引用了未读报告或其他事项的报告。');
      const finding = cited.every(r => r.claim === cited[0].claim) ? cited[0].claim : 'conflict';
      requireFact(finding === judgment.finding, '冻结结论与所引报告的说法不一致。');
      if (judgment.actor === 'rule') {
        requireFact(awaitingRule === id && cited.length === read.length, '规则判断应在读件后引用本事项全部已读报告。');
        awaitingRule = null;
      } else {
        requireFact(!current.humanJudged, '同一已读版本包含重复的人工判断。');
        current.humanJudged = true;
      }
    }
  }
  requireFact(awaitingRule === null, '末次阅读缺少规则判断。');
  for (const current of cases.values()) {
    requireFact(current.relay && (!current.delivered || current.supplement), '已缓存或已送达的复核报告缺少审核席收件记录。');
    const issue = current.buffered?.report_id && editions.get(current.buffered.report_id);
    requireFact(!issue || issue.center_received_tick === (current.delivered?.tick ?? null), '中心收件台账与补报送达事件不一致。');
  }
}
