import { useEffect, useRef, useState } from 'react';
import { Archive, ChevronLeft, ChevronRight, Cpu, Download, FileJson, FlaskConical, GitBranch, Pause, Play, Settings2, TriangleAlert } from 'lucide-react';
import type { LabArchive, LabBranch, LabConfig, LabFrame, RecordedAdvice } from '../contracts/evidence';
import { cancelEvidenceAdvice, requestEvidenceAdvice, runEvidenceBatch, runEvidenceLab } from './evidenceApi';
import { MAX_LAB_ARCHIVE_BYTES, parseEvidenceArchive } from './evidenceArchive';
import { EvidenceReader, tickLabel } from './EvidenceReader';
import { BatchStudy, BranchComparison, branchLabels } from './EvidenceStudy';
import './evidence-lab.css';

const defaultConfig: LabConfig = { seed: 20261022, read_interval: 3 };
const maxAdviceRecords = 256;
const stringifyError = (error: unknown) => error instanceof Error ? error.message : String(error);
const tabs = { desk: '审核席', comparison: '分支对照', batch: '多种子实验' } as const;
type Tab = keyof typeof tabs;

function configFromLocation(search: string): LabConfig {
  const params = new URLSearchParams(search);
  const numeric = (name: string, min: number, max: number) => {
    const raw = params.get(name) ?? '';
    const value = Number(raw);
    if (!/^(0|[1-9]\d{0,9})$/.test(raw) || value < min || value > max) {
      throw new Error('种子重演链接的实验参数无效。');
    }
    return value;
  };
  params.forEach((_, key) => {
    if (!['view', 'seed', 'read_interval', 'fork_tick'].includes(key) || params.getAll(key).length !== 1) {
      throw new Error('种子重演链接包含未知或重复的参数。');
    }
  });
  if (!params.has('seed') && !params.has('read_interval') && !params.has('fork_tick')) return defaultConfig;
  return {
    seed: numeric('seed', 0, 4294967295),
    read_interval: numeric('read_interval', 1, 6),
    fork_tick: params.has('fork_tick') ? numeric('fork_tick', 1, 36) : null,
    cited_ids: null,
  };
}

function RunSettings({ config, disabled, submit }: {
  config: LabConfig; disabled: boolean; submit: (config: LabConfig) => void;
}) {
  const [seed, setSeed] = useState(String(config.seed));
  const [interval, setInterval] = useState(String(config.read_interval));
  const [fork, setFork] = useState(config.fork_tick != null ? String(config.fork_tick) : '');
  return <form className="lab-settings" onSubmit={e => {
    e.preventDefault();
    submit({ seed: Number(seed), read_interval: Number(interval), fork_tick: fork === '' ? null : Number(fork), cited_ids: null });
  }}>
    <label>场景种子<input type="number" required min={0} max={4294967295} step={1} value={seed} onChange={e => setSeed(e.target.value)} /></label>
    <label>每份阅读间隔（步）<input type="number" required min={1} max={6} step={1} value={interval} onChange={e => setInterval(e.target.value)} /></label>
    <label>分岔时刻（步）<input type="number" min={1} max={36} step={1} placeholder="自动" value={fork} onChange={e => setFork(e.target.value)} /></label>
    <button className="lab-btn primary" disabled={disabled} type="submit"><Play size={14} />运行规则基线</button>
  </form>;
}

function ManualCitations({ frame, config, disabled, onSubmit }: {
  frame: LabFrame; config: LabConfig; disabled: boolean; onSubmit: (config: LabConfig) => void;
}) {
  const [ids, setIds] = useState<string[]>(config.cited_ids ?? []);
  const readable = frame.reports.filter(report => frame.active_ids.includes(report.id));
  return <details className="lab-controls-panel"><summary>人工指定 A 分支的审批依据</summary>
    <div className="lab-citations">
      <p className="lab-hint">勾选分岔时已阅且有效的报告，确认后以相同输入重跑两组。A 将保留本次人工引用记录。</p>
      <div className="lab-choice-row">{readable.map(r => <label key={r.id}>
        <input type="checkbox" checked={ids.includes(r.id)} disabled={disabled}
          onChange={e => setIds(previous => e.target.checked ? [...previous, r.id] : previous.filter(id => id !== r.id))} />
        <code>{r.id}</code> {r.source}
      </label>)}</div>
      <button className="lab-btn" disabled={disabled || !ids.length} onClick={() => onSubmit({ ...config, cited_ids: ids })}>确认引用并重跑</button>
    </div>
  </details>;
}

