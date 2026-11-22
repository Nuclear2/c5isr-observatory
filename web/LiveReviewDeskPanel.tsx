import { useState } from 'react';
import { BookOpen, History, Inbox } from 'lucide-react';
import type { DecisionEvent, Frame } from '../contracts/state';
import { decisionKindNames, eventsAtFrame } from './decisions';
import { reviewCases } from './liveReviewDesk';
import type { DeskEntry, FrozenJudgment, ReviewCase } from './liveReviewDesk';
import { StrategyEntry, type StudyAccess } from './StrategyStudyPanel';
import './live-review-desk.css';

const at = (t: number) => `T+${t}`;
const claims = { continuous: '采样连续', gap: '采样有缺口', conflict: '证据冲突，待核实' };
const kindLabel = (e: DeskEntry) => e.report.kind === 'relay' ? '断链转述' : '现场补报';
type Submit = (caseId: string, expectedReadSeq: number, evidenceIds: string[]) => void;

function ReportRow({ entry }: { entry: DeskEntry }) {
  const { report, readTick } = entry;
  return <li className="desk-report">
    <div className="desk-line"><strong>{kindLabel(entry)}</strong><span className={readTick === null ? 'desk-pending' : 'desk-read'}>{readTick === null ? '待阅' : '已读'}</span></div>
    <code>{report.id}</code>
    <div className="desk-times"><span>描述时刻 {at(report.sampled_tick)}</span><span>收件 {at(report.received_tick)}</span><span>阅读 {readTick === null ? '—' : at(readTick)}</span></div>
    {readTick !== null && report.claim && <>
      <p className="desk-claim">{claims[report.claim]}</p>
      <p>{report.kind === 'relay' ? '转引的缓存原稿' : '现场采集原稿'} <code>{report.root_id}</code> · 采样 {at(report.root_sampled_tick)}</p>
    </>}
  </li>;
}

function JudgmentRow({ record }: { record: FrozenJudgment }) {
  const { judgment } = record;
  return <details className="desk-judgment">
    <summary>
      <span>{at(record.tick)} · {judgment.actor === 'human' ? '人工判断' : '规则判断'}</span>
      <strong className={judgment.finding === 'conflict' ? 'desk-conflict' : ''}>{claims[judgment.finding]}</strong>
      <small>已读 {judgment.read_ids.length} 份 · 引用 {judgment.evidence_ids.length} 份</small>
    </summary>
    <ul aria-label="判断时已读材料与实际引用">{judgment.read_ids.map(id => {
      const entry = record.read.find(item => item.report.id === id);
      return <li key={id}>
        <div className="desk-line"><code>{id}</code><strong>{judgment.evidence_ids.includes(id) ? '实际引用' : '已读未引用'}</strong></div>
        {entry && entry.report.claim !== null && entry.readTick !== null && <>
          <p>{kindLabel(entry)} · {claims[entry.report.claim]} · {at(entry.readTick)} 已读</p>
          <p>原稿 <code>{entry.report.root_id}</code> · 采样 {at(entry.report.root_sampled_tick)}</p>
        </>}
      </li>;
    })}</ul>
  </details>;
}

function ManualJudgment({ item, submit, disabled }: { item: ReviewCase; submit: Submit; disabled: boolean }) {
  const [ids, setIds] = useState<string[]>([]);
  const read = item.entries.filter(entry => entry.readSeq !== null);
  const recorded = item.judgments.some(j => j.seq > item.lastReadSeq && j.judgment.actor === 'human');
  if (!read.length) return null;
  if (recorded) return <p className="desk-footnote">本轮已读材料的人工判断已记录。</p>;
  return <fieldset className="desk-manual" disabled={disabled}><legend>人工指定判断依据</legend>
    {read.map(e => <label key={e.report.id}><input type="checkbox" checked={ids.includes(e.report.id)} onChange={event =>
      setIds(event.target.checked ? [...ids, e.report.id] : ids.filter(id => id !== e.report.id))} />
      <span>{kindLabel(e)} · <code>{e.report.id}</code></span>
    </label>)}
    <button type="button" disabled={!ids.length} onClick={() => submit(item.id, item.lastReadSeq, ids)}>按所选报告记录判断</button>
  </fieldset>;
}

