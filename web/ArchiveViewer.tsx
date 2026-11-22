import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, FileJson, History, Layers3, Network, ShieldCheck, TriangleAlert } from 'lucide-react';
import { parseArchive, parseArchiveData, MAX_ARCHIVE_BYTES } from './archive';
import type { LabArchive } from '../contracts/evidence';
import type { StrategyStudy } from '../contracts/strategy';
import { parseStrategyStudy } from './strategyArchive';
import { StrategyStudyPanel } from './StrategyStudyPanel';
import { parseEvidenceArchiveData, MAX_LAB_ARCHIVE_BYTES } from './evidenceArchive';
import EvidenceLab from './EvidenceLab';
import DecisionPanel from './DecisionPanel';
import LiveReviewDesk from './LiveReviewDeskPanel';
import ReportComparison from './ReportComparisonPanel';
import SituationMap from './SituationMap';
import { UnitInspector } from './App';

export default function ArchiveViewer() {
  const example = new URLSearchParams(window.location.search).get('example');
  const [archive, setArchive] = useState<ReturnType<typeof parseArchive> | null>(null);
  const [evidence, setEvidence] = useState<LabArchive | null>(null);
  const [study, setStudy] = useState<StrategyStudy | null>(null);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState<string | null>(example !== null && example !== 'two-node' ? '找不到指定的回放示例。' : null);
  const [loading, setLoading] = useState(example === 'two-node');
  const [index, setIndex] = useState(0);
  const [decisionCursor, setDecisionCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'decisions' | 'inspector' | 'compare' | 'desk'>('decisions');
  const [links, setLinks] = useState(true);
  const [labels, setLabels] = useState(true);
  function seek(index: number) {
    setIndex(index);
    setDecisionCursor(null);
  }
  useEffect(() => {
    if (example !== 'two-node') return;
    const controller = new AbortController();
    async function openExample() {
      try {
        const response = await fetch('/examples/two-node-replay.json', {
          signal: controller.signal, mode: 'same-origin', credentials: 'omit', redirect: 'error',
        });
        if (!response.ok) throw new Error(`读取随包示例失败（HTTP ${response.status}）。`);
        const parsed = parseArchive(await response.text());
        if (controller.signal.aborted) return;
        const start = parsed.history.findIndex(frame => frame.tick === 8);
        if (start < 0) throw new Error('随包示例缺少 T+8 对照帧。');
        setArchive(parsed);
        setFilename('双节点断链补报示例');
        seek(start);
        setView('compare');
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void openExample();
    return () => controller.abort();
  }, [example]);
  const frame = archive?.history[index];
  const unit = frame?.units.find(candidate => candidate.id === selected && (candidate.side === 'blue' || candidate.contact && candidate.contact.first_seen_tick <= frame.tick && candidate.contact.expires_tick > frame.tick));
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null); setLoading(true);
    try {
      if (file.size > MAX_ARCHIVE_BYTES) throw new Error(`文件超过 ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MiB 限制。`);
      let data: unknown;
      try { data = JSON.parse(await file.text()); }
      catch { throw new Error('无法读取 JSON，请选择完整的实验归档。'); }
      if (data && typeof data === 'object' && 'kind' in data && data.kind === 'c5isr-evidence-lab') {
        if (file.size > MAX_LAB_ARCHIVE_BYTES) throw new Error('报告复核归档超过 8 MiB 上限。');
        setEvidence(parseEvidenceArchiveData(data));
        return;
      }
      if (data && typeof data === 'object' && 'kind' in data && data.kind === 'c5isr-strategy-study') {
        setStudy(parseStrategyStudy(data));
        return;
      }
      const parsed = parseArchiveData(data);
      if (!parsed.history.length) throw new Error('文件没有可回放的历史帧。');
      setArchive(parsed); setFilename(file.name); seek(0); setSelected(null); setView('decisions');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  if (evidence) return <EvidenceLab initialArchive={evidence} />;
  return <div className="archive-shell">
    <header className="archive-header">
      <div><span className="eyebrow">C5ISR / ARCHIVE REPLAY</span><h1>本地实验回放</h1></div>
      <span className="archive-readonly"><ShieldCheck size={14} />只读 · 不连接实时系统</span>
      <label className={`archive-file-button ${loading ? 'loading' : ''}`}><FileJson size={16} />{loading ? '读取中…' : '选择实验 JSON'}
        <input type="file" accept=".json,application/json" disabled={loading} aria-label="选择本地实验 JSON 文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void readFile(file); }} />
      </label>
      <a className="archive-readonly" href="/?view=evidence&amp;example=collector"><History size={14} />报告复核示例</a>
      <a className="archive-readonly" href="/"><Network size={14} />实时态势</a>
    </header>
    <p className="archive-intro">文件仅在本标签页读取，不上传、不调用模型，也不改变正在运行的实验。{filename && <strong>{filename}</strong>}</p>
    {error && <div className="error-banner" role="alert"><TriangleAlert size={15} /><span>无法载入：{error}</span></div>}
    {!frame || !archive ? <main className="archive-empty"><History size={46} strokeWidth={1} /><h2>{loading ? '正在读取回放' : '打开已导出的实验记录'}</h2><p>回看合成态势、冻结报告、人工与 AI 审核和实际送达过程。</p>{!loading && <a className="archive-readonly" href="/?view=archive&amp;example=two-node"><History size={14} />打开双节点断链补报示例</a>}</main> : <>
      <main className="archive-grid"><section className="archive-map-panel"><div className="map-toolbar"><div className="map-title"><History size={14} /><h2>澄海实验区 · 历史</h2><span className="map-code">T+{frame.tick.toString().padStart(4, '0')}</span></div><div className="map-layer-tools"><button className={`layer-button ${links ? 'active' : ''}`} onClick={() => setLinks(value => !value)} aria-pressed={links}><Network size={14} />链路</button><button className={`layer-button ${labels ? 'active' : ''}`} onClick={() => setLabels(value => !value)} aria-pressed={labels}><Layers3 size={14} />标签</button></div></div><SituationMap frame={frame} history={archive.history} selected={selected} onSelect={id => { setSelected(id); setView('inspector'); }} linksVisible={links} labelsVisible={labels} running={false} /><div className="archive-frame-summary"><span>合成参数 · 虚构区域</span><span>{frame.units.length} 个当时可见节点 · 决策截止 {frame.decision_seq == null ? '未记录' : `#${frame.decision_seq}`}</span></div></section>
        <aside className="archive-decision-panel">
          <div className="decision-tabs with-desk" role="tablist" aria-label="回放内容">
            <button role="tab" aria-selected={view === 'decisions'} className={view === 'decisions' ? 'active' : ''} onClick={() => setView('decisions')}>决策与报告</button>
            <button role="tab" aria-selected={view === 'compare'} className={view === 'compare' ? 'active' : ''} onClick={() => setView('compare')}>双节点对照</button>
            <button role="tab" aria-selected={view === 'desk'} className={view === 'desk' ? 'active' : ''} onClick={() => setView('desk')}>审核席</button>
            <button role="tab" aria-selected={view === 'inspector'} className={view === 'inspector' ? 'active' : ''} onClick={() => setView('inspector')}>历史节点</button>
          </div>
          <div className="archive-decision-content">
            {view === 'desk' ? (
              <LiveReviewDesk version={archive.desk_review_version} log={archive.decision_log} frame={frame}
                strategy={{ mode: 'archive', studies: archive.strategy_studies ?? [] }}
                historical cursor={decisionCursor} onCursorChange={setDecisionCursor} />
            ) : view === 'compare' ? (
              <ReportComparison versions={archive.report_versions} frame={frame} history={archive.history} log={archive.decision_log} onSeek={target => seek(archive.history.indexOf(target))} />
            ) : view === 'decisions' ? <DecisionPanel log={archive.decision_log} frame={frame} historical cursor={decisionCursor} onCursorChange={setDecisionCursor} /> : unit ? <UnitInspector unit={unit} frame={frame} history={archive.history} historical /> : <div className="empty-state"><Network size={25} /><strong>选择此帧中的节点</strong><p>节点未出现时，不使用后续帧补充信息。</p></div>}
          </div>
        </aside></main>
      <section className="archive-timeline" aria-label="本地记录时间线"><button className="icon-button" disabled={index === 0} onClick={() => seek(index - 1)} aria-label="上一历史帧"><ChevronLeft size={20} /></button><label><span>T+{frame.tick} · 第 {index + 1} / {archive.history.length} 帧</span><input type="range" min="0" max={archive.history.length - 1} value={index} onChange={event => seek(Number(event.target.value))} aria-label="选择归档历史帧" disabled={archive.history.length < 2} /></label><button className="icon-button" disabled={index === archive.history.length - 1} onClick={() => seek(index + 1)} aria-label="下一历史帧"><ChevronRight size={20} /></button></section>
    </>}
    {study && <StrategyStudyPanel study={study} onClose={() => setStudy(null)} returnLabel="返回归档页" />}
  </div>;
}
