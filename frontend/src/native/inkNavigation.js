// Spatial navigation to a native handwriting block: clicking its marker, card
// or preview should land on the strokes, in the same affine frame the ink
// layer itself draws in (crop origin and quarter-turn rotation included) — not
// merely on the right page.
import { pdfInkPlacement } from "./inkBlock.js";

export function inkJumpPosition(block, viewport) {
  const pageNumber = block?.properties?.pdf_page;
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return null;
  const ink = pdfInkPlacement(block, viewport);
  // Geometry missing or unsupported: fall back to the page, never to a guess.
  if (!ink) return { pageNumber };
  const [a, b, c, d, e, f] = ink.matrix;
  const corners = [[0, 0], [ink.width, 0], [0, ink.height], [ink.width, ink.height]]
    .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  return {
    pageNumber,
    boundingRect: {
      x1: Math.min(...corners.map((p) => p[0])), y1: Math.min(...corners.map((p) => p[1])),
      x2: Math.max(...corners.map((p) => p[0])), y2: Math.max(...corners.map((p) => p[1])),
      width: viewport.width, height: viewport.height, pageNumber,
    },
  };
}
