import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Mail, PanelsTopLeft } from 'lucide-react';
import type { CenterView, FieldAudit, FieldStatus, ReceiptDelivery, ReceiptStudy } from '../contracts/receipt';
import type { DecisionEvent, Frame } from '../contracts/state';
import { request } from './api';
import { eventsAtFrame } from './decisions';
import { parseReceiptStudy } from './receiptArchive';
import './strategy-study.css';
import './receipt-study.css';

type Access = { mode: 'live'; runId: string; online: boolean } | { mode: 'archive'; studies: ReceiptStudy[] };
const times = (at: number) => 'T+' + at;
const conditions: Record<ReceiptDelivery, string> = { delivered: '回执送达', lost: '回执未达' };
const statusText: Record<FieldStatus, string> = { sampled_buffered: '已采样并缓存', not_sampled: '尚未采样' };

function Center({ value, side }: { value: CenterView; side: string }) {
  const { request: local, knowledge, receipts } = value;
  return <section className="study-branch" aria-label={'中心 ' + side}>
    <header><Mail size={16} /><h2>中心 {side}</h2></header>
    <div className="study-branch-body receipt-center">
      <div className="study-finding"><small>中心判断</small><strong>{knowledge
        ? times(knowledge.as_of_tick) + ' 现场' + statusText[knowledge.status] : '现场状态未知'}</strong></div>
      {knowledge && <p className="receipt-citation">{times(knowledge.known_tick)} 首次知悉 · 引用 <code>{knowledge.receipt_id}</code></p>}
      <dl className="receipt-facts">
        <div><dt>本地链路</dt><dd>{value.link_enabled ? '在线' : '中断'}</dd></div>
        <div><dt>观测请求</dt><dd>{local ? <><code>{local.id}</code> · {times(local.approved_tick)} 批准 #{local.approval_seq}</> : '尚未批准'}</dd></div>
        <div><dt>预期采样</dt><dd>{value.expected_tick === null ? '尚未登记' : times(value.expected_tick) + '（本地计划）'}</dd></div>
      </dl>
      <h3>已收回执 <small>{receipts.length} 份</small></h3>
      {receipts.length === 0 ? <p className="receipt-empty">截至本步，中心未收到现场状态回执。</p> : receipts.map(r =>
        <article className="receipt-message" key={r.id}>
          <strong>现场状态回执</strong><code>{r.id}</code>
          <dl className="receipt-facts">
            <div><dt>来源</dt><dd><code>{r.source_id}</code></dd></div>
            <div><dt>关联请求</dt><dd><code>{r.case_id}</code></dd></div>
            <div><dt>回执正文</dt><dd>截至 {times(r.as_of_tick)}，现场{statusText[r.status]}。</dd></div>
            {r.sampled_tick !== null && <div><dt>采样时刻</dt><dd>{times(r.sampled_tick)}</dd></div>}
            <div><dt>传输</dt><dd>{times(r.sent_tick)} 发出 → {times(r.received_tick)} 中心收到</dd></div>
          </dl>
        </article>)}
    </div>
  </section>;
}

function FieldRecord({ audit, at, side }: { audit: FieldAudit; at: number; side: string }) {
  return <section><h3>现场 {side}</h3>
    {at < audit.as_of_tick ? <p>截至本步，底稿尚无状态记录。</p> : <p>{times(audit.as_of_tick)} · {statusText[audit.status]}</p>}
    {at >= audit.sent_tick && <p>{times(audit.sent_tick)} 发出 <code>{audit.receipt_id}</code></p>}
    {audit.received_tick !== null && at >= audit.received_tick && <p>{times(audit.received_tick)} 到达中心</p>}
  </section>;
}

function download(study: ReceiptStudy) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(study, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'c5isr-receipt-' + study.approval_seq + '-' + study.delivery + '.json';
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface SwitchCondition {
  choices: ReceiptDelivery[];
  busy: boolean;
  error: string | null;
  change: (delivery: ReceiptDelivery) => void;
}
export function ReceiptStudyPanel({ study, initialTick, substep, onClose, switcher }: {
  study: ReceiptStudy; initialTick?: number; substep?: boolean; onClose: () => void; switcher?: SwitchCondition;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [at, setAt] = useState(Math.max(study.start_tick, Math.min(initialTick ?? study.start_tick, study.end_tick)));
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  const frame = study.frames[Math.min(at - study.start_tick, study.frames.length - 1)];
  return createPortal(<dialog ref={dialog} className="study-dialog receipt-dialog" aria-labelledby="receipt-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="study-wrap">
      <header className="study-mast"><div><PanelsTopLeft size={22} /><h1 id="receipt-title">中心何时知道现场状态</h1></div>
        <button type="button" onClick={onClose} autoFocus><ArrowLeft size={14} />返回回放</button></header>
      <p className="study-context">同一份观测请求、同一次断链。逐步查看两边中心收到的消息和判断依据。{substep && '原案游标位于步内事件，打开时定位至上一完整步。'}</p>
      <div className="study-material-switch">
        {switcher && switcher.choices.length > 1 ? <label>传输条件
          <select aria-label="回执送达条件" value={study.delivery} disabled={switcher.busy}
            onChange={e => { setReveal(false); switcher.change(e.target.value as ReceiptDelivery); }}>
            {switcher.choices.map(d => <option key={d} value={d}>{conditions[d]}</option>)}
          </select></label> : <span>传输条件 · {conditions[study.delivery]}</span>}
        {switcher?.busy && <small role="status">读取回放中…</small>}
        {switcher?.error && <span role="alert">{switcher.error}</span>}
      </div>
      <section className="study-timeline" aria-label="两边中心共用的时间轴">
        <div className="study-current"><small>{frame.tick === study.end_tick ? '回放截止' : '本步结束时'}</small><strong>{times(frame.tick)}</strong></div>
        <button type="button" aria-label="上一知情帧" disabled={frame.tick <= study.start_tick} onClick={() => setAt(frame.tick - 1)}><ChevronLeft size={17} /></button>
        <label><span>{times(study.start_tick)}<span>{times(study.end_tick)}</span></span>
          <input type="range" aria-label="中心知情时间轴" min={study.start_tick} max={study.end_tick} value={frame.tick} onChange={e => setAt(Number(e.target.value))} /></label>
        <button type="button" aria-label="下一知情帧" disabled={frame.tick >= study.end_tick} onClick={() => setAt(frame.tick + 1)}><ChevronRight size={17} /></button>
        <button type="button" className="study-end" disabled={frame.tick >= study.end_tick} onClick={() => setAt(study.end_tick)}>到末步</button>
      </section>
      <div className="study-pair receipt-pair"><Center value={frame.buffered} side="A" /><Center value={frame.not_sampled} side="B" /></div>
      <footer className="receipt-footer">
        <button type="button" aria-expanded={reveal} aria-controls="receipt-director" onClick={() => setReveal(!reveal)}>{reveal ? '收起现场底稿' : '展开现场底稿'}</button>
        <button type="button" onClick={() => download(study)}><Download size={14} />导出知情回放</button>
      </footer>
      {reveal && <section id="receipt-director" className="receipt-director" aria-label="导演视角的现场底稿">
        <h2>现场底稿 <small>导演视角 · 截至 {times(frame.tick)}</small></h2>
        <div><FieldRecord audit={study.field_audit.buffered} at={frame.tick} side="A" /><FieldRecord audit={study.field_audit.not_sampled} at={frame.tick} side="B" /></div>
      </section>}
    </div></dialog>, document.body);
}

function possibleCases(events: DecisionEvent[], access: Access) {
  const relatedById = new Map<string, DecisionEvent[]>();
  if (access.mode === 'live') {
    for (const e of events) {
      const list = relatedById.get(e.proposal_id);
      if (list) list.push(e);
      else relatedById.set(e.proposal_id, [e]);
    }
  }
  return events.filter(e => {
    if (e.kind !== 'approved') return false;
    if (access.mode === 'archive') return access.studies.some(s => s.approval_seq === e.seq && s.case_id === e.proposal_id);
    const related = relatedById.get(e.proposal_id)!;
    const stored = related.find(row => ['buffered', 'sent', 'dropped', 'expired'].includes(row.kind));
    return stored?.kind === 'buffered' && stored.tick === stored.sampled_tick
      && related.some(row => row.kind === 'received' && row.report_id === stored.report_id);
  });
}

export function ReceiptEntry({ access, frame, log, cursor }: {
  access: Access; frame: Frame; log?: DecisionEvent[]; cursor?: number | null;
}) {
  const cases = possibleCases(eventsAtFrame(log, frame, cursor), access);
  const [selection, setSelection] = useState<number | undefined>();
  const selected = cases.find(c => c.seq === selection) ?? cases.at(-1);
  const choices = (Object.keys(conditions) as ReceiptDelivery[]).filter(d => access.mode === 'live' ||
    access.studies.some(s => s.approval_seq === selected?.seq && s.delivery === d));
  const [opened, setOpened] = useState<ReceiptStudy | null>(null);
  const [origin, setOrigin] = useState({ tick: frame.tick, substep: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  if (!selected || !choices.length) return null;
  if (access.mode === 'archive' && cursor != null && frame.decision_seq != null && cursor < frame.decision_seq
    && access.studies.some(s => s.approval_seq === selected.seq && s.start_tick === frame.tick)) return null;
  async function open(delivery: ReceiptDelivery) {
    if (!selected) return;
    setSelection(selected.seq);
    const attempt = ++generation.current;
    setError(null); setBusy(true);
    try {
      const data = access.mode === 'archive' ? access.studies.find(s => s.approval_seq === selected.seq && s.delivery === delivery)! :
        parseReceiptStudy(await request('/api/receipt-study', { run_id: access.runId, case_id: selected.proposal_id,
          approval_seq: selected.seq, delivery }, { timeoutMs: 10000 }));
      if (attempt !== generation.current) return;
      if (!opened) {
        const arrival = log?.find(e => e.proposal_id === data.case_id && e.kind === 'received' && e.tick === data.end_tick);
        const boundary = frame.tick === data.end_tick ? arrival?.seq : frame.decision_seq;
        const substep = cursor != null && boundary != null && cursor < boundary && frame.tick <= data.end_tick;
        setOrigin({ tick: frame.tick - (substep ? 1 : 0), substep });
      }
      setOpened(data);
    } catch (err) { if (attempt === generation.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (attempt === generation.current) setBusy(false); }
  }
  return <section className="receipt-entry" aria-label="中心知情回放入口">
    {cases.length > 1 && <select aria-label="选择知情对照事项" disabled={busy} value={selected.seq}
      onChange={e => { setSelection(Number(e.target.value)); setError(null); }}>
      {cases.map(c => <option value={c.seq} key={c.seq}>{c.proposal_id} · #{c.seq}</option>)}</select>}
    <button type="button" disabled={busy || (access.mode === 'live' && !access.online)} onClick={() => void open(choices[0])}><PanelsTopLeft size={15} />中心知情对照</button>
    {busy && <small role="status">正在读取…</small>}
    {error && !opened && <p role="alert">{error}</p>}
    {opened && <ReceiptStudyPanel study={opened} initialTick={origin.tick} substep={origin.substep}
      switcher={{choices, busy, error, change: d => void open(d)}}
      onClose={() => { generation.current++; setOpened(null); setError(null); setBusy(false); }} />}
  </section>;
}
