
import * as pdfjs from './vendor/pdf.min.mjs';
import { makeReadingOrder, makeSpreads, spreadLabel, findSpreadIndex } from './page-model.js';
import { clamp01, strokePath, findStrokeAt, readSavedPages } from './ink-model.js';
import { loadInk, saveInk } from './ink-store.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = id => document.getElementById(id);
const ui = Object.fromEntries([
  'app','uploadButton','emptyUpload','fileInput','searchToggle','searchClose','searchPanel','searchForm','searchInput','searchSummary','searchResults',
  'documentInfo','documentName','documentMeta','viewActions','reader','emptyState','readerViewport','zoomShell','bookSurface','dropOverlay',
  'loadingOverlay','loadingText','toast','pagination','prevButton','nextButton','pageRange','positionLabel','rangeTooltip',
  'zoomIn','zoomOut','zoomFit','zoomValue','inkToggle','exportButton','inkToolbar','inkWidth','inkUndo','inkRedo','inkSaveStatus'
].map(id => [id, $(id)]));

const state = {
  pdf: null, fileName: '', pageOrder: [], spreads: [], currentIndex: 0, zoom: 1,
  pageWidth: 340, pageHeight: 480, imageCache: new Map(), pendingImages: new Map(),
  navigationId: 0, loadId: 0, searchId: 0, imageEpoch: 0, isTurning: false, searchMatches: [], toastTimer: null, zoomTimer: null,
  originalBytes: null, documentId: null, annotations: new Map(), pageGeometry: new Map(),
  inkMode: false, inkTool: 'pen', inkColor: '#c63f35', inkSize: 2, activeInk: null, lastPenAt: 0,
  undoStack: [], redoStack: [], saveQueue: Promise.resolve(), exportBusy: false,
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 4500);
}

function setLoading(isLoading, message = 'PDFを読み込み中…') {
  ui.loadingText.textContent = message;
  ui.loadingOverlay.hidden = !isLoading;
}

function clearImages() {
  state.imageEpoch++;
  for (const url of state.imageCache.values()) URL.revokeObjectURL(url);
  state.imageCache.clear();
  state.pendingImages.clear();
}

function applyGeometry(spread) {
  const isSingle = spread.kind !== 'spread';
  const width = state.pageWidth * (isSingle ? 1 : 2);
  const height = state.pageHeight;
  const surface = ui.bookSurface;
  surface.style.setProperty('--page-width', `${state.pageWidth}px`);
  surface.style.setProperty('--page-height', `${state.pageHeight}px`);
  surface.style.width = `${width}px`;
  surface.style.height = `${height}px`;
  surface.style.transform = `scale(${state.zoom})`;
  ui.zoomShell.style.width = `${width * state.zoom}px`;
  ui.zoomShell.style.height = `${height * state.zoom}px`;
}

function applyAnimationGeometry() {
  const width = state.pageWidth * 2;
  ui.bookSurface.style.width = `${width}px`;
  ui.bookSurface.style.height = `${state.pageHeight}px`;
  ui.bookSurface.style.transform = `scale(${state.zoom})`;
  ui.zoomShell.style.width = `${width * state.zoom}px`;
  ui.zoomShell.style.height = `${state.pageHeight * state.zoom}px`;
}

function widthForTool(tool = state.inkTool) {
  return tool === 'marker' ? 0.012 + state.inkSize * 0.004 : 0.0012 + state.inkSize * 0.0011;
}

function pageInkLayer(pageNumber) {
  const geometry = state.pageGeometry.get(pageNumber);
  if (!geometry) return null;
  const scale = Math.min(state.pageWidth / geometry.width, state.pageHeight / geometry.height);
  const width = geometry.width * scale;
  const height = geometry.height * scale;
  const aspect = geometry.height / geometry.width;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('ink-layer');
  svg.dataset.page = String(pageNumber);
  svg.style.left = `${(state.pageWidth - width) / 2}px`;
  svg.style.top = `${(state.pageHeight - height) / 2}px`;
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  svg.setAttribute('viewBox', `0 0 1000 ${1000 * aspect}`);
  svg.setAttribute('aria-label', `${pageNumber}ページの書き込み`);
  for (const stroke of state.annotations.get(pageNumber) || []) svg.append(strokeNode(stroke, aspect));
  return svg;
}

