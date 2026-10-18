/** PDFページ番号は1始まり。表示順をここで分離し、将来の並び替えに備える。 */
export function makeReadingOrder(pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new RangeError('pageCount must be positive');
  return Array.from({ length: pageCount }, (_, i) => i + 1);
}

export function makeSpreads(pageOrder) {
  if (!Array.isArray(pageOrder) || pageOrder.length === 0) return [];
  if (pageOrder.length === 1) return [{ kind: 'cover', pages: [pageOrder[0]] }];
  const result = [{ kind: 'cover', pages: [pageOrder[0]] }];
  for (let i = 1; i < pageOrder.length - 1; i += 2) {
    result.push({ kind: 'spread', pages: [pageOrder[i], i + 1 < pageOrder.length - 1 ? pageOrder[i + 1] : null] });
  }
  result.push({ kind: 'back', pages: [pageOrder.at(-1)] });
  return result;
}

export function spreadLabel(spread) {
  if (!spread) return '';
  if (spread.kind === 'cover') return `表紙 · ${spread.pages[0]}ページ`;
  if (spread.kind === 'back') return `裏表紙 · ${spread.pages[0]}ページ`;
  return spread.pages[1] == null
    ? `${spread.pages[0]}ページ（右は空白）`
    : `${spread.pages[0]}–${spread.pages[1]}ページ`;
}

export function findSpreadIndex(spreads, pdfPage) {
  return spreads.findIndex(spread => spread.pages.includes(pdfPage));
}