const adviceLabels = { hold: '暂缓判断', request_review: '请求复核', conclude: '形成结论' };
function AdvicePanel({ frame, branch, archive, offline, disabled, pending, onAsk, onCancel }: {
  frame: LabFrame; branch: LabBranch; archive: LabArchive; offline: boolean; disabled: boolean;
  pending: { branch: LabBranch; tick: number; cancelling: boolean } | null; onAsk: () => void; onCancel: () => void;
}) {
  const relevant = (archive.advice ?? []).filter(a => a.tick === frame.tick && a.branch === branch);
  const full = (archive.advice?.length ?? 0) >= maxAdviceRecords;
  return <section className="lab-panel lab-advice">
    <div className="lab-panel-heading"><h2><Cpu size={17} />Codex 证据咨询</h2><span>{branchLabels[branch]} · {tickLabel(frame.tick)}</span></div>
    {relevant.map((a, i) => <article className="lab-advice-record" key={i}>
      <strong>Codex 建议 · {adviceLabels[a.action]}</strong><p>{a.reason}</p>
      <dl className="lab-facts"><dt>当时已阅</dt><dd className="lab-mono">{a.read_ids.join(' · ') || '无'}</dd>
        <dt>模型引用</dt><dd className="lab-mono">{a.evidence_ids.join(' · ') || '无'}</dd>
        <dt>所引独立来源</dt><dd>模型判断 {a.source_count} · 来源记录核验 {a.verified_source_count}</dd>
      </dl>
      {a.uncertainties.length > 0 && <ul>{a.uncertainties.map((text, j) => <li key={j}>{text}</li>)}</ul>}
    </article>)}
    {offline ? !relevant.length && <p className="lab-empty">此帧没有已保存的模型咨询。</p> : <div className="lab-advice-actions">
      {pending ? <><span role="status">{pending.cancelling ? '正在取消' : '等待模型返回'} · {branchLabels[pending.branch]} {tickLabel(pending.tick)}</span>
        <button className="lab-btn" disabled={pending.cancelling} onClick={onCancel}>取消咨询</button></>
        : <><button className="lab-btn" disabled={disabled || full || !frame.reports.some(r => r.read_tick !== null)} onClick={onAsk}><Cpu size={14} />咨询当前帧</button>
          <small>{full ? `本次归档已存满 ${maxAdviceRecords} 条咨询。可导出保存后开始新实验。` : '使用本机 Codex 账号额度。仅提交当前分支当时已阅的证据，建议单独留档。'}</small></>}
    </div>}
  </section>;
}

