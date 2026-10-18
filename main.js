import * as pdfjs from './vendor/pdf.min.mjs';
import { makeReadingOrder, makeSpreads, spreadLabel, findSpreadIndex } from './page-model.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = id => document.getElementById(id);
const ui = Object.fromEntries([
  'app','uploadButton','emptyUpload','fileInput','searchToggle','searchClose','searchPanel','searchForm','searchInput','searchSummary','searchResults',
  'workspaceHead','documentName','documentMeta','spreadLabel','reader','emptyState','readerViewport','zoomShell','bookSurface','dropOverlay',
  'loadingOverlay','loadingText','toast','pagination','prevButton','nextButton','pageRange','positionLabel','rangeTooltip',
  'zoomIn','zoomOut','zoomFit','zoomValue'
].map(id => [id, $(id)]));

const state = {
  pdf: null, fileName: '', pageOrder: [], spreads: [], currentIndex: 0, zoom: 1,
  pageWidth: 340, pageHeight: 480, imageCache: new Map(), pendingImages: new Map(),
  navigationId: 0, loadId: 0, searchId: 0, imageEpoch: 0, isTurning: false, searchMatches: [], toastTimer: null,
};

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
  ui.spreadLabel.textContent = label;
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
  const scene = document.createElement('div');
  scene.className = `animation-scene ${direction}`;
  const source = state.spreads[from];
  const target = state.spreads[to];
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

async function navigate(index, animated = false) {
  if (!state.pdf || index < 0 || index >= state.spreads.length) return;
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
  if (state.pdf) applyGeometry(state.spreads[state.currentIndex]);
}

function zoomBy(amount) {
  state.zoom = Math.max(0.6, Math.min(2.5, Math.round((state.zoom + amount) * 100) / 100));
  updateZoom();
}

function computePageSize() {
  const availableWidth = Math.max(290, ui.readerViewport.clientWidth - 72);
  const availableHeight = Math.max(300, ui.readerViewport.clientHeight - 62);
  const aspect = state.pdfAspect || 1.414;
  state.pageWidth = Math.max(145, Math.min(490, availableWidth / 2, availableHeight / aspect));
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
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
    });
    const pdf = await task.promise;
    if (id !== state.loadId) { await pdf.destroy(); return; }
    const old = state.pdf;
    state.pdf = pdf;
    if (old) await old.destroy();
    clearImages();
    state.fileName = file.name;
    state.pageOrder = makeReadingOrder(pdf.numPages);
    state.spreads = makeSpreads(state.pageOrder);
    state.currentIndex = 0;
    state.zoom = 1;
    const firstPage = await pdf.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1 });
    state.pdfAspect = viewport.height / viewport.width;
    ui.emptyState.hidden = true;
    ui.readerViewport.hidden = false;
    ui.workspaceHead.hidden = false;
    ui.pagination.hidden = false;
    ui.searchToggle.disabled = false;
    ui.documentName.textContent = file.name.replace(/\.pdf$/i, '');
    ui.documentMeta.textContent = `${pdf.numPages}ページ · ${formatSize(file.size)}`;
    ui.searchPanel.hidden = true;
    ui.app.classList.remove('search-open');
    ui.searchInput.value = '';
    ui.searchSummary.textContent = 'PDF内の文字を検索できます。';
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
    ui.searchSummary.textContent = 'PDF内の文字を検索できます。';
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
    ui.searchSummary.textContent = matches.length ? `${matches.length}件見つかりました${matches.length >= 300 ? '（先頭300件）' : ''}` : '一致する文字は見つかりませんでした。';
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
ui.zoomFit.addEventListener('click', () => { state.zoom = 1; updateZoom(); });
ui.pageRange.addEventListener('pointerdown', () => showRangeTooltip(Number(ui.pageRange.value)));
ui.pageRange.addEventListener('input', () => showRangeTooltip(Number(ui.pageRange.value)));
ui.pageRange.addEventListener('change', () => { navigate(Number(ui.pageRange.value), false); setTimeout(() => { ui.rangeTooltip.hidden = true; }, 1200); });
ui.pageRange.addEventListener('blur', () => { ui.rangeTooltip.hidden = true; });
ui.searchToggle.addEventListener('click', () => setSearchOpen(ui.searchPanel.hidden));
ui.searchClose.addEventListener('click', () => setSearchOpen(false));
ui.searchForm.addEventListener('submit', event => { event.preventDefault(); searchDocument(ui.searchInput.value); });

document.addEventListener('keydown', event => {
  if (!state.pdf) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault(); setSearchOpen(true); return;
  }
  if (event.target instanceof HTMLInputElement) return;
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