export default function LiveReviewDesk({ log, frame, version, historical, cursor, onCursorChange, onSubmit, strategy, disabled = true }: {
  log?: DecisionEvent[]; frame: Frame; version?: 1; historical: boolean;
  cursor: number | null; onCursorChange: (seq: number | null) => void; onSubmit?: Submit; strategy?: StudyAccess; disabled?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (version !== 1 || !log || frame.decision_seq === undefined) {
    return <div className="empty-state"><History size={24} /><strong>审核席未记录</strong><p>这份数据没有保存审核席的阅读时间和判断依据。</p></div>;
  }
  const frameEvents = eventsAtFrame(log, frame);
  const cutoff = historical ? cursor : null;
  const recordedCases = new Set(frameEvents.filter(event => event.kind === 'desk_received').map(event => event.proposal_id));
  const deskEvents = frameEvents.filter(event => event.tick === frame.tick && (event.kind.startsWith('desk_')
    || event.kind === 'received' && recordedCases.has(event.proposal_id)));
  const selectedEvent = cutoff === null ? 'end' : String(deskEvents.filter(event => event.seq <= cutoff).length);
  const cases = reviewCases(cutoff === null ? frameEvents : frameEvents.filter(event => event.seq <= cutoff));
  const item = cases.find(candidate => candidate.id === selectedId) ?? cases[0];
  const fork = item?.judgments.find(j => j.judgment.actor === 'rule' && j.judgment.finding === 'conflict');
  const read = item?.entries.filter(e => e.readTick !== null) ?? [];
  const findings = new Set(read.map(e => e.report.claim));
  const conflict = findings.size > 1;
  const receipt = item?.centerReceipt;
  const source = item?.entries[0].report.source_id;
  const sourceLabel = frame.units.find(u => u.id === source)?.model_label ?? source;
  return <section className="live-desk" aria-label="审核席收件与判断">
    {historical && <div className="decision-cursor"><label>审核席记录截止
      <select aria-label="同一步内的决策事件截止位置" value={deskEvents.length ? selectedEvent : 'end'} onChange={event => {
        const value = event.target.value;
        onCursorChange(value === 'end' ? null : value === '0' ? deskEvents[0].seq - 1 : deskEvents[Number(value) - 1].seq);
      }}>
        <option value="end">本步结束</option>
        {!!deskEvents.length && <option value="0">本步首条审核席记录前</option>}
        {deskEvents.map((event, index) => <option key={event.seq} value={index + 1}>{index + 1} · {decisionKindNames[event.kind]}</option>)}
      </select></label></div>}
    {item ? <>
      <div className="desk-line desk-heading"><h3><Inbox size={15} />采集连续性复核</h3><small>{at(frame.tick)}</small></div>
      <label className="desk-case">关联补报任务
        <select aria-label="审核席复核任务" value={item.id} onChange={e => setSelectedId(e.target.value)}>{cases.map(c => <option key={c.id} value={c.id}>{c.id} · {at(c.entries[0].report.sampled_tick)}</option>)}</select>
      </label>
      <div className="desk-line"><span>{sourceLabel} · {at(item.entries[0].report.sampled_tick)}</span>
        <span className={conflict ? 'desk-conflict' : 'desk-read'}>{conflict ? '已读证据冲突' : !read.length ? '等待阅读' : read.length === 1 ? '单份报告 · 暂定' : '已读报告一致'}</span>
      </div>
      {item.entries[0].expected && <p className="desk-footnote">中心根据已发出的采样请求，预计现场在 {at(item.entries[0].report.sampled_tick)} 采样。</p>}
      <p className="desk-footnote">{receipt ? <>中心于 {at(receipt.receivedTick)} 收到 <code>{receipt.id}</code>，信封记载现场于 {at(receipt.sampledTick)} 采样。</> : '中心尚未收到现场采样回执。'}</p>
      {fork && strategy && <StrategyEntry key={`${item.id}-${fork.seq}`} access={strategy} caseId={item.id} seq={fork.seq} />}
      <h4>审核席收件箱 <small>已读 {read.length} / 已收 {item.entries.length}</small></h4>
      <ul className="desk-inbox">{item.entries.map(entry => <ReportRow key={entry.report.id} entry={entry} />)}</ul>
      <h4><BookOpen size={14} />判断记录 <small>{item.judgments.length} 条</small></h4>
      {item.judgments.length ? [...item.judgments].reverse().map(record => <JudgmentRow key={record.seq} record={record} />) :
        <p className="desk-footnote">截至所示时点尚无判断。</p>}
      {!historical && onSubmit && <ManualJudgment key={`${item.id}-${item.lastReadSeq}`} item={item} submit={onSubmit} disabled={disabled} />}
    </> : <div className="empty-state"><Inbox size={24} /><strong>审核席尚未收件</strong><p>{historical ? '所选时点没有已收的断链转述。' : '断链时批准补充采样，可在此查看中心转述和随后收到的现场补报。'}</p></div>}
  </section>;
}
