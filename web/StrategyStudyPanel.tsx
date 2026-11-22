import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, GitBranch, GitFork } from 'lucide-react';
import type { BranchFrame, Delivery, StrategyStudy, StudyReport } from '../contracts/strategy';
import { request } from './api';
import { parseStrategyStudy } from './strategyArchive';
import { strategyAtCursor } from './strategyStudy';
import './strategy-study.css';

export type StudyAccess =
  | { mode: 'live'; runId: string; online: boolean }
  | { mode: 'archive'; studies: StrategyStudy[] };

const deliveries: Record<Delivery, string> = { normal: '常规送达', delayed: '延迟送达', lost: '未送达' };
const kindLabel: Record<StudyReport['kind'], string> = { relay: '断链转述', supplement: '现场补报', verification: '独立核验' };
const claimLabel = { continuous: '采样连续', gap: '采样有缺口' };
const time = (tick: number) => 'T+' + tick;

function Reports({ reports }: { reports: StudyReport[] }) {
  return <ul className="study-reports">{reports.map(report => {
    const read = report.read_tick !== null;
    return <li key={report.id}>
      <div className="study-report-head"><strong>{kindLabel[report.kind]}</strong><span className={read ? 'study-read' : 'study-pending'}>{read ? '已读' : '待阅'}</span></div>
      <code>{report.id}</code>
      <p>{time(report.sampled_tick)} 所述时刻 · {time(report.received_tick)} 收件{report.read_tick !== null && <> · {time(report.read_tick)} 阅读</>}</p>
      {read && report.claim !== null && <><p className="study-statement">{claimLabel[report.claim]}</p>
        <p>来源 <code>{report.source_id}</code> · 原稿 <code>{report.root_id}</code> · {time(report.root_sampled_tick)} 采样</p></>}
    </li>;
  })}</ul>;
}

function Branch({ value, verify }: { value: BranchFrame; verify: boolean }) {
  const conclusion = value.decisions.find(d => d.action === 'conclude');
  return <section className={`study-branch ${verify ? 'study-verify' : 'study-immediate'}`} aria-label={verify ? '请求独立核验分支' : '立即判断分支'}>
    <header><GitBranch size={18} /><h2>{verify ? '请求独立核验' : '立即判断'}</h2></header>
    <div className="study-branch-body">
      <p className="study-rule">{verify ? '读完独立计数器的核验回报后作出判断。' : '出现冲突时采用现场补报，立即作出判断。'}</p>
      <div className="study-finding"><small>截至本步</small><strong>{conclusion?.finding ? claimLabel[conclusion.finding] : '等待核验 · 尚未判断'}</strong></div>
      <h3>判断与引用</h3>
      {value.decisions.map(d => <section className="study-decision" key={d.tick + d.action}>
        <div className="study-decision-title"><strong>{d.action === 'request_verification' ? '请求核验' : '形成判断'}</strong><span>{time(d.tick)}</span></div>
        <p>当时已读 {d.read_ids.length} 份 · 实际引用 {d.evidence_ids.length} 份</p>
        <ul>{d.read_ids.map(id => {
          const report = value.reports.find(r => r.id === id);
          const cited = d.evidence_ids.includes(id);
          return <li key={id}>
            <div><code>{id}</code>{report && report.claim !== null && report.read_tick !== null &&
              <small>{kindLabel[report.kind]} · {claimLabel[report.claim]} · {time(report.read_tick)} 已读</small>}</div>
            <span className={cited ? 'study-cited' : 'study-uncited'}>{cited ? '实际引用' : '已读未引用'}</span>
          </li>;
        })}</ul>
      </section>)}
      <h3>报告收件箱 <small>已读 {value.reports.filter(r => r.read_tick !== null).length} / 已收 {value.reports.length}</small></h3>
      <Reports reports={value.reports} />
    </div>
  </section>;
}

function Settlement({ settlement }: { settlement: StrategyStudy['settlement'] }) {
  const { field_record: record, immediate, verify } = settlement;
  return <section className="study-settlement" aria-label="现场底稿与策略结算">
    <div><h2>现场底稿与结算</h2>
      <p className="study-ground-truth">{time(record.sampled_tick)} · {claimLabel[record.finding]}</p>
      <p>现场记录 <code>{record.id}</code> · 来源 <code>{record.source_id}</code></p>
      <p>应有 {record.expected_samples} 份样本，实有 {record.recorded_samples} 份。</p>
    </div>
    <div className="study-table-scroll"><table><caption>两条策略的最终结果</caption>
      <thead><tr><th scope="col">指标</th><th scope="col">立即判断</th><th scope="col">请求独立核验</th></tr></thead>
      <tbody>
        <tr><th scope="row">误判</th><td>{immediate.wrong} 次</td><td>{verify.wrong} 次</td></tr>
        <tr><th scope="row">截止时未决</th><td>{immediate.unresolved} 件</td><td>{verify.unresolved} 件</td></tr>
        <tr><th scope="row">分岔后等待</th>{[immediate, verify].map((s, index) => <td key={index}>{s.wait_ticks} 步{ s.unresolved ? '（截至终局）' : ''}</td>)}</tr>
        <tr><th scope="row">核验请求</th><td>{immediate.verification_requests} 次</td><td>{verify.verification_requests} 次</td></tr>
      </tbody></table></div>
    <p className="study-delta">请求核验比立即判断多等 <b>{verify.wait_ticks - immediate.wait_ticks} 步</b>，多发起 <b>{verify.verification_requests - immediate.verification_requests} 次核验</b>。{verify.unresolved > 0 && '截至终局仍未形成判断。'}</p>
  </section>;
}