function strokeNode(stroke, aspect) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', strokePath(stroke, aspect));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', stroke.color);
  path.setAttribute('stroke-width', String(stroke.width * 1000));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  if (stroke.tool === 'marker') path.setAttribute('stroke-opacity', '.28');
  return path;
}

function pageNode(pageNumber, extraClass = '') {
  const page = document.createElement('div');
  page.className = `page ${extraClass}`.trim();
  if (pageNumber == null) {
    page.classList.add('blank');
    page.setAttribute('aria-label', '空白ページ');
    return page;
  }
  page.setAttribute('aria-label', `${pageNumber}ページ`);
  const url = state.imageCache.get(pageNumber);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = `${pageNumber}ページ`;
    img.draggable = false;
    page.append(img);
  } else {
    page.classList.add('loading');
  }
  const inkLayer = pageInkLayer(pageNumber);
  if (inkLayer) page.append(inkLayer);
  const number = document.createElement('span');
  number.className = 'page-number';
  number.textContent = String(pageNumber);
  page.append(number);
  return page;
}

function renderSpread(index) {
  const spread = state.spreads[index];
  applyGeometry(spread);
  const element = document.createElement('div');
  element.className = `spread ${spread.kind === 'spread' ? 'double' : 'single'}`;
  if (spread.kind === 'spread') {
    element.append(pageNode(spread.pages[0]), pageNode(spread.pages[1]));
  } else {
    element.append(pageNode(spread.pages[0], spread.kind === 'cover' ? 'cover' : 'back-cover'));
  }
  ui.bookSurface.replaceChildren(element);
}

async function imageFor(pageNumber) {
  if (pageNumber == null || !state.pdf) return;
  if (state.imageCache.has(pageNumber)) return state.imageCache.get(pageNumber);
  if (state.pendingImages.has(pageNumber)) return state.pendingImages.get(pageNumber);
  const pdf = state.pdf;
  const epoch = state.imageEpoch;
  const promise = (async () => {
    const page = await pdf.getPage(pageNumber);
    const unscaled = page.getViewport({ scale: 1 });
    state.pageGeometry.set(pageNumber, { width: unscaled.width, height: unscaled.height });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const scale = state.pageWidth * pixelRatio / unscaled.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    await page.render({ canvasContext: context, canvas, viewport }).promise;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob || pdf !== state.pdf || epoch !== state.imageEpoch) return;
    const url = URL.createObjectURL(blob);
    state.imageCache.set(pageNumber, url);
    return url;
  })().finally(() => {
    if (state.pendingImages.get(pageNumber) === promise) state.pendingImages.delete(pageNumber);
  });
  state.pendingImages.set(pageNumber, promise);
  return promise;
}

async function ensureSpreadImages(index) {
  const spread = state.spreads[index];
  if (!spread) return;
  await Promise.all(spread.pages.filter(Boolean).map(imageFor));
}

function trimImageCache() {
  if (state.imageCache.size <= 18) return;
  const keep = new Set();
  for (let i = Math.max(0, state.currentIndex - 2); i <= Math.min(state.spreads.length - 1, state.currentIndex + 2); i++) {
    for (const p of state.spreads[i].pages) if (p) keep.add(p);
  }
  for (const [number, url] of state.imageCache) {
    if (!keep.has(number) && state.imageCache.size > 18) {
      URL.revokeObjectURL(url);
      state.imageCache.delete(number);
    }
  }
}

function updateNavigation() {
  const index = state.currentIndex;
  const spread = state.spreads[index];
  const label = spreadLabel(spread);
  ui.positionLabel.textContent = label;
  ui.pageRange.max = String(state.spreads.length - 1);
  ui.pageRange.value = String(index);
  ui.pageRange.setAttribute('aria-valuetext', label);
  const progress = state.spreads.length > 1 ? index / (state.spreads.length - 1) * 100 : 0;
  ui.pageRange.style.setProperty('--range-progress', `${progress}%`);
  ui.prevButton.disabled = index === 0;
  ui.nextButton.disabled = index === state.spreads.length - 1;
}

