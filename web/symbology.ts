import ms from 'milsymbol';
import type { SymbolMetadata } from 'milsymbol';
import type { Unit } from '../contracts/state';

export type SymbolUnit = Pick<Unit, 'domain' | 'side' | 'type_label' | 'connection'>;

interface SymbolDefinition {
  sidc: string;
  label: string;
}

export interface RenderedSymbol extends SymbolDefinition {
  dataUrl: string;
  width: number;
  height: number;
  anchor: { x: number; y: number };
  metadata: SymbolMetadata;
}

// Verified against milsymbol 3.0.4 src/lettersidc/sidc/{air,sea,subsurface,
// ground,space}.js and lettersidc/metadata.js. These are display categories,
// never capability assignments. Unrecognized labels retain their generic domain.
// APP6 selects the library's current drawing rules with 15-character SIDC input;
// it does not certify the application or freeze rendering to an older edition.
export function symbolDefinition(unit: Pick<SymbolUnit, 'domain' | 'side' | 'type_label'>): SymbolDefinition {
  let dimension: string;
  let functionId = '------';
  let label: string;
  switch (unit.domain) {
    case 'air':
      dimension = 'A';
      label = '通用空中符号';
      if (unit.type_label.includes('预警机')) {
        functionId = 'MFRW--';
        label = '固定翼预警机';
      } else if (unit.type_label.includes('战斗机')) {
        functionId = 'MFF---';
        label = '固定翼战斗机';
      } else if (unit.type_label.includes('巡逻机')) {
        functionId = 'MFP---';
        label = '固定翼巡逻机';
      }
      break;
    case 'surface':
      dimension = 'S';
      label = '通用水面符号';
      if (unit.type_label.includes('航母')) {
        functionId = 'CLCV--';
        label = '航空母舰';
      } else if (unit.type_label.includes('驱逐舰')) {
        functionId = 'CLDD--';
        label = '驱逐舰';
      }
      break;
    case 'subsurface':
      dimension = 'U';
      label = '通用水下符号';
      if (/潜艇|潜航/.test(unit.type_label)) {
        functionId = 'S-----';
        label = '潜艇';
      }
      break;
    case 'ground':
      dimension = 'G';
      functionId = 'U-----';
      label = '地面单位';
      if (unit.type_label.includes('指挥')) {
        functionId = 'UH----';
        label = '指挥节点';
      }
      break;
    case 'space':
      dimension = 'P';
      label = '通用空间符号';
      if (unit.type_label.includes('卫星')) {
        functionId = 'S-----';
        label = '卫星';
      }
      break;
  }
  return { sidc: `S${unit.side === 'blue' ? 'F' : 'H'}${dimension}P${functionId}-----`, label };
}

const cache = new Map<string, RenderedSymbol>();

export function getUnitSymbol(unit: SymbolUnit): RenderedSymbol {
  const definition = symbolDefinition(unit);
  // Opposing contact connection is not known truth and must not affect its symbol.
  const color = unit.side === 'red' ? '#e9aa74' : unit.connection === 'offline' ? '#72808b' : '#76d8cf';
  const key = `${definition.sidc}:${color}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const symbol = new ms.Symbol(definition.sidc, {
    standard: 'APP6', size: 24, strokeWidth: 5,
    fill: false, monoColor: color, infoFields: false,
  });
  if (!symbol.isValid()) throw new Error(`无效的显示符号编码：${definition.sidc}`);
  const rendered: RenderedSymbol = {
    ...definition,
    ...symbol.getSize(),
    anchor: symbol.getAnchor(),
    metadata: symbol.getMetadata(),
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(symbol.asSVG())}`,
  };
  cache.set(key, rendered);
  return rendered;
}

// Scale uniformly, then put the library's map anchor exactly at the unit coordinate.
// In particular, a headquarters is positioned at the staff tip, not its box center.
export function symbolPlacement(symbol: RenderedSymbol, size: number) {
  const scale = size / Math.max(symbol.width, symbol.height);
  return {
    x: -symbol.anchor.x * scale,
    y: -symbol.anchor.y * scale,
    width: symbol.width * scale,
    height: symbol.height * scale,
  };
}