function save(study: StrategyStudy) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(study, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = `c5isr-review-${study.fork_tick}-${study.delivery}.json`; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function StrategyStudyPanel({ study, onClose, returnLabel = '返回审核席' }: { study: StrategyStudy; onClose: () => void; returnLabel?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  const { frame, terminal, links, settlement } = strategyAtCursor(study, index, reveal);
  const seek = (next: number) => { setIndex(next); setReveal(false); };
  return createPortal(<dialog ref={dialog} className="study-dialog" aria-labelledby="study-title" onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="study-wrap">
      <header className="study-mast"><div><GitFork size={21} /><h1 id="study-title">同一次断链，两种审核策略</h1></div>
        <button type="button" onClick={onClose} autoFocus><ArrowLeft size={15} />{returnLabel}</button></header>
      <p className="study-context">分岔 {time(study.fork_tick)} · #{study.fork_seq}　{study.case_id}　{study.source_id} · 复核 {time(study.sampled_tick)} 的采样记录</p>
      <section className="study-timeline" aria-label="两条策略共用的时间轴">
        <div className="study-current"><small>共同游标</small><strong>{time(frame.tick)}</strong></div>
        <button type="button" aria-label="上一策略帧" disabled={index === 0} onClick={() => seek(index - 1)}><ChevronLeft size={17} /></button>
        <label><span>{time(study.fork_tick)}<span>{time(study.end_tick)}</span></span>
          <input type="range" aria-label="策略对照时间轴" min={0} max={study.frames.length - 1} value={index} onChange={e => seek(Number(e.target.value))} /></label>
        <button type="button" aria-label="下一策略帧" disabled={terminal} onClick={() => seek(index + 1)}><ChevronRight size={17} /></button>
        <button className="study-end" type="button" onClick={() => seek(study.frames.length - 1)} disabled={terminal}>到结算步</button>
      </section>
      <section className="study-links" aria-label="共同故障时间线"><strong>共同链路记录</strong>{links.map((e,i) => <span key={i}>{time(e.tick)}{e.seq !== null ? ' · #' + e.seq : ''} {e.enabled ? '在线' : '中断'}<small>{e.origin === 'scenario' ? '实验设定' : '原回放'}</small></span>)}</section>
      {terminal && (settlement ? <><Settlement settlement={settlement} />
        <button className="study-export" type="button" onClick={() => save(study)}><Download size={14} />导出策略回放</button></> :
        <div className="study-reveal"><span>{time(study.end_tick)} 两条分支均已到达结算时点。</span><button type="button" onClick={() => setReveal(true)}>揭示现场底稿并结算</button></div>)}
      <div className="study-pair"><Branch value={frame.immediate} verify={false} /><Branch value={frame.verify} verify /></div>
    </div></dialog>, document.body);
}

export function StrategyEntry({ access, caseId, seq }: { access: StudyAccess; caseId: string; seq: number }) {
  const stored = access.mode === 'archive' ? access.studies.filter(s => s.case_id === caseId && s.fork_seq === seq) : [];
  const choices = access.mode === 'archive' ? stored.map(s => s.delivery) : Object.keys(deliveries) as Delivery[];
  const [chosen, setChosen] = useState<Delivery>('normal');
  const selected = choices.includes(chosen) ? chosen : choices[0];
  const [opened, setOpened] = useState<StrategyStudy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!selected) return <p className="desk-footnote">这份归档没有保存该冲突的策略对照。</p>;
  async function open() {
    setError(null); setBusy(true);
    try {
      const data = access.mode === 'archive' ? stored.find(s => s.delivery === selected)! :
        parseStrategyStudy(await request('/api/strategy-study', { run_id: access.runId, case_id: caseId, conflict_seq: seq, delivery: selected }, { timeoutMs: 10000 }));
      setOpened(data);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <section className="study-entry" aria-label="冲突策略对照">
    <label>核验回报条件 <select aria-label="核验回报条件" value={selected} onChange={e => setChosen(e.target.value as Delivery)}>
      {choices.map(d => <option key={d} value={d}>{deliveries[d]}</option>)}</select></label>
    <button type="button" onClick={() => void open()} disabled={busy || (access.mode === 'live' && !access.online)}><GitFork size={15} />{busy ? '正在读取…' : '从此次冲突比较策略'}</button>
    {error && <p role="alert">{error}</p>}
    {opened && <StrategyStudyPanel study={opened} onClose={() => setOpened(null)} />}
  </section>;
}
