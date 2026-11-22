import { useState } from 'react';
import { ArrowRight, Check, ChevronRight, CircleDot, History, Network, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import type { DecisionEvent, Frame, Observation, Proposal } from '../contracts/state';
import { decisionKindNames, eventsAtFrame, latestReportEvents, rebuildDecisions } from './decisions';
import type { DecisionRecord } from './decisions';

const tick = (value: number) => `T+${value.toString().padStart(4, '0')}`;
const statusNames: Record<Proposal['status'], string> = { pending: '待审批', approved: '已批准', rejected: '已驳回', executing: '执行中', completed: '执行完成', stale: '已过期' };
const actionNames: Record<Proposal['action'], string> = { review_data: '信息复核', restore_link: '链路恢复', request_observation: '请求观测', hold: '继续观察' };
const actorName = (actor: DecisionEvent['actor']) => actor === 'ai' ? 'AI 自动审核' : actor === 'human' ? '人工审核' : '审核方未记录';
const nodeName = (id: string, frame: Frame) => frame.units.find(unit => unit.id === id)?.model_label ?? id;

function subjectLabel(proposal: Proposal, frame: Frame) {
  const unit = frame.units.find(candidate => candidate.id === proposal.subject_id);
  if (unit) return `${unit.name} · ${unit.model_label}`;
  const link = frame.links.find(candidate => candidate.id === proposal.subject_id);
  if (link) return `${nodeName(link.from, frame)} → ${nodeName(link.to, frame)} · ${link.id}`;
  return proposal.subject_id === 'command' ? '全局信息协调 · command' : proposal.subject_id;
}

function EvidenceReport({ observation, frame, atTick = frame.tick, ageLabel = '所示帧信息年龄' }: { observation: Observation; frame: Frame; atTick?: number; ageLabel?: string }) {
  return <div className="evidence-report">
    <div><strong>{observation.id}</strong><span>置信度 {Math.round(observation.confidence * 100)}%</span></div>
    <p>{observation.note}</p>
    <dl><div><dt>来源</dt><dd>{nodeName(observation.source_id, frame)} <small>{observation.source_id}</small></dd></div>
      <div><dt>报告对象</dt><dd>{nodeName(observation.unit_id, frame)}</dd></div>
      <div><dt>采样 / 收到</dt><dd>{tick(observation.observed_tick)} / {tick(observation.received_tick)}</dd></div>
      <div><dt>传输延迟</dt><dd>{Math.max(0, observation.received_tick - observation.observed_tick)} tick</dd></div>
      <div><dt>{ageLabel}</dt><dd>{Math.max(0, atTick - observation.observed_tick)} tick · 截至 {tick(atTick)}</dd></div></dl>
  </div>;
}

export function DecisionEventItem({ event, frame, showProposal = false }: { event: DecisionEvent; frame: Frame; showProposal?: boolean }) {
  const review = event.kind === 'approved' || event.kind === 'rejected';
  return <li className={`decision-event kind-${event.kind}`}>
    <span className="decision-event-mark" />
    <div className="decision-event-main"><div className="decision-event-heading"><strong>{decisionKindNames[event.kind]}</strong><span>#{event.seq} · {tick(event.tick)}</span></div>
      {showProposal && <p className="decision-event-proposal">{event.proposal?.title ?? (event.proposal_id || '未关联提案')}</p>}
      {review && <p>{actorName(event.actor)}</p>}
      {event.desk_report && <p>{event.desk_report.kind === 'relay' ? '断链转述' : '现场补报'} · {event.desk_report.id}</p>}
      {event.desk_judgment && <p>{event.desk_judgment.actor === 'human' ? '人工判断' : '规则判断'} · 引用 {event.desk_judgment.evidence_ids.join('、')}</p>}
      {event.report_id && <p className="report-reference">{event.report_id}{event.sampled_tick != null && ` · 采样 ${tick(event.sampled_tick)}`}{event.kind === 'received' && ` · 实际送达 ${tick(event.tick)}`}</p>}
      {event.note && <p>{event.note}</p>}
      {['created', 'approved', 'rejected', 'received'].includes(event.kind) && <details><summary>{event.kind === 'received' ? '查看实际送达报告' : '查看该事件冻结依据'}</summary>{event.evidence == null ? <p>此事件没有保存证据正文。</p> : !event.evidence.length ? <p>该事件未附独立报告。</p> : event.evidence.filter(report => report.received_tick <= event.tick).map(report => <EvidenceReport key={report.id} observation={report} frame={frame} atTick={event.tick} ageLabel="事件发生时信息年龄" />)}</details>}
    </div>
  </li>;
}

function DecisionCard({ record, frame, historical, disabled, onReview }: { record: DecisionRecord; frame: Frame; historical: boolean; disabled: boolean; onReview?: (id: string, approve: boolean) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { proposal, evidence, events } = record;
  const review = [...events].reverse().find(event => event.kind === 'approved' || event.kind === 'rejected');
  const reports = latestReportEvents(events);
  return <article className={`proposal-card status-${proposal.status}`}>
    <div className="proposal-meta"><span className={`proposal-source ${proposal.source}`}>{proposal.source === 'codex' ? <Sparkles size={11} /> : <Network size={11} />}{proposal.source === 'codex' ? 'Codex 提案' : '规则提案'}</span><span className="proposal-tick">{tick(proposal.created_tick)}</span></div>
    <div className="proposal-title-row"><h3>{proposal.title}</h3><span className="action-tag">{actionNames[proposal.action]}</span></div>
    <span className="proposal-subject"><CircleDot size={10} />{subjectLabel(proposal, frame)}</span>
    <p className="proposal-rationale">{proposal.rationale}</p><div className="proposal-effect"><ArrowRight size={11} /><span>{proposal.expected_effect}</span></div>
    <div className="decision-review-summary"><span>{statusNames[proposal.status]}</span>{review ? <span>{actorName(review.actor)} · {tick(review.tick)} · #{review.seq}</span> : <span>{record.recorded ? '尚无审核记录' : '旧数据 · 审核过程未记录'}</span>}</div>
    {proposal.outcome && <p className="decision-outcome">{proposal.outcome}</p>}
    {proposal.action === 'request_observation' && <p className="report-semantics">执行完成表示采样 / 排队动作结束；是否送达以独立报告记录为准。</p>}
    {reports.map(report => <div className={`report-progress kind-${report.kind}`} key={report.report_id}><strong>{decisionKindNames[report.kind]}</strong><span>{report.report_id} · {tick(report.tick)}</span></div>)}
    <button className="evidence-toggle" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}><ChevronRight size={12} className={expanded ? 'rotated' : ''} /><span>冻结依据与执行过程 · {events.length} 条记录</span></button>
    {expanded && <div className="evidence-body decision-evidence"><span className="evidence-caption">{record.evidenceAt ? `${decisionKindNames[record.evidenceAt.kind]}时保存的依据 · #${record.evidenceAt.seq}` : '冻结依据'} · 不随实时观测窗口替换</span>
      {evidence === null ? <p>未保存该时点的证据正文，不能使用当前观测代替。</p> : evidence.length === 0 ? <p>本次记录未附独立观测证据。</p> : evidence.filter(report => report.received_tick <= frame.tick).map(report => <EvidenceReport key={report.id} observation={report} frame={frame} />)}
      {proposal.uncertainties.map((item, index) => <p className="uncertainty" key={index}><TriangleAlert size={11} />{item}</p>)}
      {events.length ? <ol className="decision-event-list">{events.map(event => <DecisionEventItem key={event.seq} event={event} frame={frame} />)}</ol> : <p>无决策事件记录，无法重建处理过程。</p>}
    </div>}
    {proposal.status === 'pending' && !historical && <div className="review-actions"><button className="approve-button" disabled={disabled || !onReview} onClick={() => onReview?.(proposal.id, true)}><Check size={13} />批准执行</button><button className="reject-button" disabled={disabled || !onReview} onClick={() => onReview?.(proposal.id, false)}>驳回</button></div>}
  </article>;
}

export function DecisionCutoff({ frame, events, cursor, onChange }: {
  frame: Frame; events: DecisionEvent[]; cursor: number | null; onChange: (cursor: number | null) => void;
}) {
  const end = frame.decision_seq ?? 0;
  const sameTick = events.filter(event => event.tick === frame.tick);
  return <div className="decision-cursor"><label>决策截止<select value={cursor ?? end} aria-label="同一步内的决策事件截止位置" onChange={event => {
    const seq = Number(event.target.value);
    onChange(seq === end ? null : seq);
  }}><option value={end}>帧末 · #{end}</option>
    {sameTick.length > 0 && <option value={sameTick[0].seq - 1}>本步首个保留事件前 · #{sameTick[0].seq - 1}</option>}
    {sameTick.filter(event => event.seq !== end).map(event => <option key={event.seq} value={event.seq}>#{event.seq} · {decisionKindNames[event.kind]}</option>)}
  </select></label><small>地图显示 {tick(frame.tick)} 帧末，记录截止 #{cursor ?? end}。</small></div>;
}

export default function DecisionPanel({ log, frame, historical, liveProposals = [], disabled = true, onReview, cursor = null, onCursorChange }: {
  log?: DecisionEvent[]; frame: Frame; historical: boolean; liveProposals?: Proposal[]; disabled?: boolean; onReview?: (id: string, approve: boolean) => void;
  cursor?: number | null; onCursorChange?: (cursor: number | null) => void;
}) {
  const [view, setView] = useState<'cards' | 'events'>('cards');
  const hasRecord = Array.isArray(log) && typeof frame.decision_seq === 'number' && Number.isSafeInteger(frame.decision_seq);
  const frameSeq = frame.decision_seq ?? 0;
  const frameEvents = eventsAtFrame(log, frame);
  const effectiveCursor = historical && cursor != null ? Math.min(cursor, frameSeq) : null;
  const events = eventsAtFrame(log, frame, effectiveCursor);
  const records = hasRecord ? rebuildDecisions(events) : historical ? [] : liveProposals.map(proposal => ({ proposal, events: [], evidence: null, recorded: false }));
  return <div className="decision-audit">
    <div className="decision-audit-toolbar"><div role="group" aria-label="决策记录视图"><button className={view === 'cards' ? 'active' : ''} onClick={() => setView('cards')}>建议 {records.length}</button><button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>事件 {events.length}</button></div><span>{historical ? `${tick(frame.tick)} · 历史` : '实时记录'}</span></div>
    {!hasRecord && <div className="audit-notice"><History size={13} /><span>此数据没有决策序列记录，无法回放当时的依据与审核过程。</span></div>}
    {historical && hasRecord && onCursorChange && <DecisionCutoff frame={frame} events={frameEvents} cursor={effectiveCursor} onChange={onCursorChange} />}
    {view === 'cards' ? records.length ? records.map(record => <DecisionCard key={record.proposal.id} record={record} frame={frame} historical={historical} disabled={disabled || !liveProposals.some(proposal => proposal.id === record.proposal.id && proposal.status === 'pending')} onReview={onReview} />) : <div className="empty-state"><ShieldCheck size={25} strokeWidth={1.3} /><strong>{hasRecord ? '此时尚无建议记录' : '没有可回放的建议'}</strong><p>{historical ? '只显示截止当前序号已经发生的决策。' : '推进仿真或注入链路中断，观察建议与报告传输。'}</p></div> : events.length ? <ol className="decision-event-list all-decision-events">{events.map(event => <DecisionEventItem key={event.seq} event={event} frame={frame} showProposal />)}</ol> : <div className="empty-small">此范围内没有决策事件。</div>}
  </div>;
}
