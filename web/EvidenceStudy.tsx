import { useState } from 'react';
import { BarChart3, ChevronRight, ExternalLink, GitBranch, ListChecks } from 'lucide-react';
import type { BatchRow, LabArchive, LabBranch, LabConfig, LabMetrics } from '../contracts/evidence';
import { DecisionRecord, tickLabel } from './EvidenceReader';

export const branchLabels: Record<LabBranch, string> = { immediate: 'A · 直接判断', review: 'B · 请求复核' };
const branches: LabBranch[] = ['immediate', 'review'];
const metrics: { key: keyof LabMetrics; label: string; unit: string }[] = [
  { key: 'conflict_ticks', label: '已阅证据冲突持续', unit: '步' },
  { key: 'corrected_approvals', label: '引用后来更正材料的审批', unit: '次' },
  { key: 'review_requests', label: '额外复核请求', unit: '次' },
];

export function BranchComparison({ archive, tick, onRead }: {
  archive: LabArchive; tick: number; onRead: (branch: LabBranch) => void;
}) {
  const frames = { immediate: archive.immediate.frames[tick], review: archive.review.frames[tick] };
  const reportIds = Array.from(new Set(branches.flatMap(branch => frames[branch].reports.map(report => report.id)))).sort();
  return <section className="lab-panel">
    <div className="lab-panel-heading"><h2><GitBranch size={17} />同帧对照</h2><span>分岔于 {tickLabel(archive.fork_tick)}</span></div>
    <p className="lab-hint">两组共享采集器事件和基础报告。指标累计到 {tickLabel(tick)}，更正经审核席阅读后才进入统计。</p>
    <div className="lab-table-wrap"><table className="lab-table">
      <caption className="lab-sr">截至当前回放帧的成对指标</caption>
      <thead><tr><th>审核指标</th>{branches.map(branch => <th key={branch}>{branchLabels[branch]}</th>)}</tr></thead>
      <tbody>{metrics.map(m => <tr key={m.key}><th scope="row">{m.label}</th>{branches.map(branch => <td key={branch}>{frames[branch].metrics[m.key]} {m.unit}</td>)}</tr>)}</tbody>
    </table></div>
    {reportIds.length > 0 && <div className="lab-table-wrap"><table className="lab-table">
      <caption>同一报告的收件与阅读</caption>
      <thead><tr><th>报告</th>{branches.map(branch => <th key={branch}>{branchLabels[branch]}</th>)}</tr></thead>
      <tbody>{reportIds.map(id => <tr key={id}><th scope="row"><code>{id}</code></th>{branches.map(branch => {
        const report = frames[branch].reports.find(row => row.id === id);
        return <td key={branch}>{report ? `${tickLabel(report.received_tick)} 收 · ${report.read_tick === null ? '待阅' : tickLabel(report.read_tick) + ' 阅'}` : '尚未收件'}</td>;
      })}</tr>)}</tbody>
    </table></div>}
    <div className="lab-branch-pair">{branches.map(branch => {
      const frame = frames[branch];
      return <section className="lab-branch-record" key={branch}>
        <div className="lab-row-title"><h3>{branchLabels[branch]}</h3>
          <button className="lab-text-button" onClick={() => onRead(branch)}>查看审核席<ChevronRight size={13} /></button></div>
        <p className="lab-hint">已收 {frame.reports.length} · 待阅 {frame.queue_ids.length} · 有效独立来源 {frame.independent_roots.length}</p>
        {frame.decisions.length ? frame.decisions.map((d, i) => <DecisionRecord key={i} decision={d} />)
          : <p className="lab-empty">截至本帧暂无审批。</p>}
      </section>;
    })}</div>
  </section>;
}

function seedReplayLink(seed: number, config: LabConfig) {
  const params = new URLSearchParams({ view: 'evidence', seed: String(seed), read_interval: String(config.read_interval) });
  if (config.fork_tick != null) params.set('fork_tick', String(config.fork_tick));
  return '/?' + params.toString();
}

export function BatchStudy({ rows, config, tick, end, readOnly, pending, run, seekEnd }: {
  rows: BatchRow[]; config: LabConfig; tick: number; end: number; readOnly: boolean; pending: boolean;
  run: (count: number) => void; seekEnd: () => void;
}) {
  const [count, setCount] = useState('8');
  return <section className="lab-panel">
    <div className="lab-panel-heading"><h2><BarChart3 size={17} />多种子配对实验</h2><span>按种子配对</span></div>
    {tick !== end ? <div className="lab-empty">
      <p>各组的完整统计在本次回放的终帧展示。</p>
      <button className="lab-btn" onClick={seekEnd}>前往终帧 {tickLabel(end)}<ChevronRight size={14} /></button>
    </div> : <>
      {!readOnly && <form className="lab-batch-form" onSubmit={e => { e.preventDefault(); run(Number(count)); }}>
        <label>连续种子数<input type="number" required min={1} max={32} step={1} value={count} onChange={e => setCount(e.target.value)} /></label>
        <button className="lab-btn primary" disabled={pending} type="submit"><ListChecks size={15} />运行配对实验</button>
        <span className="lab-hint">{config.cited_ids?.length ? '本次单种子含人工引用。配对实验各组统一采用规则基线选取依据。' : '各组使用当前审核节奏与分岔设置，依据由规则基线选取。'}</span>
      </form>}
      {rows.length === 0 ? <p className="lab-empty">{readOnly ? '这份归档没有保存多种子结果。' : '尚未运行多种子实验。'}</p> : <>
        <div className="lab-batch-means">{metrics.map(m => {
          const mean = (branch: LabBranch) => (rows.reduce((total, row) => total + row[branch][m.key], 0) / rows.length).toFixed(2);
          return <div key={m.key}><small>{m.label} · 每组均值</small><strong>A {mean('immediate')} <i>/</i> B {mean('review')}</strong></div>;
        })}</div>
        <div className="lab-table-wrap"><table className="lab-table"><caption>{rows.length} 个种子 · 单元格依次为 A / B</caption>
          <thead><tr><th>种子</th>{metrics.map(m => <th key={m.key}>{m.label}（{m.unit}）</th>)}{!readOnly && <th>新页重演</th>}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.seed}><th scope="row"><code>{row.seed}</code></th>{metrics.map(m =>
            <td key={m.key}>{row.immediate[m.key]} / {row.review[m.key]}</td>)}{!readOnly && <td>
            <a className="lab-text-button" href={seedReplayLink(row.seed, config)} target="_blank" rel="noopener noreferrer"
              aria-label={`在新标签页重演种子 ${row.seed}`}>重演<ExternalLink size={13} /></a>
          </td>}</tr>)}</tbody>
        </table></div>
      </>}
    </>}
  </section>;
}