function makeAnimationScene(from, to, direction) {
  const source = state.spreads[from];
  const target = state.spreads[to];
  if (source.kind !== 'spread' || target.kind !== 'spread') {
    return makeBoundaryScene(source, target, direction);
  }
  const scene = document.createElement('div');
  scene.className = `animation-scene ${direction}`;
  const sourceLeft = source.kind === 'spread' ? source.pages[0] : null;
  const sourceRight = source.kind === 'spread' ? source.pages[1] : null;
  const targetLeft = target.kind === 'spread' ? target.pages[0] : null;
  const targetRight = target.kind === 'spread' ? target.pages[1] : null;
  const left = pageNode(direction === 'next' ? sourceLeft : targetLeft, 'static-page left');
  const right = pageNode(direction === 'next' ? targetRight : sourceRight, 'static-page right');
  const sheet = document.createElement('div');
  sheet.className = 'turn-sheet';
  const front = document.createElement('div');
  front.className = 'turn-face front';
  const back = document.createElement('div');
  back.className = 'turn-face back';
  if (direction === 'next') {
    front.append(pageNode(sourceRight ?? source.pages[0]));
    back.append(pageNode(targetLeft ?? target.pages[0]));
  } else {
    front.append(pageNode(targetRight ?? target.pages[0]));
    back.append(pageNode(sourceLeft ?? source.pages[0]));
  }
  sheet.append(front, back);
  scene.append(left, right, sheet);
  return scene;
}

function makeBoundaryScene(source, target, direction) {
  const scene = document.createElement('div');
  const transition = source.kind === 'cover' && target.kind === 'spread' ? 'cover-to-spread'
    : source.kind === 'spread' && target.kind === 'cover' ? 'spread-to-cover'
      : source.kind === 'spread' && target.kind === 'back' ? 'spread-to-back'
        : source.kind === 'back' && target.kind === 'spread' ? 'back-to-spread'
          : `single-to-single ${direction}`;
  scene.className = `boundary-scene ${transition}`;
  for (const [role, spread] of [['source', source], ['target', target]]) {
    const layer = document.createElement('div');
    layer.className = `boundary-layer ${role} ${spread.kind === 'spread' ? 'double' : 'single'}`;
    if (spread.kind === 'spread') {
      layer.append(pageNode(spread.pages[0]), pageNode(spread.pages[1]));
    } else {
      layer.append(pageNode(spread.pages[0], spread.kind === 'cover' ? 'cover' : 'back-cover'));
    }
    scene.append(layer);
  }
  return scene;
}

async function navigate(index, animated = false) {
  if (!state.pdf || state.activeInk || index < 0 || index >= state.spreads.length) return;
  if (state.isTurning && animated) return;
  const from = state.currentIndex;
  if (index === from) return;
  const id = ++state.navigationId;
  const direction = index > from ? 'next' : 'previous';
  const shouldAnimate = animated && Math.abs(index - from) === 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    await ensureSpreadImages(index);
    if (shouldAnimate) await ensureSpreadImages(from);
    if (id !== state.navigationId) return;
    if (shouldAnimate) {
      state.isTurning = true;
      applyAnimationGeometry();
      const scene = makeAnimationScene(from, index, direction);
      ui.bookSurface.replaceChildren(scene);
      await new Promise(resolve => setTimeout(resolve, 730));
      if (id !== state.navigationId) { state.isTurning = false; return; }
    }
    state.isTurning = false;
    state.currentIndex = index;
    renderSpread(index);
    updateNavigation();
    trimImageCache();
  } catch (error) {
    state.isTurning = false;
    if (id === state.navigationId) showToast(`ページを表示できませんでした: ${error.message}`);
  }
}

function updateZoom() {
  ui.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
  ui.zoomOut.disabled = state.zoom <= 0.6;
  ui.zoomIn.disabled = state.zoom >= 2.5;
  ui.readerViewport.classList.toggle('is-zoomed', state.zoom > 1);
  if (state.pdf) applyGeometry(state.spreads[state.currentIndex]);
}

