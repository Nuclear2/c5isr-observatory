import { useState } from 'react';
import { BookOpen, FileText, Inbox, Link2, ShieldCheck } from 'lucide-react';
import type { LabClaim, LabDecision, LabFrame, LabReport } from '../contracts/evidence';

export const tickLabel = (tick: number) => `T+${tick}`;
const claimLabels: Record<LabClaim | 'undetermined', string> = {
  normal: '采集正常', interrupted: '采样中断', undetermined: '待核实',
};
const kindLabels: Record<LabReport['kind'], string> = {
  direct: '原始观察', relay: '转述', self_check: '独立自检', correction: '更正', clarification: '复核回报',
};

export function DecisionRecord({ decision, onInspect }: {
  decision: LabDecision; onInspect?: (id: string) => void;
}) {
  return <div className="lab-decision">
    <div className="lab-decision-heading"><span className="lab-mono">{tickLabel(decision.tick)}</span>
      <strong>{decision.action === 'request_review' ? '暂缓判断，批准复核' : `批准结论 · ${claimLabels[decision.claim]}`}</strong>
      <span>{decision.actor === 'human' ? '人工指定依据' : '规则基线'}</span></div>
    <dl className="lab-facts">
      <dt>审批时已阅</dt><dd className="lab-mono">{decision.read_ids.join(' · ') || '无'}</dd>
      <dt>实际引用</dt><dd>{decision.evidence_ids.map(id => onInspect
        ? <button className="lab-id-link" key={id} onClick={() => onInspect(id)}>{id}</button>
        : <code key={id}>{id} </code>)}</dd>
      <dt>引用的独立来源</dt><dd className="lab-mono">{decision.independent_roots.join(' · ') || '无'}</dd>
    </dl>
  </div>;
}

function ReportDetail({ report, frame, onInspect }: { report: LabReport; frame: LabFrame; onInspect: (id: string) => void }) {
  const link = (id: string) => frame.reports.some(row => row.id === id)
    ? <button className="lab-id-link" onClick={() => onInspect(id)}>{id}</button> : <code>{id}</code>;
  const amendments = frame.reports.filter(row => row.read_tick !== null && row.revises === report.id);
  return <section className="lab-report-detail" aria-label="报告详情">
    <div className="lab-row-title"><strong className="lab-mono">{report.id}</strong>
      <span>{report.source}</span></div>
    <dl className="lab-facts">
      <dt>收件</dt><dd>{tickLabel(report.received_tick)}</dd>
      <dt>审核席阅读</dt><dd>{report.read_tick === null ? '排队待阅' : tickLabel(report.read_tick)}</dd>
    </dl>
    {report.read_tick === null ? <p className="lab-hint">收件箱已登记这封报告。审核席读到后，可在对应帧查看正文和来源。</p> : <>
      <div className="lab-report-text"><strong>{kindLabels[report.kind]} · {claimLabels[report.claim]}</strong><p>{report.note}</p></div>
      <dl className="lab-facts">
        <dt>描述时段</dt><dd>{tickLabel(report.period_start)} — {tickLabel(report.period_end)}</dd>
        <dt>签发</dt><dd>{tickLabel(report.issued_tick)}</dd>
        <dt>原始来源</dt><dd>{report.root_id === report.id ? <code>{report.id}</code> : link(report.root_id)}</dd>
        {report.derived_from && <><dt>转引自</dt><dd>{link(report.derived_from)}</dd></>}
        {report.revises && <><dt>更正对象</dt><dd>{link(report.revises)}</dd></>}
        {amendments.length > 0 && <><dt>已阅更正</dt><dd>{amendments.map(row => <span key={row.id}>{link(row.id)}</span>)}</dd></>}
        <dt>本帧使用状态</dt><dd>{frame.active_ids.includes(report.id) ? '当前有效材料' : '已阅历史材料'}</dd>
      </dl>
    </>}
  </section>;
}

export function EvidenceReader({ frame, onSeek }: { frame: LabFrame; onSeek: (tick: number) => void }) {
  const [focus, setFocus] = useState<string | null>(null);
  const read = frame.reports.filter(r => r.read_tick !== null);
  const selected = frame.reports.find(r => r.id === focus) ?? read.at(-1) ?? frame.reports[0];
  return <div className="lab-reader">
    <div className="lab-panel">
      <div className="lab-panel-heading"><h2><Inbox size={17} />审核席收件箱</h2><span>{frame.reports.length} 份已收</span></div>
      {frame.reports.length === 0 ? <p className="lab-empty">截至本帧，收件箱为空。</p> :
        <div className="lab-report-list" aria-label="本帧已收报告">{frame.reports.map(report =>
          <button key={report.id} aria-pressed={selected?.id === report.id} className={selected?.id === report.id ? 'selected' : ''}
            onClick={() => setFocus(report.id)}>
            <span className={report.read_tick === null ? 'waiting' : ''}>{report.read_tick === null ? <Inbox size={15} /> : <BookOpen size={15} />}</span>
            <span className="lab-list-main"><strong>{report.source}</strong><small>{report.id} · {report.read_tick === null ? '待阅' : kindLabels[report.kind]}</small></span>
            <span className="lab-times"><small>{tickLabel(report.received_tick)} 收</small><small>{report.read_tick === null ? '等待读取' : `${tickLabel(report.read_tick)} 阅`}</small></span>
          </button>)}</div>}
      <div className="lab-queue"><strong>待阅顺序</strong><span className="lab-mono">{frame.queue_ids.join(' → ') || '队列为空'}</span></div>
    </div>
    <div className="lab-panel">
      <div className="lab-panel-heading"><h2><FileText size={17} />报告与来源</h2><span>截至 {tickLabel(frame.tick)}</span></div>
      {selected ? <ReportDetail report={selected} frame={frame} onInspect={setFocus} /> : <p className="lab-empty">报告送达后可选择查看。</p>}
    </div>
    <div className="lab-panel">
      <div className="lab-panel-heading"><h2><Link2 size={17} />已阅证据关系</h2>
        <span className={frame.conflict ? 'lab-warning' : ''}>{frame.conflict ? '来源意见冲突' : '尚无已知冲突'}</span></div>
      <p className="lab-summary"><b>{read.length}</b> 份已阅报告 <span>／</span> <b>{frame.independent_roots.length}</b> 个当前有效的独立来源</p>
      {read.length > 0 && <ul className="lab-lineage">{read.map(r => <li key={r.id}>
        <button className="lab-id-link" onClick={() => setFocus(r.id)}>{r.id}</button>
        <span>{kindLabels[r.kind]} · {claimLabels[r.claim]}</span>
        <small>{r.revises ? `更正 ${r.revises}` : r.derived_from ? `来自 ${r.derived_from}` : `原始来源 ${r.root_id}`}</small>
      </li>)}</ul>}
    </div>
    <div className="lab-panel">
      <div className="lab-panel-heading"><h2><ShieldCheck size={17} />审批时的依据</h2><span>{frame.decisions.length} 项</span></div>
      {frame.decisions.length ? frame.decisions.map((decision, i) => <DecisionRecord key={i} decision={decision} onInspect={id => {
        setFocus(id);
        onSeek(decision.tick);
      }} />)
        : <p className="lab-empty">截至本帧，审核席尚未作出决定。</p>}
    </div>
  </div>;
}
