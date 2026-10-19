import { PDFDocument, rgb } from './vendor/pdf-lib.esm.min.js';

function rgbFromHex(hex) {
  return rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
}

export async function makeMarkedPdf(originalBytes, annotations, sourcePdf) {
  const output = await PDFDocument.load(originalBytes, { updateMetadata: false });
  for (const [pageNumber, strokes] of annotations) {
    if (!strokes.length) continue;
    const sourcePage = await sourcePdf.getPage(pageNumber);
    const viewport = sourcePage.getViewport({ scale: 1 });
    const targetPage = output.getPage(pageNumber - 1);
    for (const stroke of strokes) {
      const points = stroke.points.map(point => {
        const [x, y] = viewport.convertToPdfPoint(point.x * viewport.width, point.y * viewport.height);
        return { x, y };
      });
      const thickness = Math.max(0.5, stroke.width * viewport.width);
      const color = rgbFromHex(stroke.color);
      const opacity = stroke.tool === 'marker' ? 0.28 : 1;
      if (points.length === 1) {
        targetPage.drawCircle({ x: points[0].x, y: points[0].y, size: thickness / 2, color, opacity });
      } else {
        for (let i = 1; i < points.length; i++) {
          targetPage.drawLine({ start: points[i - 1], end: points[i], thickness, color, opacity });
        }
      }
    }
  }
  return output.save();
}
