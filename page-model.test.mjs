import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReadingOrder, makeSpreads, spreadLabel, findSpreadIndex } from './page-model.js';

test('表紙、見開き、裏表紙を閲覧順で構成する', () => {
  const spreads = makeSpreads(makeReadingOrder(8));
  assert.deepEqual(spreads, [
    { kind: 'cover', pages: [1] },
    { kind: 'spread', pages: [2, 3] },
    { kind: 'spread', pages: [4, 5] },
    { kind: 'spread', pages: [6, 7] },
    { kind: 'back', pages: [8] },
  ]);
  assert.equal(spreadLabel(spreads[1]), '2–3ページ');
  assert.equal(findSpreadIndex(spreads, 7), 3);
});

test('奇数ページは裏表紙の前に空白を補う', () => {
  assert.deepEqual(makeSpreads(makeReadingOrder(7)).at(-2), { kind: 'spread', pages: [6, null] });
  assert.equal(spreadLabel(makeSpreads(makeReadingOrder(7)).at(-2)), '6ページ（右は空白）');
});

test('1ページと2ページのPDFも単独ページとして扱う', () => {
  assert.deepEqual(makeSpreads(makeReadingOrder(1)), [{ kind: 'cover', pages: [1] }]);
  assert.deepEqual(makeSpreads(makeReadingOrder(2)), [
    { kind: 'cover', pages: [1] },
    { kind: 'back', pages: [2] },
  ]);
});

test('PDFページ番号と表示順を分けて扱う', () => {
  const spreads = makeSpreads([1, 4, 3, 2]);
  assert.deepEqual(spreads[1].pages, [4, 3]);
  assert.equal(findSpreadIndex(spreads, 2), 2);
});
