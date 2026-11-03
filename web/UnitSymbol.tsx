import { getUnitSymbol, symbolPlacement } from './symbology';
import type { SymbolUnit } from './symbology';

export function UnitSymbol({ unit, size = 24, anchored = false }: { unit: SymbolUnit; size?: number; anchored?: boolean }) {
  const symbol = getUnitSymbol(unit);
  const placement = anchored ? symbolPlacement(symbol, size) : { width: size, height: size };
  return <svg {...placement} viewBox={`0 0 ${symbol.width} ${symbol.height}`} preserveAspectRatio="xMidYMid meet" className="unit-symbol-svg" aria-hidden="true" data-sidc={symbol.sidc}>
    <image href={symbol.dataUrl} width={symbol.width} height={symbol.height} />
  </svg>;
}

const legendDomains = [
  ['air', '空中'], ['surface', '水面'], ['subsurface', '水下'], ['ground', '地面'], ['space', '空间'],
] as const;

// Static domain examples: this table never reads the scene or hidden contacts.
export function SymbolLegend() {
  return <div className="symbol-comparison" role="table" aria-label="APP6 符号双方域别对照">
    <div role="row" className="symbol-comparison-head"><span role="columnheader">域 / 阵营</span>{legendDomains.map(([domain, label]) => <span key={domain} role="columnheader">{label}</span>)}</div>
    {(['blue', 'red'] as const).map(side => <div role="row" key={side}><span role="rowheader">{side === 'blue' ? '我方' : '对照方'}</span>{legendDomains.map(([domain, label]) => <span key={domain} role="cell" aria-label={`${side === 'blue' ? '我方' : '对照方'}${label}`}><UnitSymbol unit={{ side, domain, type_label: '', connection: 'online' }} size={29} /></span>)}</div>)}
  </div>;
}
