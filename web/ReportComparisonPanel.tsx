import { useState } from 'react';
import { ArrowUpRight, GitCompareArrows, History } from 'lucide-react';
import type { DecisionEvent, Frame, ReportVersion } from '../contracts/state';
import { reportMilestones, reportSeriesAtFrame } from './reportComparison';
import type { MilestoneKind } from './reportComparison';
import './report-comparison.css';

const at = (tick: number) => `T+${String(tick).padStart(4, '0')}`;
const labels: Record<MilestoneKind, string> = {
  offline: '上行链路转为离线', offline_at_start: '记录起点链路已离线', restored: '上行链路恢复', sample: '报告采样', buffered: '补报暂存',
  sent: '向中心发出', field: '现场记录席收件', center: '汇聚中心收件', dropped: '中心传输丢失', expired: '补报过期',
};

function ReceiptColumn({ side, held, selected }: {
  side: 'field' | 'center'; held: ReportVersion | null; selected: ReportVersion;
}) {
  const field = side === 'field';
  const receivedKey = field ? 'field_received_tick' : 'center_received_tick';
  const heldTick = held?.[receivedKey];
  const selectedTick = selected[receivedKey];
  return <section className={`receipt-column ${side}`} aria-label={field ? '现场记录席收件' : '汇聚中心收件'}>
    <h3>{field ? '现场记录席' : '汇聚中心'}</h3>
    <span className="receipt-label">帧末持有版本</span>
    <strong className="receipt-version">{held ? `V${held.version}` : '尚无'}</strong>
    <small className="receipt-id">{held?.report_id ?? '—'}</small>
    <span className="receipt-held-tick">{heldTick != null ? `${at(heldTick)} 收到` : '暂无收件记录'}</span>
    <div className="receipt-selected">
      <span className="receipt-label">所选 V{selected.version} 收到时间</span>
      <strong className={selectedTick === null ? 'receipt-pending' : ''}>{selectedTick === null ? '截至本帧未收' : at(selectedTick)}</strong>
    </div>
  </section>;
}

function receiptGap(report: ReportVersion, tick: number): string {
  const field = report.field_received_tick;
  const center = report.center_received_tick;
  if (field !== null && center !== null) {
    const gap = center - field;
    return gap === 0 ? '两席在同一仿真步收到此版' : `${gap > 0 ? '现场记录席' : '汇聚中心'}先收到 ${Math.abs(gap)} tick`;
  }
  if (field === null && center === null) return '两席均未收到此版';
  const elapsed = tick - (field ?? center!);
  return `仅${field !== null ? '现场记录席' : '汇聚中心'}收到此版，距今 ${elapsed} tick`;
}

interface Props {
  versions?: readonly ReportVersion[];
  frame: Frame;
  history: readonly Frame[];
  log?: readonly DecisionEvent[];
  onSeek?: (frame: Frame) => void;
}

export default function ReportComparisonPanel({ versions, frame, history, log, onSeek }: Props) {
  const [sourceChoice, setSourceChoice] = useState<string | null>(null);
  const [reportChoice, setReportChoice] = useState<string | null>(null);
  if (!versions || !history.some(item => item.tick === frame.tick)) {
    return <div className="empty-state"><History size={24} /><strong>此帧缺少双端收件记录</strong><p>{versions ? '请在保留的帧中选择一个时间点。' : '旧版数据没有分别记录两个接收节点的收件时间。'}</p></div>;
  }
  const sources = reportSeriesAtFrame(versions, frame);
  const source = sources.find(item => item.source_id === sourceChoice) ?? sources[0];
  if (!source) return <div className="empty-state"><GitCompareArrows size={24} /><strong>此帧尚无可对照报告</strong></div>;
  const selected = source.versions.find(item => item.report_id === reportChoice) ?? source.versions[0];
  const link = frame.links.find(link => link.from === source.source_id && link.to === 'command');
  const diverged = source.field?.version !== source.center?.version;
  const milestones = reportMilestones(selected, frame, history, log);
  const sourceLabel = (id: string) => frame.units.find(unit => unit.id === id)?.model_label ?? id;
  return <section className="report-comparison" aria-label="双节点收件对照">
    <div className="receipt-heading">
      <span className={diverged ? 'receipt-different' : ''}><GitCompareArrows size={14} />{diverged ? '持有版本不同' : source.field ? '持有版本一致' : '两席均未持有版本'}</span>
      <small>{at(frame.tick)} 帧末</small>
    </div>
    <div className="report-choices">
      <label>报告来源<select value={source.source_id} onChange={event => { setSourceChoice(event.target.value); setReportChoice(null); }}>
        {sources.map(item => <option key={item.source_id} value={item.source_id}>{sourceLabel(item.source_id)}</option>)}
      </select></label>
      <label>对照版本<select value={selected.report_id} onChange={event => { setSourceChoice(source.source_id); setReportChoice(event.target.value); }}>
        {source.versions.map(item => <option key={item.report_id} value={item.report_id}>V{item.version} · {item.report_id}</option>)}
      </select></label>
    </div>
    <div className="receipt-context">
      <span className="receipt-id">{selected.report_id}</span>
      <span>采样 {at(selected.sampled_tick)}</span>
      <span className={link?.enabled === false ? 'receipt-different' : ''}>上行链路{link ? link.enabled ? '在线' : '离线' : '未记录'}</span>
    </div>
    <div className="receipt-columns">
      <ReceiptColumn side="field" held={source.field} selected={selected} />
      <ReceiptColumn side="center" held={source.center} selected={selected} />
    </div>
    <p className="receipt-gap">V{selected.version} · {receiptGap(selected, frame.tick)}</p>
    <h4 className="receipt-timeline-title">传递记录</h4>
    <ol className="receipt-timeline">{milestones.map((moment, index) => {
      const recorded = history.find(item => item.tick === moment.tick);
      return <li key={`${moment.kind}-${moment.tick}-${index}`} className={`moment-${moment.kind}`}>
        <span>{labels[moment.kind]}</span>
        {onSeek && recorded && frame.tick !== moment.tick
          ? <button onClick={() => { setSourceChoice(source.source_id); onSeek(recorded); }}
              aria-label={`回看${labels[moment.kind]} ${at(moment.tick)}`}>
              {at(moment.tick)}<ArrowUpRight size={12} />
            </button>
          : <small>{at(moment.tick)}</small>}
      </li>;
    })}</ol>
  </section>;
}
