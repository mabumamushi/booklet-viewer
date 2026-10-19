import test from 'node:test';
import assert from 'node:assert/strict';
import { findStrokeAt, readSavedPages } from './ink-model.js';

test('消しゴムは線分上の接点から最前面の線を選ぶ', () => {
  const line = (color, y) => ({ tool: 'pen', color, width: 0.003, points: [{ x: 0.1, y }, { x: 0.9, y }] });
  const strokes = [line('#c63f35', 0.5), line('#3869a6', 0.5)];
  assert.equal(findStrokeAt(strokes, { x: 0.5, y: 0.5 }, 1.4), 1);
  assert.equal(findStrokeAt(strokes, { x: 0.5, y: 0.8 }, 1.4), -1);
});

test('保存データはPDFページ範囲と座標を検証して読み込む', () => {
  const valid = { tool: 'marker', color: '#e5bc35', width: 0.02, points: [{ x: 0.2, y: 0.3 }] };
  const pages = readSavedPages({ 2: [valid, { ...valid, points: [{ x: 2, y: 0.3 }] }], 9: [valid] }, 6);
  assert.deepEqual([...pages.keys()], [2]);
  assert.deepEqual(pages.get(2), [valid]);
});