function zoomTo(value) {
  if (state.activeInk) return;
  const next = Math.max(0.6, Math.min(2.5, Math.round(value * 100) / 100));
  if (next === state.zoom) return;
  ui.readerViewport.classList.add('zoom-animating');
  clearTimeout(state.zoomTimer);
  state.zoom = next;
  updateZoom();
  state.zoomTimer = setTimeout(() => ui.readerViewport.classList.remove('zoom-animating'), 380);
}

function zoomBy(amount) {
  zoomTo(state.zoom + amount);
}

function computePageSize() {
  const availableWidth = Math.max(290, ui.readerViewport.clientWidth - 36);
  const availableHeight = Math.max(300, ui.readerViewport.clientHeight - 36);
  const aspect = state.pdfAspect || 1.414;
  state.pageWidth = Math.max(145, Math.min(700, availableWidth / 2, availableHeight / aspect));
  state.pageHeight = state.pageWidth * aspect;
}

async function openPdf(file) {
  if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) {
    showToast('PDFファイルを選択してください。');
    return;
  }
  const id = ++state.loadId;
  ++state.navigationId;
  state.isTurning = false;
  ++state.searchId;
  setLoading(true);
  try {
    const buffer = await file.arrayBuffer();
    const originalBytes = new Uint8Array(buffer);
    let documentId = '';
    try {
      const digest = await crypto.subtle.digest('SHA-256', originalBytes);
      documentId = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { /* 古いブラウザーではPDF.jsの識別子を使う。 */ }
    const task = pdfjs.getDocument({
      data: originalBytes.slice(),
      cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
    });
    const pdf = await task.promise;
    if (id !== state.loadId) { await pdf.destroy(); return; }
    documentId ||= `${pdf.fingerprints?.[0] || file.name}:${file.size}`;
    let savedPages = {};
    try { savedPages = await loadInk(documentId); }
    catch { showToast('端末内の書き込みを読み込めませんでした。'); }
    if (id !== state.loadId) { await pdf.destroy(); return; }
    await state.saveQueue;
    const old = state.pdf;
    state.pdf = pdf;
    if (old) await old.destroy();
    clearImages();
    state.pageGeometry.clear();
    state.originalBytes = originalBytes;
    state.documentId = documentId;
    state.annotations = readSavedPages(savedPages, pdf.numPages);
    state.undoStack = [];
    state.redoStack = [];
    state.activeInk = null;
    state.inkMode = false;
    state.lastPenAt = 0;
    ui.inkSaveStatus.textContent = '端末内に自動保存';
    state.fileName = file.name;
    state.pageOrder = makeReadingOrder(pdf.numPages);
    state.spreads = makeSpreads(state.pageOrder);
    state.currentIndex = 0;
    state.zoom = 1;
    clearTimeout(state.zoomTimer);
    ui.readerViewport.classList.remove('zoom-animating');
    const firstPage = await pdf.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1 });
    state.pdfAspect = viewport.height / viewport.width;
    ui.emptyState.hidden = true;
    ui.readerViewport.hidden = false;
    ui.documentInfo.hidden = false;
    ui.viewActions.hidden = false;
    ui.pagination.hidden = false;
    ui.searchToggle.disabled = false;
    updateInkUi();
    ui.documentName.textContent = file.name.replace(/\.pdf$/i, '');
    ui.documentMeta.textContent = `${pdf.numPages}ページ · ${formatSize(file.size)}`;
    ui.searchPanel.hidden = true;
    ui.app.classList.remove('search-open');
    ui.searchInput.value = '';
    ui.searchSummary.textContent = '';
    ui.searchResults.replaceChildren();
    computePageSize();
    updateZoom();
    await ensureSpreadImages(0);
    if (id !== state.loadId) return;
    renderSpread(0);
    updateNavigation();
    setLoading(false);
    // 次の見開きを先読みし、最初のページめくりを滑らかにする。
    if (state.spreads.length > 1) ensureSpreadImages(1).catch(() => {});
  } catch (error) {
    if (id === state.loadId) {
      setLoading(false);
      showToast(`PDFを開けませんでした: ${error.message}`);
    }
  } finally {
    ui.fileInput.value = '';
  }
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function cloneStrokes(strokes) {
  return strokes.map(stroke => ({ ...stroke, points: stroke.points.map(point => ({ ...point })) }));
}

