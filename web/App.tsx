import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Download, Eye, FlaskConical, History, Layers3, LoaderCircle, Network, Pause, Play, Radio, RefreshCw, Search, ShieldCheck, SkipForward, Sparkles, TriangleAlert, X, Zap, Satellite, Signal, Compass, Cpu, CircleDot } from 'lucide-react';
import type { Frame, Snapshot, Unit } from '../contracts/state';
import { getState, request } from './api';
import SituationMap from './SituationMap';
import { UnitSymbol, SymbolLegend } from './UnitSymbol';
import { symbolDefinition } from './symbology';
import { deriveMotion, headingLabel, speedLabel } from './motion';
import DecisionPanel from './DecisionPanel';
import LiveReviewDesk from './LiveReviewDeskPanel';
import ReportComparison from './ReportComparisonPanel';
import { decisionKindNames, eventsAtFrame } from './decisions';

const pct = (value: number) => `${Math.round(value * 100)}%`;
const tickLabel = (value: number) => `T+${value.toString().padStart(4, '0')}`;
const domainNames: Record<Unit['domain'], string> = { air: '空中', surface: '水面', subsurface: '水下', ground: '地面', space: '空间' };
const affiliationNames: Record<Unit['affiliation'], string> = { PLA: '解放军', US: '美国', TW: '台湾地区', JP: '日本', KR: '韩国' };
const connectionNames: Record<Unit['connection'], string> = { online: '连接正常', degraded: '连接降级', offline: '离线' };