function downloadArchive(archive: LabArchive) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `collector-evidence-${archive.config.seed}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function EvidenceLab({ initialArchive }: { initialArchive?: LabArchive }) {
  const example = new URLSearchParams(window.location.search).get('example');
  const [archive, setArchive] = useState<LabArchive | null>(initialArchive ?? null);
  const [origin, setOrigin] = useState<'live' | 'file' | 'example'>(initialArchive ? 'file' : example ? 'example' : 'live');
  const [tick, setTick] = useState(initialArchive?.fork_tick ?? 0);
  const [branch, setBranch] = useState<LabBranch>('immediate');
  const [tab, setTab] = useState<Tab>('desk');
  const [playing, setPlaying] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(initialArchive ? null : '正在载入实验');
  const [error, setError] = useState<string | null>(null);
  const [adviceJob, setAdviceJob] = useState<{ branch: LabBranch; tick: number; cancelling: boolean } | null>(null);
  const job = useRef<{ id: string; cancelled: boolean } | null>(null);
  const generation = useRef(0);

  function install(next: LabArchive, source: typeof origin) {
    setArchive(next);
    setOrigin(source);
    setPlaying(false);
    setTick(next.fork_tick);
    setBranch('immediate');
    setTab('desk');
    setRevision(n => n + 1);
  }
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    async function open() {
      if (initialArchive) {
        install(initialArchive, 'file');
        setBusy(null);
        return;
      }
      try {
        let loaded: LabArchive;
        if (example === null) loaded = await runEvidenceLab(configFromLocation(window.location.search));
        else {
          if (example !== 'collector') throw new Error('未找到指定的采集器回放示例。');
          const response = await fetch('/examples/evidence-review.json', {
            signal: controller.signal, mode: 'same-origin', credentials: 'omit', redirect: 'error',
          });
          if (!response.ok) throw new Error(`示例读取失败（HTTP ${response.status}）。`);
          loaded = parseEvidenceArchive(await response.text());
        }
        if (current === generation.current) install(loaded, example === null ? 'live' : 'example');
      } catch (reason) { if (current === generation.current) setError(stringifyError(reason)); }
      finally { if (current === generation.current) setBusy(null); }
    }
    void open();
    function onPageHide() {
      const active = job.current;
      if (active) {
        active.cancelled = true;
        void fetch('/api/evidence/advice/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: active.id }), keepalive: true,
        }).catch(() => {});
      }
    }
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      generation.current++;
      controller.abort();
      const active = job.current;
      if (active) {
        active.cancelled = true;
        void cancelEvidenceAdvice(active.id).catch(() => {});
        job.current = null;
      }
    };
  }, [initialArchive, example]);
  useEffect(() => {
    if (!archive || !playing) return;
    if (tick >= archive.end_tick) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setTick(index => index + 1), 700);
    return () => window.clearTimeout(timer);
  }, [tick, playing, archive]);

  async function loadArchive(load: () => Promise<LabArchive>, source: typeof origin, label: string) {
    if (job.current) return;
    const current = ++generation.current;
    setBusy(label); setError(null); setPlaying(false);
    try {
      const data = await load();
      if (current === generation.current) install(data, source);
    } catch (reason) { if (current === generation.current) setError(stringifyError(reason)); }
    finally { if (current === generation.current) setBusy(null); }
  }
  const run = (config: LabConfig) => { void loadArchive(() => runEvidenceLab(config), 'live', '正在运行成对实验'); };
  function openFile(file?: File) {
    if (!file) return;
    void loadArchive(async () => {
      if (file.size > MAX_LAB_ARCHIVE_BYTES) throw new Error('证据实验归档超过文件大小上限。');
      return parseEvidenceArchive(await file.text());
    }, 'file', '正在读取本地归档');
  }
  async function batch(count: number) {
    if (!archive || busy || job.current || origin !== 'live') return;
    const current = generation.current;
    setBusy('正在运行多种子实验'); setError(null); setPlaying(false);
    try {
      const rows = await runEvidenceBatch({ ...archive.config, cited_ids: null }, count);
      if (current === generation.current) setArchive(previous => previous && { ...previous, batch: rows });
    } catch (reason) { if (current === generation.current) setError(stringifyError(reason)); }
    finally { if (current === generation.current) setBusy(null); }
  }
  async function ask() {
    if (!archive || busy || job.current || origin !== 'live' || (archive.advice?.length ?? 0) >= maxAdviceRecords) return;
    const active = { id: crypto.randomUUID(), cancelled: false };
    job.current = active;
    setAdviceJob({ branch, tick, cancelling: false }); setError(null); setPlaying(false);
    try {
      const advice: RecordedAdvice = await requestEvidenceAdvice(archive.config, branch, tick, active.id);
      if (job.current === active && !active.cancelled) {
        setArchive(previous => previous && { ...previous, advice: [...(previous.advice ?? []), advice] });
      }
    } catch (reason) { if (job.current === active && !active.cancelled) setError(stringifyError(reason)); }
    finally { if (job.current === active) { job.current = null; setAdviceJob(null); } }
  }
  async function cancel() {
    const active = job.current;
    if (!active || adviceJob?.cancelling) return;
    active.cancelled = true;
    setAdviceJob(previous => previous && { ...previous, cancelling: true });
    try { await cancelEvidenceAdvice(active.id); }
    catch (reason) {
      if (job.current === active) {
        setError(`取消请求未获确认：${stringifyError(reason)}`);
        setAdviceJob(previous => previous && { ...previous, cancelling: false });
      }
    }
  }
  const blocked = Boolean(busy || adviceJob);
  const readOnly = origin !== 'live';
  const frame = archive?.[branch].frames[tick];
  function seek(target: number) { setPlaying(false); setTick(target); }
  return <div className="lab-shell">
    <header className="lab-masthead"><div><FlaskConical size={27} /><h1>采集器报告复核实验</h1></div>
      <nav aria-label="实验导航"><a href="/">实时态势</a><a href="/?view=archive">本地回放</a><a href="/?view=evidence&amp;example=collector">示例回放</a></nav></header>
    <main className="lab-workspace">
      <div className="lab-run-heading"><div><span className="lab-mode"><span />{origin === 'live' ? '本机实验' : origin === 'example' ? '随包示例 · 只读' : '归档回放 · 只读'}</span>
        <h2>采集连续性复核</h2>{archive && <p>种子 <code>{archive.config.seed}</code> · 每 {archive.config.read_interval} 步阅读一份 · 分岔于 <code>{tickLabel(archive.fork_tick)}</code></p>}</div>
        <div className="lab-actions"><label className={`lab-btn lab-file ${blocked ? 'disabled' : ''}`}><FileJson size={14} />导入归档
          <input type="file" accept=".json,application/json" aria-label="导入证据实验归档" disabled={blocked} onChange={e => {
            const file = e.target.files?.[0]; e.target.value = ''; openFile(file);
          }} /></label>
          <button className="lab-btn" disabled={!archive || blocked} onClick={() => archive && downloadArchive(archive)}><Download size={14} />导出归档</button></div>
      </div>
      {busy && <div className="lab-status" role="status">{busy}…</div>}
      {error && <div className="lab-error" role="alert"><TriangleAlert size={16} />{error}<button onClick={() => setError(null)}>关闭</button></div>}
      <details className="lab-controls-panel" key={`settings-${revision}`}><summary><Settings2 size={15} />{readOnly ? '以此配置新建本机实验' : '实验参数'}</summary>
        <RunSettings config={archive?.config ?? defaultConfig} disabled={blocked} submit={run} /></details>
      {archive && frame && <>
        <section className="lab-time" aria-label="证据实验时间线">
          <div className="lab-time-title"><strong>{tickLabel(frame.tick)}</strong><small>/ {tickLabel(archive.end_tick)}</small></div>
          <button className="lab-square" aria-label="上一步" disabled={tick === 0} onClick={() => seek(tick - 1)}><ChevronLeft size={17} /></button>
          <button className="lab-square" aria-label={playing ? '暂停回放' : '播放回放'} onClick={() => {
            if (!playing && tick === archive.end_tick) setTick(0); setPlaying(value => !value);
          }}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
          <button className="lab-square" aria-label="下一步" disabled={tick === archive.end_tick} onClick={() => seek(tick + 1)}><ChevronRight size={17} /></button>
          <input type="range" aria-label="证据实验回放时刻" min={0} max={archive.end_tick} step={1} value={tick} onChange={e => seek(Number(e.target.value))} />
          <button className="lab-btn" onClick={() => seek(archive.fork_tick)}><GitBranch size={14} />分岔帧</button>
        </section>
        <div className="lab-tab-bar"><div className="lab-tabs" aria-label="实验视图">{(Object.keys(tabs) as Tab[]).map(t =>
          <button key={t} aria-pressed={tab === t} onClick={() => { setTab(t); setPlaying(false); }}>{tabs[t]}</button>)}</div>
          {tab === 'desk' && <label className="lab-switch">审核分支<select value={branch} onChange={e => setBranch(e.target.value as LabBranch)}>
            <option value="immediate">{branchLabels.immediate}</option><option value="review">{branchLabels.review}</option></select></label>}</div>
        {tab === 'desk' ? <>
          <EvidenceReader key={`${revision}-${branch}`} frame={frame} onSeek={seek} />
          {!readOnly && tick === archive.fork_tick && branch === 'immediate' &&
            <ManualCitations key={revision} frame={frame} disabled={blocked} config={archive.config} onSubmit={run} />}
          <AdvicePanel frame={frame} branch={branch} archive={archive} offline={readOnly} pending={adviceJob}
            disabled={blocked} onAsk={() => void ask()} onCancel={() => void cancel()} />
        </> : tab === 'comparison' ? <BranchComparison archive={archive} tick={tick} onRead={next => { setBranch(next); setTab('desk'); }} />
          : <BatchStudy rows={archive.batch ?? []} config={archive.config} tick={tick} end={archive.end_tick} readOnly={readOnly} pending={blocked}
              run={c => void batch(c)} seekEnd={() => seek(archive.end_tick)} />}
      </>}
      {!archive && !busy && <div className="lab-placeholder"><Archive size={30} /><h2>尚未载入实验</h2><p>可导入本地归档，或运行规则基线生成新的实验。</p></div>}
    </main>
  </div>;
}