function hasAnnotations() {
  return [...state.annotations.values()].some(strokes => strokes.length > 0);
}

function updateInkUi() {
  ui.inkToggle.disabled = !state.pdf;
  ui.inkToggle.setAttribute('aria-pressed', String(state.inkMode));
  ui.inkToggle.setAttribute('aria-label', state.inkMode ? '書き込みを終了' : '書き込みを開始');
  ui.inkToggle.title = state.inkMode ? '書き込みを終了' : '書き込みを開始';
  ui.inkToolbar.hidden = !state.inkMode;
  ui.app.classList.toggle('ink-mode', state.inkMode);
  ui.exportButton.disabled = !state.pdf || !hasAnnotations() || state.exportBusy;
  ui.inkUndo.disabled = state.undoStack.length === 0;
  ui.inkRedo.disabled = state.redoStack.length === 0;
  ui.inkWidth.disabled = state.inkTool === 'eraser';
  for (const button of ui.inkToolbar.querySelectorAll('[data-ink-tool]')) {
    const selected = button.dataset.inkTool === state.inkTool;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  for (const button of ui.inkToolbar.querySelectorAll('[data-ink-color]')) {
    const selected = button.dataset.inkColor === state.inkColor;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function queueInkSave() {
  if (!state.documentId) return;
  const id = state.documentId;
  const pages = Object.fromEntries([...state.annotations].filter(([, strokes]) => strokes.length).map(([number, strokes]) => [number, cloneStrokes(strokes)]));
  ui.inkSaveStatus.textContent = '保存中…';
  state.saveQueue = state.saveQueue.then(() => saveInk(id, pages)).then(() => {
    if (state.documentId === id) ui.inkSaveStatus.textContent = '端末内に保存済み';
  }).catch(() => {
    if (state.documentId === id) ui.inkSaveStatus.textContent = '自動保存できません';
  });
}

function commitInkChange(pageNumber, before) {
  const after = cloneStrokes(state.annotations.get(pageNumber) || []);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  state.undoStack.push({ pageNumber, before, after });
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack = [];
  updateInkUi();
  queueInkSave();
}

function applyInkHistory(from, to, key) {
  const change = from.pop();
  if (!change) return;
  state.annotations.set(change.pageNumber, cloneStrokes(change[key]));
  to.push(change);
  renderSpread(state.currentIndex);
  updateInkUi();
  queueInkSave();
}

async function exportMarkedPdf() {
  if (!state.pdf || !hasAnnotations() || state.exportBusy) return;
  state.exportBusy = true;
  updateInkUi();
  setLoading(true, '書き込み済みPDFを作成中…');
  const documentId = state.documentId;
  try {
    await state.saveQueue;
    const { makeMarkedPdf } = await import('./ink-export.js');
    const bytes = await makeMarkedPdf(state.originalBytes, state.annotations, state.pdf);
    if (documentId !== state.documentId) return;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.fileName.replace(/\.pdf$/i, '')}-marked.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    showToast('書き込み済みPDFを保存しました。');
  } catch (error) {
    showToast(`PDFを書き出せませんでした: ${error.message}`);
  } finally {
    state.exportBusy = false;
    setLoading(false);
    updateInkUi();
  }
}

function showRangeTooltip(index) {
  const spread = state.spreads[index];
  if (!spread) return;
  ui.rangeTooltip.textContent = spreadLabel(spread);
  ui.rangeTooltip.style.setProperty('--tip-left', `${state.spreads.length > 1 ? index / (state.spreads.length - 1) * 100 : 0}%`);
  ui.rangeTooltip.hidden = false;
  ui.pageRange.setAttribute('aria-valuetext', spreadLabel(spread));
}

function setSearchOpen(open) {
  ui.searchPanel.hidden = !open;
  ui.app.classList.toggle('search-open', open);
  if (open) setTimeout(() => ui.searchInput.focus(), 30);
  if (state.pdf) {
    ++state.navigationId;
    state.isTurning = false;
    computePageSize();
    clearImages();
    renderSpread(state.currentIndex);
    ensureSpreadImages(state.currentIndex).then(() => renderSpread(state.currentIndex)).catch(() => {});
  }
}

async function searchDocument(query) {
  const needle = query.trim().toLocaleLowerCase();
  const id = ++state.searchId;
  ui.searchResults.replaceChildren();
  state.searchMatches = [];
  if (!needle || !state.pdf) {
    ui.searchSummary.textContent = '';
    return;
  }
  ui.searchSummary.textContent = '検索中…';
  const matches = [];
  try {
    for (let number = 1; number <= state.pdf.numPages; number++) {
      const page = await state.pdf.getPage(number);
      const content = await page.getTextContent();
      if (id !== state.searchId) return;
      const text = content.items.map(item => item.str || '').join(' ').replace(/\s+/g, ' ');
      const lower = text.toLocaleLowerCase();
      let pos = 0;
      while ((pos = lower.indexOf(needle, pos)) !== -1) {
        matches.push({ page: number, snippet: text.slice(Math.max(0, pos - 38), Math.min(text.length, pos + query.length + 52)), match: text.slice(pos, pos + query.length) });
        pos += needle.length || 1;
        if (matches.length >= 300) break;
      }
      if (matches.length >= 300) break;
    }
    if (id !== state.searchId) return;
    state.searchMatches = matches;
    ui.searchSummary.textContent = `${matches.length}件`;
    for (const match of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'result-button';
      const title = document.createElement('strong');
      title.textContent = `${match.page}ページ`;
      const excerpt = document.createElement('span');
      const at = match.snippet.toLocaleLowerCase().indexOf(needle);
      if (at >= 0) {
        excerpt.append(document.createTextNode(match.snippet.slice(0, at)));
        const mark = document.createElement('mark');
        mark.textContent = match.snippet.slice(at, at + query.length);
        excerpt.append(mark, document.createTextNode(match.snippet.slice(at + query.length)));
      } else excerpt.textContent = match.snippet;
      button.append(title, excerpt);
      button.addEventListener('click', () => {
        for (const node of ui.searchResults.querySelectorAll('.active')) node.classList.remove('active');
        button.classList.add('active');
        navigate(findSpreadIndex(state.spreads, match.page), false);
      });
      ui.searchResults.append(button);
    }
  } catch (error) {
    if (id === state.searchId) ui.searchSummary.textContent = `検索できませんでした: ${error.message}`;
  }
}

ui.uploadButton.addEventListener('click', () => ui.fileInput.click());
ui.emptyUpload.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => openPdf(ui.fileInput.files[0]));
ui.prevButton.addEventListener('click', () => navigate(state.currentIndex - 1, true));
ui.nextButton.addEventListener('click', () => navigate(state.currentIndex + 1, true));
ui.zoomOut.addEventListener('click', () => zoomBy(-0.25));
ui.zoomIn.addEventListener('click', () => zoomBy(0.25));
ui.zoomFit.addEventListener('click', () => zoomTo(1));
ui.pageRange.addEventListener('pointerdown', () => showRangeTooltip(Number(ui.pageRange.value)));
ui.pageRange.addEventListener('input', () => showRangeTooltip(Number(ui.pageRange.value)));
ui.pageRange.addEventListener('change', () => { navigate(Number(ui.pageRange.value), false); setTimeout(() => { ui.rangeTooltip.hidden = true; }, 1200); });
ui.pageRange.addEventListener('blur', () => { ui.rangeTooltip.hidden = true; });
ui.searchToggle.addEventListener('click', () => setSearchOpen(ui.searchPanel.hidden));
ui.searchClose.addEventListener('click', () => setSearchOpen(false));
ui.searchForm.addEventListener('submit', event => { event.preventDefault(); searchDocument(ui.searchInput.value); });
ui.inkToggle.addEventListener('click', () => {
  if (!state.pdf || state.activeInk) return;
  if (!state.inkMode && !ui.searchPanel.hidden) setSearchOpen(false);
  state.inkMode = !state.inkMode;
  updateInkUi();
});
ui.exportButton.addEventListener('click', exportMarkedPdf);
ui.inkUndo.addEventListener('click', () => applyInkHistory(state.undoStack, state.redoStack, 'before'));
ui.inkRedo.addEventListener('click', () => applyInkHistory(state.redoStack, state.undoStack, 'after'));
ui.inkWidth.addEventListener('input', () => { state.inkSize = Number(ui.inkWidth.value); });
ui.inkToolbar.addEventListener('click', event => {
  const tool = event.target.closest('[data-ink-tool]');
  const color = event.target.closest('[data-ink-color]');
  if (tool) state.inkTool = tool.dataset.inkTool;
  if (color) state.inkColor = color.dataset.inkColor;
  if (tool || color) updateInkUi();
});

function inkPoint(layer, event) {
  const rect = layer.getBoundingClientRect();
  return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
}

function addInkPoint(active, event) {
  const point = inkPoint(active.layer, event);
  const points = active.stroke.points;
  const previous = points[points.length - 1];
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0005) return;
  points.push(point);
  active.path.setAttribute('d', strokePath(active.stroke, active.aspect));
}

