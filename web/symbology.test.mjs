import assert from 'node:assert/strict';
import test from 'node:test';
import ms from 'milsymbol';
import { getUnitSymbol, symbolPlacement } from './symbology.ts';

const unit = (domain, type_label = '', side = 'blue', connection = 'online') => ({ domain, type_label, side, connection });

test('both sides resolve actual library categories without losing domain, space modifier or frame differences', () => {
  const categories = [
    ['air', '战斗机符号', 'Air', 'MFF---'],
    ['air', '预警机符号', 'Air', 'MFRW--'],
    ['air', '巡逻机符号', 'Air', 'MFP---'],
    ['air', '用户指定概念航空符号', 'Air', '------'],
    ['surface', '航母符号', 'Sea', 'CLCV--'],
    ['surface', '驱逐舰符号', 'Sea', 'CLDD--'],
    ['subsurface', '用户指定概念潜航符号', 'Subsurface', 'S-----'],
    ['ground', '合成指挥节点', 'Ground', 'UH----'],
    ['space', '卫星符号', 'Air', 'S-----'],
  ];
  for (const [domain, label, dimension, functionid] of categories) {
    const friendly = getUnitSymbol(unit(domain, label));
    const opposing = getUnitSymbol(unit(domain, label, 'red'));
    for (const [symbol, affiliation] of [[friendly, 'Friend'], [opposing, 'Hostile']]) {
      assert.equal(new ms.Symbol(symbol.sidc, { standard: 'APP6' }).isValid(), true, symbol.sidc);
      assert.equal(symbol.metadata.affiliation, affiliation);
      assert.equal(symbol.metadata.dimension, dimension);
      assert.equal(symbol.metadata.functionid, functionid);
      assert.equal(Boolean(symbol.metadata.space), domain === 'space');
      assert.equal(Boolean(symbol.metadata.headquarters), domain === 'ground');
    }
    assert.notDeepEqual(friendly.metadata.baseGeometry, opposing.metadata.baseGeometry, `${domain} must distinguish sides`);
  }
  const air = getUnitSymbol(unit('air'));
  const sea = getUnitSymbol(unit('surface'));
  const sub = getUnitSymbol(unit('subsurface'));
  assert.notDeepEqual(air.metadata.baseGeometry, sea.metadata.baseGeometry);
  assert.notDeepEqual(sub.metadata.baseGeometry, sea.metadata.baseGeometry);
  assert.notDeepEqual(sub.metadata.baseGeometry, air.metadata.baseGeometry);
});

test('map placement preserves the library anchor and aspect ratio, including off-center headquarters staff', () => {
  for (const side of ['blue', 'red']) {
    for (const [domain, label] of [['ground', '合成指挥节点'], ['space', '卫星符号'], ['air', '预警机符号'], ['subsurface', '潜艇符号']]) {
      const symbol = getUnitSymbol(unit(domain, label, side));
      const rect = symbolPlacement(symbol, 34);
      const scale = rect.width / symbol.width;
      assert.ok(Math.abs(rect.height / symbol.height - scale) < 1e-12);
      assert.ok(Math.abs(rect.x + symbol.anchor.x * scale) < 1e-12);
      assert.ok(Math.abs(rect.y + symbol.anchor.y * scale) < 1e-12);
      assert.ok(Math.max(rect.width, rect.height) <= 34 + 1e-12);
      if (domain === 'ground') assert.ok(symbol.anchor.x < symbol.width / 4, 'HQ must not be silently centered');
    }
  }
});

test('cache reuses symbols, own offline status turns grey, contact connection does not imply known status', () => {
  const online = getUnitSymbol(unit('air', '预警机符号'));
  assert.strictEqual(online, getUnitSymbol(unit('air', '预警机符号')));
  assert.notEqual(online.dataUrl, getUnitSymbol(unit('air', '预警机符号', 'blue', 'offline')).dataUrl);
  assert.strictEqual(getUnitSymbol(unit('air', '预警机符号', 'red')), getUnitSymbol(unit('air', '预警机符号', 'red', 'offline')));
});