function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopResult, setStopResult] = useState<'confirmed' | 'unconfirmed' | null>(null);
  const [awaitingModelCleanup, setAwaitingModelCleanup] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedWasContact, setSelectedWasContact] = useState(false);
  const [filter, setFilter] = useState<'all' | 'blue' | 'red'>('all');
  const [search, setSearch] = useState('');
  const [linksVisible, setLinksVisible] = useState(true);
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [rightTab, setRightTab] = useState<'proposals' | 'inspector' | 'compare' | 'desk'>('proposals');
  const [historyFrame, updateHistoryFrame] = useState<Frame | null>(null);
  const [decisionCursor, setDecisionCursor] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLElement>(null);
  const streamRef = useRef<EventSource | null>(null);
  const runIdRef = useRef<string | null>(null);
  const commandRevisionRef = useRef(0);

  const setHistoryFrame = useCallback((next: Frame | null) => {
    updateHistoryFrame(next);
    setDecisionCursor(null);
  }, []);

  const ingest = useCallback((next: Snapshot) => {
    if (runIdRef.current && runIdRef.current !== next.run_id) {
      setHistoryFrame(null);
      setSelected(null);
      setSelectedWasContact(false);
      setStopResult(null);
    }
    if (!next.model.busy) setAwaitingModelCleanup(false);
    if (next.running || next.automation.mode === 'ai') setStopResult(null);
    runIdRef.current = next.run_id;
    setState(next);
  }, [setHistoryFrame]);

  useEffect(() => {
    let active = true;
    let receivedStreamState = false;
    setConnection('connecting');
    getState().then(next => { if (active && !receivedStreamState) ingest(next); }).catch(reason => { if (active && !receivedStreamState) { setError(`无法读取仿真状态：${String(reason.message ?? reason)}`); setConnection('disconnected'); } });
    const stream = new EventSource('/api/events');
    streamRef.current = stream;
    stream.onopen = () => { if (active) { setConnection('connected'); setError(null); } };
    stream.addEventListener('state', event => {
      if (!active) return;
      try { const next = JSON.parse((event as MessageEvent).data) as Snapshot; ingest(next); receivedStreamState = true; setConnection('connected'); } catch { setError('收到无法解析的状态数据，请检查后端日志。'); }
    });
    stream.onerror = () => { if (active) setConnection('disconnected'); };
    return () => { active = false; stream.close(); streamRef.current = null; };
  }, [connectionAttempt, ingest]);

  useEffect(() => {
    if (!helpOpen) return;
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') setHelpOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [helpOpen]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== '/' || helpOpen || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [helpOpen]);

  const mutate = async (key: string, path: string, body: unknown) => {
    if (historyFrame || pending || connection !== 'connected') return;
    const revision = ++commandRevisionRef.current;
    setPending(key); setError(null);
    try {
      const response = await request<Snapshot | { accepted: boolean }>(path, body);
      const next = 'schema_version' in response ? response : await getState();
      if (revision === commandRevisionRef.current) ingest(next);
    } catch (reason) {
      if (revision === commandRevisionRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (revision === commandRevisionRef.current) setPending(null);
    }
  };

  const control = (action: string, value?: number) => mutate(action, '/api/control', { action, ...(value === undefined ? {} : { value }) });
  // Stop is an independent HTTP attempt, including when SSE or the last state is stale.
  const stopAutomation = async () => {
    if (stopping) return;
    ++commandRevisionRef.current;
    setStopping(true);
    setPending(null);
    setStopResult(null);
    setAwaitingModelCleanup(false);
    setError(null);
    try {
      const next = await request<Snapshot>('/api/automation', { mode: 'manual' }, { timeoutMs: 10_000 });
      if (next.automation?.mode !== 'manual' || next.running !== false) throw new Error('服务端尚未确认人工模式与暂停状态。');
      ingest(next);
      setStopResult('confirmed');
      setAwaitingModelCleanup(Boolean(next.model.busy));
    } catch (reason) {
      setAwaitingModelCleanup(false);
      setStopResult('unconfirmed');
      setError(`停止未确认：${reason instanceof Error ? reason.message : String(reason)} 可再次点击停止重试。`);
    } finally { setStopping(false); }
  };
  const selectUnit = (id: string) => {
    setSelected(id);
    setSelectedWasContact((historyFrame?.units ?? state?.units ?? []).some(unit => unit.id === id && unit.side === 'red'));
    setRightTab('inspector');
  };
  const exportRun = async () => {
    setError(null);
    try {
      const archive = await request<unknown>('/api/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `c5isr-${state?.run_id ?? 'experiment'}.json`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`); }
  };

  const frame: Frame | null = historyFrame ?? state?.history.at(-1) ?? null;
  const units = frame?.units.filter(unit => unit.side === 'blue' || (unit.contact && unit.contact.first_seen_tick <= frame.tick && unit.contact.expires_tick > frame.tick)) ?? [];
  const ownUnits = units.filter(unit => unit.side === 'blue');
  const perception = frame?.perception;
  const metrics = frame?.metrics;
  const selectedUnit = units.find(unit => unit.id === selected) ?? null;
  const visibleUnits = units.filter(unit => (filter === 'all' || unit.side === filter) && `${unit.name} ${unit.model_label} ${unit.id} ${unit.type_label}`.toLowerCase().includes(search.toLowerCase()));
  const pendingProposals = state?.proposals.filter(item => item.status === 'pending') ?? [];
  const aiMode = state?.automation?.mode === 'ai';
  const baseDisabled = !state || Boolean(historyFrame) || Boolean(pending) || stopping || connection !== 'connected';
  const disabled = baseDisabled || aiMode || Boolean(state?.model.busy);
  const modelBusy = state?.model.busy || pending === 'model';
  const onlineCount = ownUnits.filter(unit => unit.connection === 'online').length;
  const readyLinks = frame?.links.filter(link => link.enabled).length ?? 0;
  const isCodex = Boolean(state?.model.provider.toLowerCase().includes('codex') || state?.model.provider.toLowerCase().includes('chatgpt'));
  const historyIndex = historyFrame ? Math.max(0, state?.history.findIndex(item => item.tick === historyFrame.tick && item.decision_seq === historyFrame.decision_seq) ?? 0) : Math.max(0, (state?.history.length ?? 1) - 1);
  const decisionEvents = frame ? eventsAtFrame(state?.decision_log, frame, historyFrame ? decisionCursor : null) : [];
  const stopDisabled = stopping;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="C5ISR Observatory 主页"><span className="brand-mark"><Network size={22} strokeWidth={1.6} /></span><span className="brand-name">C5ISR<span className="brand-divider">/</span><span className="brand-subtitle">OBSERVATORY</span></span><span className="version-tag">LAB 01</span></a>
      <div className="header-context"><span className="context-dot" />澄海 · 信息协同实验<span className="context-divider" />虚构场景</div>
      <div className="topbar-actions">
        <span className="synthetic-badge"><ShieldCheck size={13} />合成参数 · 虚构区域</span>
        <button className="icon-button export-button" onClick={exportRun} disabled={!state} title="导出实验记录" aria-label="导出实验记录"><Download size={17} /></button>
        <a className="archive-link" href="?view=evidence" target="_blank" rel="noopener noreferrer" title="报告复核实验" aria-label="报告复核实验"><FlaskConical size={14} /><span className="lab-nav-label">报告复核实验</span></a>
        <a className="archive-link" href="?view=archive" target="_blank" rel="noopener noreferrer"><History size={14} />本地回放</a>
        <button className="icon-button" onClick={() => setHelpOpen(true)} title="使用说明" aria-label="打开使用说明"><CircleHelp size={17} /></button>
      </div>
    </header>

    <div className="main-layout">
      <nav className="nav-rail" aria-label="工作区快捷导航"><div className="rail-top"><span className="rail-letter">C</span><button className="rail-button active" aria-label="态势总览" title="态势总览" onClick={() => { setHistoryFrame(null); setRightTab('proposals'); }}><Compass size={20} /></button><button className="rail-button" aria-label="查找节点" title="查找节点" onClick={() => searchRef.current?.focus()}><Network size={19} /></button><button className="rail-button" aria-label="跳转实验时间线" title="实验时间线" onClick={() => timelineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}><History size={19} /></button></div><span className="rail-bottom" title="仅使用合成数据"><ShieldCheck size={18} /><span>SIM</span></span></nav>
      <div className="workspace">
        <section className="overview" aria-label="实验实时指标">
          <div className="experiment-heading"><span className="eyebrow">COMMON OPERATING PICTURE</span><div><h1>协同态势总览</h1><span className={`live-indicator ${historyFrame ? 'history' : connection === 'connected' ? '' : 'offline'}`}><span />{historyFrame ? '历史回看' : connection === 'connected' ? '实时连接' : connection === 'connecting' ? '连接中' : '连接中断'}</span></div></div>
          <div className="metric"><span className="metric-label">在线我方<Radio size={13} /></span><div><strong>{state ? onlineCount : '—'}</strong><span>/ {state ? ownUnits.length : '—'}</span></div><span className="metric-note">跨域协同网络</span></div>
          <div className="metric"><span className="metric-label">有效链路<Network size={13} /></span><div><strong>{state ? readyLinks : '—'}</strong><span>/ {state ? frame?.links.length : '—'}</span></div><span className="metric-note">{metrics ? `平均 ${metrics.avg_latency_ticks.toFixed(1)} tick 延迟` : '等待数据'}</span></div>
          <div className="metric"><span className="metric-label">信息新鲜度<Activity size={13} /></span><div><strong className={metrics && metrics.freshness < .5 ? 'text-amber' : 'text-teal'}>{metrics ? pct(metrics.freshness) : '—'}</strong></div><span className="metric-note">合成观测时效指标</span></div>
          <div className="metric"><span className="metric-label">闭环任务<Check size={13} /></span><div><strong>{metrics?.completed_tasks ?? '—'}</strong><span>已完成</span></div><span className="metric-note">{historyFrame ? '所选历史帧' : aiMode ? `${state?.automation.auto_approved ?? 0} 项由 AI 自动批准` : `${pendingProposals.length} 条建议等待审批`}</span></div>
        </section>

        <section className="cycle-strip" aria-label="信息决策闭环"><span className="cycle-title"><span className="small-dot" />C5ISR 闭环</span><div className="cycle-stages">{[
          { name: '感知', note: perception ? `${perception.active_contacts} 个接触` : '周期观测', icon: Eye }, { name: '传输', note: metrics ? `${metrics.pending_messages} 待达` : '通信网络', icon: Radio }, { name: '融合', note: '信息状态', icon: Layers3 }, { name: '建议', note: '规则 / 大模型', icon: Sparkles }, { name: '审批', note: historyFrame ? '历史审核事件' : aiMode ? '信息任务授权' : '人工授权', icon: ShieldCheck }, { name: '执行 · 反馈', note: '信息任务', icon: RefreshCw },
        ].map((stage, index) => <div className="stage-wrapper" key={stage.name}><div className={`cycle-stage stage-${index}`}><stage.icon size={13} /><span>{stage.name}</span><small>{stage.note}</small></div>{index < 5 && <ChevronRight size={12} className="stage-arrow" />}</div>)}</div><span className="cycle-note">{historyFrame ? 'HISTORICAL SNAPSHOT' : aiMode ? 'AI INFORMATION AUTONOMY' : 'HUMAN IN THE LOOP'}</span></section>

        <AutomationBar state={state} historical={Boolean(historyFrame)} startDisabled={disabled || !state?.model.available} stopDisabled={stopDisabled} stopping={stopping} onStart={() => mutate('automation', '/api/automation', { mode: 'ai' })} onStop={stopAutomation} />

        {connection === 'disconnected' && <div className="connection-alert" role="status"><TriangleAlert size={15} /><span>实时连接中断。当前显示最后收到的状态；后端可能仍在运行或消耗额度，正在尝试重连。</span><button onClick={() => setConnectionAttempt(value => value + 1)}>立即重连<RefreshCw size={13} /></button></div>}
        {stopResult && <div className={`stop-confirmation ${stopResult}`} role="status">{stopResult === 'confirmed' ? <Check size={14} /> : <TriangleAlert size={14} />}<span>{stopResult === 'confirmed' ? awaitingModelCleanup ? '服务端已确认停止后续调用并暂停；在途模型正在清理。' : '服务端已确认停止后续调用并暂停，模型空闲。' : '尚未确认停止；后端可能仍在运行，请重试停止。'}{stopResult === 'confirmed' && connection !== 'connected' && ' 状态流尚未恢复，此处为停止请求返回时的确认。'}</span>{stopResult === 'unconfirmed' && <button onClick={stopAutomation} disabled={stopping}>重试停止</button>}</div>}
        {error && <div className="error-banner" role="alert"><TriangleAlert size={15} /><span>{error}</span><button className="icon-button" onClick={() => setError(null)} title="关闭提示" aria-label="关闭错误提示"><X size={15} /></button></div>}

        <main className="operations-grid">
          <aside className="node-panel" aria-label="仿真节点列表">
            <div className="panel-heading"><div><span className="eyebrow">FORCE ELEMENTS</span><h2>节点与接触<span className="heading-count">{units.length.toString().padStart(2, '0')}</span></h2></div><Signal size={17} className="muted" /></div>
            <div className="node-tools"><label className="search-field"><Search size={14} /><input ref={searchRef} placeholder="搜索型号 / 节点" value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索节点型号或名称" /><kbd>/</kbd></label><div className="segmented-filter" role="group" aria-label="筛选节点阵营">{(['all', 'blue', 'red'] as const).map(value => <button className={filter === value ? 'selected' : ''} key={value} onClick={() => setFilter(value)} aria-pressed={filter === value}>{value === 'all' ? '全部' : value === 'blue' ? '我方' : '接触'}<span>{value === 'all' ? units.length : units.filter(unit => unit.side === value).length}</span></button>)}</div></div>
            <div className="node-list">{visibleUnits.map(unit => <button className={`node-row ${unit.side} ${selected === unit.id ? 'selected' : ''}`} key={unit.id} onClick={() => selectUnit(unit.id)} aria-pressed={selected === unit.id}><span className="node-symbol"><UnitSymbol unit={unit} size={21} /></span><span className="node-row-main"><span className="node-name">{unit.model_label}{unit.conceptual && <span className="concept-tag">概念</span>}</span><span className="node-subtitle">{unit.side === 'red' && unit.contact ? `观测 ${tickLabel(unit.contact.last_seen_tick)}` : unit.name}</span></span><span className={`connection-dot ${unit.side === 'red' ? 'contact' : unit.connection}`} title={unit.side === 'red' ? '已发现接触；非实时真值' : connectionNames[unit.connection]} aria-label={unit.side === 'red' ? '已发现对照接触' : connectionNames[unit.connection]} /></button>)}{visibleUnits.length === 0 && <div className="empty-small">{state ? filter === 'red' && perception?.active_contacts === 0 ? '尚无有效接触。推进感知周期，等待观测报告送达。' : '没有符合条件的节点' : '等待仿真状态…'}</div>}</div>
            <div className="node-panel-foot"><span className="small-dot" />仅显示我方与已发现接触<span>{units.filter(unit => unit.conceptual).length} 个概念标签</span></div>
          </aside>

          <section className="map-panel" aria-label="协同态势图">
            <div className="map-toolbar"><div className="map-title"><span className={`small-dot ${historyFrame ? 'amber' : ''}`} /><h2>澄海实验区</h2><span className="map-code" title="milsymbol 3.0.4 · APP6 配置，按阵营与域生成符号">APP6 SYMBOLS</span></div><div className="map-layer-tools"><button className={linksVisible ? 'layer-button active' : 'layer-button'} onClick={() => setLinksVisible(value => !value)} aria-pressed={linksVisible} title="显示或隐藏通信链路"><Network size={14} /><span>链路</span></button><button className={labelsVisible ? 'layer-button active' : 'layer-button'} onClick={() => setLabelsVisible(value => !value)} aria-pressed={labelsVisible} title="显示或隐藏型号标签"><Layers3 size={14} /><span>标签</span></button></div></div>
            <div className="perception-strip">
              <label><Eye size={12} /><span>感知周期</span><select aria-label="感知周期" value={perception?.cycle_ticks ?? 8} disabled={disabled} onChange={event => control('observation_cycle', Number(event.target.value))}>{[4, 8, 16, 32].map(value => <option key={value} value={value}>{value} tick</option>)}</select></label>
              <span>下次 <b>{perception ? tickLabel(perception.next_scan_tick) : '—'}</b></span>
              <span className="contact-total">有效接触 <b>{perception?.active_contacts ?? '—'}</b></span>
              <span className="contact-archive" title="接触失效表示信息过期，不表示装备被摧毁">过期归档 <b>{perception?.total_archived ?? '—'}</b></span>
            </div>
            <div className="map-canvas">{frame ? <SituationMap frame={frame} history={state?.history ?? []} selected={selected} onSelect={selectUnit} linksVisible={linksVisible} labelsVisible={labelsVisible} running={Boolean(state?.running && !(aiMode && modelBusy) && !historyFrame && connection === 'connected')} /> : <div className="map-loading"><Network size={36} strokeWidth={1} /><strong>等待仿真引擎</strong><span>正在连接 127.0.0.1:8787</span><small>启动 Rust 服务后，态势将在此处显示。</small></div>}
              {frame && perception?.active_contacts === 0 && <div className="contact-empty"><Eye size={17} /><strong>{perception.total_discovered === 0 ? '等待首次接触发现' : '当前无有效对照接触'}</strong><span>{perception.total_discovered === 0 ? '仅显示我方节点；观测报告送达后显示接触。' : '已有接触因信息过期归档，不表示摧毁。'}</span><small>下次感知 {tickLabel(perception.next_scan_tick)} · 报告受链路延迟影响</small></div>}
              {frame && <div className="map-coordinate-label"><CircleDot size={11} />{selectedUnit ? `GRID ${selectedUnit.x.toFixed(1)} / ${selectedUnit.y.toFixed(1)}` : 'GRID 0—100'}<span>无真实地理坐标</span></div>}
              {historyFrame && <div className="history-map-banner"><History size={14} /><span>正在回看 {tickLabel(historyFrame.tick)}</span><button onClick={() => setHistoryFrame(null)}>返回实时<ArrowRight size={13} /></button></div>}
              <div className="map-legend"><span><i className="legend-friendly" />我方节点</span><span><i className="legend-opposing" />已发现接触</span><span><i className="legend-link" />信息链路</span><span title="独立矢量仅表示网格位移方向，箭头长度不代表速度；北0°、东90°"><svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="currentColor"><path d="M0 5H12M8 1l4 4-4 4" /></svg>航向</span><small>g/t = grid/tick</small></div>
            </div>
            <div className="injection-bar"><div><Zap size={13} /><span>扰动实验</span></div><button disabled={disabled} onClick={() => mutate('link_loss', '/api/inject', { kind: 'link_loss' })}>链路中断<ChevronRight size={12} /></button><button disabled={disabled} onClick={() => mutate('sensor_noise', '/api/inject', { kind: 'sensor_noise' })}>观测噪声<ChevronRight size={12} /></button><button className="recover-button" disabled={disabled} onClick={() => mutate('recover', '/api/inject', { kind: 'recover' })}><RefreshCw size={12} />恢复环境</button></div>
          </section>

          <aside className="decision-panel" aria-label="决策辅助与节点详情">
            <div className="panel-heading"><div><span className="eyebrow">DECISION SUPPORT</span><h2>协同决策台</h2></div><Cpu size={18} className="muted" /></div>
            {!historyFrame && <div className="model-box"><div className="model-title"><span className="model-icon"><Sparkles size={15} /></span><div><strong>{isCodex ? 'Codex · ChatGPT 订阅' : '规则基线'}</strong><span>{awaitingModelCleanup ? '停止已确认 · 等待模型进程清理' : modelBusy ? aiMode ? '自治研判中 · 时钟保持' : '正在生成研判…' : state?.model.last_run_tick != null ? `最近研判 ${tickLabel(state.model.last_run_tick)}` : isCodex ? '手动调用 · 尚未完成研判' : '确定性规则提供基础建议'}</span></div><span className={`model-status ${modelBusy ? 'busy' : state?.model.available ? '' : 'unavailable'}`} /> </div><button className="analyze-button" onClick={() => mutate('model', '/api/model/analyze', {})} disabled={disabled || !state?.model.available || modelBusy}>{modelBusy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{awaitingModelCleanup ? '模型进程清理中' : modelBusy ? '研判进行中' : aiMode ? 'AI 信息自治运行中' : '生成模型研判'}<span>{aiMode ? '自动周期' : '手动触发'}</span></button>{state?.model.last_error && <div className="model-error"><TriangleAlert size={12} /><span>{state.model.last_error}</span></div>}<p className="model-note">{state?.model.detail || '正在读取模型接入状态。'} {aiMode ? '仅自动批准本轮校验通过的四类信息任务；规则建议不会被自动批准。' : '人工模式下，所有建议均需人工审批。'}{state && !state.model.available && <span> 若刚完成 codex login，请重启后端刷新状态。</span>}</p></div>}
            <div className="decision-tabs with-desk" role="tablist" aria-label="决策台内容">
              <button role="tab" aria-selected={rightTab === 'proposals'} onClick={() => setRightTab('proposals')} className={rightTab === 'proposals' ? 'active' : ''}>{historyFrame ? '历史决策' : '建议与记录'}<span>{historyFrame ? decisionEvents.length : pendingProposals.length}</span></button>
              <button role="tab" aria-selected={rightTab === 'compare'} onClick={() => setRightTab('compare')} className={rightTab === 'compare' ? 'active' : ''}>双节点对照</button>
              <button role="tab" aria-selected={rightTab === 'desk'} onClick={() => setRightTab('desk')} className={rightTab === 'desk' ? 'active' : ''}>审核席</button>
              <button role="tab" aria-selected={rightTab === 'inspector'} onClick={() => setRightTab('inspector')} className={rightTab === 'inspector' ? 'active' : ''}>{historyFrame ? '历史节点' : '节点详情'}</button>
            </div>
            <div className="decision-content">{!frame ? <div className="empty-state">等待仿真状态…</div> : rightTab === 'desk' ? (
              <LiveReviewDesk key={state?.run_id} version={state?.desk_review_version} log={state?.decision_log} frame={frame}
                strategy={state ? { mode: 'live', runId: state.run_id, online: connection === 'connected' } : undefined}
                historical={Boolean(historyFrame)} cursor={decisionCursor} onCursorChange={setDecisionCursor} disabled={disabled}
                onSubmit={(caseId, readSeq, ids) => mutate('desk-judgment', '/api/review-desk/judgments', {
                  run_id: state?.run_id, case_id: caseId, expected_read_seq: readSeq, evidence_ids: ids,
                })} />
            ) : rightTab === 'compare' ? (
              <ReportComparison key={state?.run_id} versions={state?.report_versions} frame={frame} history={state?.history ?? []} log={state?.decision_log} onSeek={state && !state.running && !aiMode ? setHistoryFrame : undefined} />
            ) : rightTab === 'proposals' ? <DecisionPanel log={state?.decision_log} frame={frame} cursor={decisionCursor} onCursorChange={setDecisionCursor} historical={Boolean(historyFrame)} liveProposals={state?.proposals} disabled={disabled} onReview={(id, approve) => mutate(id, `/api/proposals/${encodeURIComponent(id)}/review`, { run_id: state?.run_id, approve })} /> : selectedUnit ? <UnitInspector unit={selectedUnit} frame={frame!} history={state?.history ?? []} historical={Boolean(historyFrame)} /> : <div className="empty-state"><Compass size={28} strokeWidth={1.2} /><strong>{selected && selectedWasContact && !historyFrame ? '所选接触已过期归档' : '选择一个节点或接触'}</strong><p>{selected && selectedWasContact && !historyFrame ? '接触失效表示信息过期，不表示摧毁。后续新接触按新报告显示。' : '点击地图或左侧列表，查看已接入状态与已收到的接触报告。'}</p></div>}</div>
            <div className="decision-foot"><ShieldCheck size={12} /><span>{historyFrame ? '历史记录 · 只读回放 · 冻结依据' : `信息任务 · ${aiMode ? 'AI 限定授权' : '人工审批'} · 来源记录`}</span></div>
          </aside>
        </main>

        <section className="timeline-panel" ref={timelineRef} aria-label="实验时间线与事件记录">
          <div className="playback-row"><div className="playback-buttons"><button className="play-button" disabled={state?.running || aiMode ? stopDisabled : disabled} onClick={() => state?.running || aiMode ? stopAutomation() : control('play')} aria-label={state?.running || aiMode ? '暂停仿真并停止自治' : '开始仿真'} title={state?.running || aiMode ? '暂停仿真并停止自治' : '开始仿真'}>{pending === 'play' || stopping ? <LoaderCircle size={17} className="spin" /> : state?.running || aiMode ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><button className="icon-button" disabled={disabled || state?.running} onClick={() => control('step')} title="推进一个仿真步" aria-label="推进一个仿真步"><SkipForward size={17} /></button><SeedReset disabled={disabled} onReset={seed => { setSelected(null); void control('reset', seed); }} /><span className="playback-divider" /><label className="speed-select"><select aria-label="仿真播放速度" value={state?.speed ?? 1} disabled={disabled} onChange={event => control('speed', Number(event.target.value))}><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8×</option></select><ChevronDown size={11} /></label></div><div className="tick-counter"><span>{tickLabel(frame?.tick ?? 0)}</span><small>SIM TICK</small></div><div className="timeline-track"><div className="timeline-track-label"><span>{state?.history[0] ? tickLabel(state.history[0].tick) : 'T+0000'}</span><span>{historyFrame ? '历史帧 · 操作已锁定' : state?.running ? aiMode && modelBusy ? '研判中 · 仿真时钟保持' : '实验进行中 · 暂停后可回看' : '拖动回看历史帧'}</span><span>{tickLabel(state?.tick ?? 0)}</span></div><input type="range" min="0" max={Math.max(0, (state?.history.length ?? 1) - 1)} value={historyIndex} disabled={!state || state.running || aiMode || state.history.length < 2} onChange={event => { setHistoryFrame(state?.history[Number(event.target.value)] ?? null); setRightTab(current => current === 'inspector' ? 'proposals' : current); }} aria-label="历史帧回看" /></div><button className={`return-live ${historyFrame ? 'is-history' : ''}`} onClick={() => setHistoryFrame(null)} disabled={!historyFrame}><span className="small-dot" />{historyFrame ? '返回实时' : '实时'}{historyFrame && <ArrowRight size={12} />}</button></div>
          <div className="event-strip">
            <div className="event-heading"><Clock3 size={13} /><span>{historyFrame ? '历史决策' : '事件流'}</span><span className="event-count">{historyFrame ? decisionEvents.length : state?.events.length ?? 0}</span></div>
            <div className="event-list">{historyFrame ? <>{decisionEvents.slice(-3).reverse().map(event => <div key={event.seq} className="event-item"><span>#{event.seq} · {tickLabel(event.tick)}</span><i className={['dropped', 'expired', 'stale'].includes(event.kind) ? 'warning' : ''} /><p title={event.note ?? decisionKindNames[event.kind]}>{decisionKindNames[event.kind]}{event.report_id ? ` · ${event.report_id}` : ''}{event.note ? ` · ${event.note}` : ''}</p></div>)}{!decisionEvents.length && <span className="event-empty">{frame?.decision_seq == null ? '此数据没有决策序列记录' : '当前截止位置尚无决策事件'}</span>}</> : <>{(state?.events ?? []).slice(-3).reverse().map(event => <div key={event.id} className="event-item"><span>{tickLabel(event.tick)}</span><i className={event.kind.includes('error') || event.kind.includes('loss') || event.kind.includes('drop') ? 'warning' : ''} /><p title={event.message}>{event.message}</p></div>)}{!state?.events.length && <span className="event-empty">实验事件将在这里记录</span>}</>}</div>
            {historyFrame && <span className="event-live-label">仅所选决策序号之前的记录</span>}
          </div>
        </section>
        <footer className="workspace-footer"><span><span className="small-dot" />研究演示环境<span className="footer-separator">/</span>参数、地理与事件均为合成</span><span>SEED {state?.seed ?? '—'}<span className="footer-separator">/</span>SCHEMA {state?.schema_version ?? '—'}<span className="footer-separator">/</span>C5ISR OBSERVATORY</span></footer>
      </div>
    </div>

    {helpOpen && <div className="modal-backdrop" onClick={() => setHelpOpen(false)}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()}><button className="icon-button modal-close" autoFocus onClick={() => setHelpOpen(false)} aria-label="关闭使用说明"><X size={18} /></button><span className="eyebrow">EXPERIMENT GUIDE</span><h2 id="help-title">观察一次信息决策闭环</h2><p>本实验使用真实型号名称作为显示标签，全部能力参数、地理位置和状态变化均为合成。标有「概念」的型号不代表已确认服役或真实性能。</p><p className="symbol-guide">符号由 milsymbol 3.0.4 的 APP6 配置生成，外框同时区分阵营与域；下表是通用域别示例，具体节点按类型显示库内符号。青蓝与琥珀是本应用配色，不声明整个界面完整符合 APP-6 标准。</p><SymbolLegend /><p className="symbol-motion-guide">符号本体固定朝向；独立箭头表示位移方向，长度仅示意。速度由公开位置差分得到，单位 grid/tick；数据不足时显示未知。</p><ol><li><strong>推进仿真</strong><span>点击播放或单步，按所选感知周期生成观测。对照单位仅在报告送达后成为接触，位置是最近报告值；过期后归档。</span></li><li><strong>注入扰动</strong><span>制造链路中断或观测噪声，检验信息协同的变化。</span></li><li><strong>生成与审核建议</strong><span>人工模式可手动研判并审核建议。开启 AI 信息自治后，模型按至少 60 秒的墙钟间隔持续调用，消耗订阅额度；只自动批准本轮有效的信息复核、链路恢复、请求观测或继续观察。可随时停止。</span></li><li><strong>回看与导出</strong><span>暂停后拖动时间线查看历史态势与决策；同一步内可按事件序号检查当时依据。导出 JSON 后，可在「本地回放」新标签页读取，不影响实时系统。</span></li></ol><div className="guide-note"><ShieldCheck size={17} /><span>范围：信息协同、人工审阅与有限信息任务自治。接触归档表示信息过期；不提供打击、摧毁、武器效能或目标分配功能。</span></div></section></div>}
  </div>;
}

function SeedReset({ disabled, onReset }: { disabled: boolean; onReset: (seed?: number) => void }) {
  const [value, setValue] = useState('');
  const input = value.trim();
  const random = input === '随机';
  const valid = !input || random || (/^\d+$/.test(input) && Number.isSafeInteger(Number(input)));
  const hint = valid ? '选填非负整数或“随机”。点击重置后清空本轮记录并应用种子。' : '种子须为 0 到 9007199254740991 的整数，或填“随机”。';
  return <>
    <label className="live-seed" title={hint}>种子
      <input type="text" list="seed-options" value={value} onChange={e => setValue(e.target.value)}
        disabled={disabled} placeholder="默认" aria-label="重置实验种子" aria-invalid={!valid} />
      <datalist id="seed-options"><option value="20261022" /><option value="20261026" /><option value="随机" /></datalist>
    </label>
    <button className="icon-button reset-button" type="button" disabled={disabled || !valid} title={hint} aria-label="重置当前实验" onClick={() => {
      const seed = random ? crypto.getRandomValues(new Uint32Array(1))[0] : input ? Number(input) : undefined;
      onReset(seed);
    }}><RefreshCw size={15} /></button>
  </>;
}

function AutomationBar({ state, historical, startDisabled, stopDisabled, stopping, onStart, onStop }: {
  state: Snapshot | null;
  historical: boolean;
  startDisabled: boolean;
  stopDisabled: boolean;
  stopping: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const automation = state?.automation;
  const ai = automation?.mode === 'ai';
  const busy = Boolean(state?.model.busy);
  const phaseNames = { idle: '人工审阅就绪', waiting: '等待下一轮', analyzing: '模型研判中 · 时钟保持', executing: '执行信息任务', error: '自治已停止 · 需要处理错误' };
  const phase = automation?.phase ?? 'idle';
  return <section className={`automation-bar ${ai ? 'ai-active' : ''} ${phase === 'error' ? 'has-error' : ''}`} aria-label="信息任务控制模式">
    <div className="automation-modes" role="group" aria-label="选择决策模式">
      <button className={!ai ? 'selected' : ''} aria-pressed={!ai} disabled={stopDisabled || !ai} onClick={onStop}><ShieldCheck size={13} />人工审阅</button>
      <button className={ai ? 'selected' : ''} aria-pressed={ai} disabled={startDisabled || ai} onClick={onStart}><Sparkles size={13} />AI 信息自治</button>
    </div>
    <div className="automation-status" aria-live="polite">
      <strong>{phase === 'analyzing' ? <LoaderCircle size={12} className="spin" /> : <span className="small-dot" />}{!state ? '等待引擎状态' : stopping ? '停止请求处理中' : !ai && busy ? '模型请求处理中' : phaseNames[phase]}{historical && <small>实时控制状态</small>}</strong>
      <span>{ai ? `已完成 ${automation?.cycles_completed ?? 0} 轮 · 自动批准 ${automation?.auto_approved ?? 0} 项` : '仅限信息复核、链路恢复、请求观测、继续观察'}{ai && automation?.next_run_in_seconds != null && <b> · 下轮约 {automation.next_run_in_seconds}s</b>}</span>
    </div>
    <div className="automation-budget"><Clock3 size={12} /><span>调用间隔 ≥ {automation?.interval_seconds ?? 60}s<strong>开启后持续消耗订阅额度</strong></span></div>
    <button className="stop-automation" onClick={onStop} disabled={stopDisabled}>{stopping ? <LoaderCircle size={13} className="spin" /> : <Pause size={12} />}停止并暂停</button>
    {automation?.last_error && <div className="automation-error" role="alert"><TriangleAlert size={12} /><span>{automation.last_error} 已停止后续调用；处理后可重新开启。</span></div>}
  </section>;
}

export function UnitInspector({ unit, frame, history, historical }: { unit: Unit; frame: Frame; history: Frame[]; historical: boolean }) {
  const contact = unit.side === 'red';
  const motion = deriveMotion(unit.id, frame, history);
  const links = frame.links.filter(link => link.from === unit.id || link.to === unit.id);
  const symbol = symbolDefinition(unit);
  return <div className="unit-inspector">
    <div className={`inspector-unit-header ${unit.side}`}>
      <span className="inspector-symbol"><UnitSymbol unit={unit} size={30} /></span>
      <div><h3>{unit.model_label}{unit.conceptual && <span className="concept-tag">概念标签</span>}</h3><span>{unit.name}</span></div>
    </div>
    {historical && <div className="history-inspector-note"><History size={13} />{tickLabel(frame.tick)} · 仅显示此帧已知节点、接触与指标。</div>}
    {contact && <div className="contact-inspector-note"><Eye size={13} /><span>已发现对照接触。位置为最近收到的观测报告；连接和可用度不作为已知真值。</span></div>}
    <dl className="unit-facts">
      <div><dt>{contact ? '接触标识' : '节点标识'}</dt><dd className="mono">{unit.id}</dd></div>
      <div><dt>阵营 / 来源标签</dt><dd>{contact ? '对照接触' : '我方'} · {affiliationNames[unit.affiliation]}</dd></div>
      <div><dt>{contact ? '报告类型' : '节点类型'}</dt><dd>{domainNames[unit.domain]} / {unit.type_label}</dd></div>
      <div><dt>APP6 显示类别</dt><dd title={`SIDC ${symbol.sidc}`}>{symbol.label}</dd></div>
      {!contact && <div><dt>协同角色</dt><dd>{unit.role}</dd></div>}
      <div><dt>{contact ? '最近报告位置' : '合成位置'}</dt><dd className="mono">{unit.x.toFixed(1)} / {unit.y.toFixed(1)}</dd></div>
      <div><dt>{contact ? '报告差分速度' : '帧差分速度'}</dt><dd className="mono">{speedLabel(motion)}</dd></div>
      <div><dt>网格航向</dt><dd className="mono">{headingLabel(motion)}</dd></div>
      {contact ? <>
        <div><dt>首次报告采样</dt><dd className="mono">{unit.contact ? tickLabel(unit.contact.first_seen_tick) : '未知'}</dd></div>
        <div><dt>最近报告采样</dt><dd className="mono">{unit.contact ? tickLabel(unit.contact.last_seen_tick) : '未知'}</dd></div>
        <div><dt>接触失效时间</dt><dd className="mono">{unit.contact ? tickLabel(unit.contact.expires_tick) : '未知'}</dd></div>
        <div><dt>当前信息年龄</dt><dd className="mono">{unit.contact ? Math.max(0, frame.tick - unit.contact.last_seen_tick) + ' tick' : '未知'}</dd></div>
      </> : <div><dt>连接状态</dt><dd className={`connection-value ${unit.connection}`}><span className={`connection-dot ${unit.connection}`} />{connectionNames[unit.connection]}</dd></div>}
    </dl>
    <div className="motion-estimate-note"><Compass size={12} /><span>{motion.kind === 'unknown' ? motion.reason : `${tickLabel(motion.fromTick)} → ${tickLabel(motion.toTick)} · ${contact ? '已收报告' : '公开帧'}位置差分`}。北 0°、东 90°，顺时针；不外推当前位置。</span></div>
    {contact ? <p className="contact-expiry-note">接触失效后会移出当前态势并归档，含义是信息过期；不是摧毁或失去战斗能力。报告采样时间与报告送达时间可能不同。</p> : <>
      <div className="readiness-metric"><div><span>合成可用度</span><strong>{pct(unit.readiness)}</strong></div><div className="meter-track"><span style={{ width: pct(unit.readiness) }} /></div><p>研究用无量纲状态，不代表现实装备能力。</p></div>
      <div className="inspector-section-heading"><h4>关联链路</h4><span>{links.length}</span></div>
      {links.length ? links.map(link => {
        const peer = frame.units.find(item => item.id === (link.from === unit.id ? link.to : link.from));
        return <div className="inspector-link" key={link.id}><Network size={13} /><div><strong>{peer?.model_label ?? '未知节点'}</strong><span>{link.latency_ticks} tick 延迟 · 质量 {pct(link.quality)}</span></div><span className={`connection-dot ${link.enabled ? 'online' : 'offline'}`} title={link.enabled ? '链路有效' : '链路中断'} /></div>;
      }) : <div className="empty-small">无接入链路</div>}
    </>}
  </div>;
}

export default App;
