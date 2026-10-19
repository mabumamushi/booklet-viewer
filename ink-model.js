export const INK_COLORS = ['#202020', '#c63f35', '#3869a6'];
const SAVED_INK_COLORS = new Set([...INK_COLORS, '#387252', '#e5bc35']);

export function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function strokePath(stroke, aspect) {
  const points = stroke.points || [];
  if (!points.length) return '';
  const coordinate = point => `${(point.x * 1000).toFixed(2)} ${(point.y * 1000 * aspect).toFixed(2)}`;
  if (points.length === 1) return `M ${coordinate(points[0])} l 0.01 0`;
  return `M ${coordinate(points[0])} ` + points.slice(1).map(point => `L ${coordinate(point)}`).join(' ');
}

function distanceToSegment(point, start, end, aspect) {
  const px = point.x * 1000;
  const py = point.y * 1000 * aspect;
  const ax = start.x * 1000;
  const ay = start.y * 1000 * aspect;
  const bx = end.x * 1000;
  const by = end.y * 1000 * aspect;
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

export function findStrokeAt(strokes, point, aspect, radius = 13) {
  for (let index = strokes.length - 1; index >= 0; index--) {
    const stroke = strokes[index];
    const points = stroke.points || [];
    const threshold = radius + stroke.width * 500;
    for (let i = 0; i < points.length; i++) {
      if (distanceToSegment(point, points[Math.max(0, i - 1)], points[i], aspect) <= threshold) return index;
    }
  }
  return -1;
}

export function readSavedPages(record, pageCount) {
  const pages = new Map();
  if (!record || typeof record !== 'object') return pages;
  for (const [key, strokes] of Object.entries(record)) {
    const page = Number(key);
    if (!Number.isInteger(page) || page < 1 || page > pageCount || !Array.isArray(strokes)) continue;
    const valid = strokes.filter(stroke =>
      ['pen', 'marker'].includes(stroke?.tool) &&
      SAVED_INK_COLORS.has(stroke.color) &&
      Number.isFinite(stroke.width) && stroke.width > 0 && stroke.width < 0.1 &&
      Array.isArray(stroke.points) && stroke.points.length > 0 && stroke.points.length < 100000 &&
      stroke.points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
    );
    if (valid.length) pages.set(page, valid);
  }
  return pages;
}
