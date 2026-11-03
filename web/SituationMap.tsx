import type { Frame } from '../contracts/state';
import { deriveMotion, headingLabel, projectedMotionVector, shortMotionLabel, speedLabel } from './motion';
import { UnitSymbol } from './UnitSymbol';
import { getUnitSymbol, symbolPlacement } from './symbology';

function Terrain() {
  return <g>
    <g fill="none" stroke="#203646" strokeWidth="1" opacity=".45">
      <path d="M-40 110C120 10 238 150 326 120S412 180 389 255 415 330 458 361 438 464 475 501 517 627 430 730" />
      <path d="M-40 140C115 53 236 181 309 153S379 195 360 267 386 345 427 377 404 464 447 518 475 628 401 730" />
      <path d="M-40 172C116 83 222 213 292 184S347 220 331 282 357 356 397 395 376 477 419 537 440 636 371 730" />
      <path d="M520-40C458 65 523 145 572 187S525 278 571 309 682 314 668 383 737 451 785 476 789 609 1050 555" />
      <path d="M553-40C500 66 554 126 606 166S563 253 604 277 721 301 703 374 760 414 819 454 835 574 1050 523" />
      <path d="M587-40C540 62 587 108 644 147S604 230 641 249 757 278 741 362 790 393 856 426 875 541 1050 490" />
    </g>
    <g fill="#142a34" stroke="#36515a" strokeWidth="1.5">
      <path d="M-20 0H302l-21 29-37 10-9 23-35-2-14 27-30-8-20 23-30-11-17 16-23-5-12 28-35 10-29-18-20 15Z" />
      <path d="m417 139 19 13 10 35-6 20 18 21-4 33 17 26-7 20 13 33-12 17-6 34-19 20-7 34-14 13-6 30-15 8-4-24 6-21-8-31 8-22-7-18 9-26-6-26 14-28-3-30 14-20-3-35 13-18Z" />
      <path d="m488 472 16 5 4 25-13 14-9-14Z" />
      <path d="m529 532 13-8 21 17-5 20-20 3-13-17Z" />
      <path d="m573 600 31-9 35 22 22-7 26 20 8 28 31 12 7 34H574l-9-26 14-23-13-25Z" />
      <path d="m738 89 19-13 24 9 16 27 24 4 7 21-20 10-25-20-21 1-11-18Z" />
      <path d="m851 158 18 3 9 20-10 9-18-11Z" />
      <path d="m900 210 14 0 12 14-4 13-18-3Z" />
      <path d="m341 385 13-9 7 10-5 20-14-3Z" />
    </g>
    <g fill="none" stroke="#395047" strokeWidth="1" opacity=".6">
      <path d="m427 185-10 46 11 32-11 33 19 40-17 44 6 24-17 38" />
      <path d="m438 240-7 42 16 30-7 47-11 13" />
      <path d="m0 57 42 16 32-20 40 13 42-28 27 9 42-23" />
      <path d="m592 632 23-13 28 30 26-2 19 24" />
    </g>
    <g fill="#617b87" fontSize="10" fontFamily="inherit" letterSpacing="3" opacity=".8">
      <text x="130" y="45">北 陆</text><text x="466" y="359">中 央 岛</text><text x="601" y="684">南 环 岛</text>
      <text x="800" y="105" fontSize="8">东 部 岛 链</text>
      <text x="640" y="350" fill="#34505e" fontSize="14" letterSpacing="8">澄 海</text>
      <text x="173" y="507" fill="#34505e" fontSize="11" letterSpacing="6">西 部 水 域</text>
    </g>
  </g>;
}

interface Props {
  frame: Frame;
  history: Frame[];
  selected: string | null;
  onSelect: (id: string) => void;
  linksVisible: boolean;
  labelsVisible: boolean;
  running: boolean;
}