function eraseAtPointer(active, event) {
  const strokes = state.annotations.get(active.pageNumber) || [];
  const index = findStrokeAt(strokes, inkPoint(active.layer, event), active.aspect);
  if (index < 0) return;
  strokes.splice(index, 1);
  active.layer.querySelectorAll('path')[index]?.remove();
  state.annotations.set(active.pageNumber, strokes);
}

ui.bookSurface.addEventListener('pointerdown', event => {
  const layer = event.target.closest?.('.ink-layer');
  if (!state.inkMode || !state.pdf || state.isTurning || state.activeInk || !layer) return;
  if (event.pointerType === 'touch' || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  const pageNumber = Number(layer.dataset.page);
  const aspect = state.pageGeometry.get(pageNumber).height / state.pageGeometry.get(pageNumber).width;
  const active = {
    pointerId: event.pointerId, pageNumber, layer, aspect,
    before: cloneStrokes(state.annotations.get(pageNumber) || []),
  };
  if (state.inkTool === 'eraser') {
    active.eraser = true;
    eraseAtPointer(active, event);
  } else {
    active.stroke = { tool: state.inkTool, color: state.inkColor, width: widthForTool(), points: [] };
    active.path = strokeNode(active.stroke, aspect);
    layer.append(active.path);
    addInkPoint(active, event);
  }
  state.activeInk = active;
  if (event.pointerType === 'pen') state.lastPenAt = Date.now();
  layer.setPointerCapture?.(event.pointerId);
});

ui.bookSurface.addEventListener('pointermove', event => {
  const active = state.activeInk;
  if (!active || active.pointerId !== event.pointerId) return;
  event.preventDefault();
  if (event.pointerType === 'pen') state.lastPenAt = Date.now();
  if (active.eraser) eraseAtPointer(active, event);
  else {
    const samples = event.getCoalescedEvents?.() || [];
    for (const sample of samples.length ? samples : [event]) addInkPoint(active, sample);
  }
});

function finishInk(event) {
  const active = state.activeInk;
  if (!active || active.pointerId !== event.pointerId) return;
  event.preventDefault();
  if (!active.eraser) {
    addInkPoint(active, event);
    const strokes = state.annotations.get(active.pageNumber) || [];
    strokes.push(active.stroke);
    state.annotations.set(active.pageNumber, strokes);
  }
  if (event.pointerType === 'pen') state.lastPenAt = Date.now();
  state.activeInk = null;
  commitInkChange(active.pageNumber, active.before);
  renderSpread(state.currentIndex);
}
ui.bookSurface.addEventListener('pointerup', finishInk);
ui.bookSurface.addEventListener('pointercancel', finishInk);

function finishSwipe(start, x, y) {
  if (!start || !state.pdf || state.zoom > 1 || state.isTurning || state.activeInk || (state.inkMode && Date.now() - state.lastPenAt < 400)) return;
  const deltaX = x - start.x;
  const deltaY = y - start.y;
  const threshold = Math.min(80, Math.max(55, ui.readerViewport.clientWidth * 0.12));
  if (Math.abs(deltaX) < threshold || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) return;
  navigate(state.currentIndex + (deltaX < 0 ? 1 : -1), true);
}

let touchStart = null;
let touchPan = null;
ui.readerViewport.addEventListener('touchstart', event => {
  const canUseFinger = !state.activeInk && Date.now() - state.lastPenAt > 400;
  touchStart = canUseFinger && event.touches.length === 1 && state.zoom <= 1
    ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
    : null;
  touchPan = canUseFinger && state.inkMode && state.zoom > 1 && event.touches.length === 1
    ? { x: event.touches[0].clientX, y: event.touches[0].clientY, left: ui.readerViewport.scrollLeft, top: ui.readerViewport.scrollTop }
    : null;
}, { passive: true });
ui.readerViewport.addEventListener('touchmove', event => {
  if (event.touches.length !== 1) { touchStart = null; touchPan = null; return; }
  if (touchPan) {
    event.preventDefault();
    ui.readerViewport.scrollLeft = touchPan.left - (event.touches[0].clientX - touchPan.x);
    ui.readerViewport.scrollTop = touchPan.top - (event.touches[0].clientY - touchPan.y);
  }
}, { passive: false });
ui.readerViewport.addEventListener('touchend', event => {
  if (event.changedTouches.length === 1) finishSwipe(touchStart, event.changedTouches[0].clientX, event.changedTouches[0].clientY);
  touchStart = null;
  touchPan = null;
}, { passive: true });
ui.readerViewport.addEventListener('touchcancel', () => { touchStart = null; touchPan = null; });

let mouseStart = null;
ui.readerViewport.addEventListener('pointerdown', event => {
  if (!state.inkMode && event.pointerType === 'mouse' && event.button === 0) mouseStart = { x: event.clientX, y: event.clientY };
});
ui.readerViewport.addEventListener('pointerup', event => {
  if (!state.inkMode && event.pointerType === 'mouse') finishSwipe(mouseStart, event.clientX, event.clientY);
  mouseStart = null;
});
ui.readerViewport.addEventListener('pointercancel', () => { mouseStart = null; });

let wheelTravel = 0;
let wheelResetTimer;
let lastWheelTurn = 0;
ui.readerViewport.addEventListener('wheel', event => {
  if (!state.pdf || state.zoom > 1 || event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  event.preventDefault();
  if (Date.now() - lastWheelTurn < 850) return;
  wheelTravel += event.deltaX;
  clearTimeout(wheelResetTimer);
  wheelResetTimer = setTimeout(() => { wheelTravel = 0; }, 180);
  if (Math.abs(wheelTravel) < 75) return;
  navigate(state.currentIndex + (wheelTravel > 0 ? 1 : -1), true);
  wheelTravel = 0;
  lastWheelTurn = Date.now();
}, { passive: false });

document.addEventListener('keydown', event => {
  if (!state.pdf) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault(); setSearchOpen(true); return;
  }
  if (event.target instanceof HTMLInputElement) return;
  if (state.inkMode && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) applyInkHistory(state.redoStack, state.undoStack, 'after');
    else applyInkHistory(state.undoStack, state.redoStack, 'before');
    return;
  }
  if (event.key === 'ArrowRight') { event.preventDefault(); navigate(state.currentIndex + 1, true); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(state.currentIndex - 1, true); }
  if (event.key === 'Home') { event.preventDefault(); navigate(0, false); }
  if (event.key === 'End') { event.preventDefault(); navigate(state.spreads.length - 1, false); }
  if (event.key === 'Escape' && !ui.searchPanel.hidden) setSearchOpen(false);
});

let dragDepth = 0;
document.addEventListener('dragenter', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault(); dragDepth++; ui.dropOverlay.hidden = false;
});
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', event => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) ui.dropOverlay.hidden = true; });
document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; ui.dropOverlay.hidden = true; openPdf(event.dataTransfer?.files?.[0]); });

let resizeTimer;
window.addEventListener('resize', () => {
  if (!state.pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    ++state.navigationId;
    state.isTurning = false;
    computePageSize();
    clearImages();
    renderSpread(state.currentIndex);
    await ensureSpreadImages(state.currentIndex);
    renderSpread(state.currentIndex);
  }, 180);
});