export default function SituationMap({ frame, history, selected, onSelect, linksVisible, labelsVisible, running }: Props) {
  const visibleUnits = frame.units.filter(unit => unit.side === 'blue' || (unit.contact && unit.contact.first_seen_tick <= frame.tick && unit.contact.expires_tick > frame.tick));
  const byId = new Map(visibleUnits.map(unit => [unit.id, unit]));
  const historyTail = history.filter(item => item.tick <= frame.tick).slice(-15);
  return <svg className={`situation-svg ${running ? 'is-running' : ''}`} viewBox="0 0 1000 700" role="group" aria-label="虚构澄海区域的合成节点态势图，坐标为零至一百的无量纲网格">
    <defs>
      <pattern id="grid-small" width="50" height="35" patternUnits="userSpaceOnUse"><path d="M50 0H0V35" fill="none" stroke="#1d3443" strokeWidth=".65" /></pattern>
      <pattern id="grid-large" width="100" height="70" patternUnits="userSpaceOnUse"><rect width="100" height="70" fill="url(#grid-small)" /><path d="M100 0H0V70" fill="none" stroke="#294352" strokeWidth=".75" /></pattern>
      <radialGradient id="map-light"><stop stopColor="#142b3a" /><stop offset="1" stopColor="#0a1825" /></radialGradient>
      <filter id="node-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3" /></filter>
    </defs>
    <rect width="1000" height="700" fill="url(#map-light)" />
    <rect width="1000" height="700" fill="url(#grid-large)" opacity=".65" />
    <Terrain />
    <g fill="#45606f" fontSize="9" fontFamily="monospace">{[10, 20, 30, 40, 50, 60, 70, 80, 90].map(n => <g key={n}><text x={n * 10 + 5} y="17">{n.toString().padStart(2, '0')}</text><text x="8" y={n * 7 - 4}>{n.toString().padStart(2, '0')}</text></g>)}</g>
    <g className="map-trails" fill="none" strokeWidth="1.5">{visibleUnits.flatMap(unit => {
      // A missing or expired contact breaks the trail. Never join across an unknown interval.
      const segments: string[][] = [[]];
      for (const item of historyTail) {
        const past = item.units.find(candidate => candidate.id === unit.id);
        const known = past && (past.side === 'blue' || (past.contact && past.contact.first_seen_tick <= item.tick && past.contact.expires_tick > item.tick));
        if (!known || (unit.contact && item.tick < unit.contact.first_seen_tick)) {
          if (segments.at(-1)!.length) segments.push([]);
          continue;
        }
        segments.at(-1)!.push(`${past.x * 10},${past.y * 7}`);
      }
      return segments.filter(points => points.length > 1).map((points, index) => <polyline key={`${unit.id}-${index}`} points={points.join(' ')} stroke={unit.side === 'blue' ? '#5cc7c4' : '#d59b67'} opacity={unit.id === selected ? '.55' : '.15'} />);
    })}</g>
    {linksVisible && <g className="map-links" fill="none">{frame.links.map(link => {
      const from = byId.get(link.from), to = byId.get(link.to);
      if (!from || !to || from.side !== 'blue' || to.side !== 'blue') return null;
      return <g key={link.id}><line x1={from.x * 10} y1={from.y * 7} x2={to.x * 10} y2={to.y * 7} stroke={link.enabled ? '#398b94' : '#a56b51'} opacity={link.enabled ? .22 + link.quality * .25 : .3} strokeWidth={selected === from.id || selected === to.id ? 1.7 : 1} strokeDasharray={link.enabled ? '3 7' : '3 10'} className={link.enabled ? 'link-flow' : ''} /><title>{`${from.name} → ${to.name} · ${link.enabled ? `质量 ${Math.round(link.quality * 100)}%` : '链路中断'}`}</title></g>;
    })}</g>}
    {visibleUnits.map(unit => {
      const isSelected = selected === unit.id;
      const color = unit.side === 'blue' ? '#76d8cf' : '#e9aa74';
      const motion = deriveMotion(unit.id, frame, history);
      const vector = projectedMotionVector(motion);
      const symbol = getUnitSymbol(unit);
      const bounds = symbolPlacement(symbol, 34);
      const labelLeft = unit.x > 85 || (unit.x > 15 && vector !== null && vector.x > 10);
      const textOffset = labelLeft ? Math.min(-25, bounds.x - 8) : Math.max(25, bounds.x + bounds.width + 8);
      const vectorLength = vector ? Math.hypot(vector.x, vector.y) : 1;
      const ux = vector ? vector.x / vectorLength : 0;
      const uy = vector ? vector.y / vectorLength : 0;
      return <g key={unit.id} className={`map-unit ${isSelected ? 'selected' : ''}`} transform={`translate(${unit.x * 10} ${unit.y * 7})`} onClick={() => onSelect(unit.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(unit.id); } }} tabIndex={0} role="button" aria-pressed={isSelected} aria-label={`查看${unit.name}，${unit.model_label}，${unit.side === 'red' ? `已发现接触，最近报告采样第 ${unit.contact?.last_seen_tick ?? '未知'} 步` : unit.connection === 'online' ? '连接正常' : unit.connection === 'offline' ? '连接离线' : '连接降级'}`}>
        <title>{unit.name} · {unit.model_label}{unit.conceptual ? ' · 概念标签' : ''}{unit.contact ? ` · 最近报告 T+${unit.contact.last_seen_tick} · 失效 T+${unit.contact.expires_tick}` : ''}{` · 差分速度 ${speedLabel(motion)} · 网格航向 ${headingLabel(motion)}。箭头仅示意方向，符号本体不表示航向。`}</title>
        <rect x={Math.min(-23, bounds.x - 5)} y={Math.min(-23, bounds.y - 5)} width={Math.max(46, bounds.x + bounds.width + 5 - Math.min(-23, bounds.x - 5))} height={Math.max(46, bounds.y + bounds.height + 5 - Math.min(-23, bounds.y - 5))} fill="transparent" />
        {vector && <g className="motion-vector" fill="none" stroke={color} strokeWidth={isSelected ? 1.7 : 1.25} opacity={isSelected ? '.9' : '.65'} pointerEvents="none">
          <line x1={ux * 18} y1={uy * 18} x2={vector.x} y2={vector.y} />
          <path d={`M${vector.x - ux * 6 - uy * 3.5} ${vector.y - uy * 6 + ux * 3.5}L${vector.x} ${vector.y} ${vector.x - ux * 6 + uy * 3.5} ${vector.y - uy * 6 - ux * 3.5}`} />
        </g>}
        {isSelected && <><circle r="25" stroke={color} strokeWidth="1" strokeDasharray="5 5" opacity=".6" fill="none" /><path d="M-31-17v-14h14M17-31h14v14M31 17v14H17M-17 31h-14V17" stroke={color} strokeWidth="1.5" fill="none" /></>}
        <circle r="13" fill={color} opacity=".12" filter="url(#node-glow)" />
        <UnitSymbol unit={unit} size={34} anchored />
        {unit.side === 'red' ? <circle cx="17" cy="-13" r="2.5" fill="#0b1c29" stroke={color} strokeWidth="1" /> : <circle cx="17" cy="-13" r="2.5" fill={unit.connection === 'online' ? color : unit.connection === 'degraded' ? '#e6bb6d' : '#697887'} />}
        {labelsVisible && <g textAnchor={labelLeft ? 'end' : 'start'}><text x={textOffset} y="-3" fill={isSelected ? '#eff8fa' : unit.side === 'blue' ? '#aacbd0' : '#c8b7a6'} fontSize="11" fontWeight={isSelected ? '600' : '400'} paintOrder="stroke" stroke="#0b1b28" strokeWidth="4">{unit.model_label}{unit.conceptual ? ' *' : ''}</text><text x={textOffset} y="11" fill={isSelected ? '#9fbec8' : '#6a8795'} fontSize="8" letterSpacing=".1" paintOrder="stroke" stroke="#0b1b28" strokeWidth="3">{shortMotionLabel(motion)}</text></g>}
      </g>;
    })}
    <g transform="translate(954 56)" fill="none" stroke="#69808e"><path d="M0-14V14M-9 5 0-14 9 5" strokeWidth="1" /><text x="0" y="-23" textAnchor="middle" stroke="none" fill="#92a9b6" fontSize="10">N</text></g>
    <g transform="translate(30 663)" fontSize="8" fill="#657e8b" fontFamily="monospace"><path d="M0-6v6h100v-6M50-5v5" stroke="#657e8b" fill="none" /><text x="0" y="14">0</text><text x="45" y="14">5</text><text x="91" y="14">10</text><text x="116" y="1">GRID UNITS / 无量纲</text></g>
  </svg>;
}
