// Native handwriting is a unified Gamma block too (docs/dev/handwriting.md
// "Native handwriting blocks"): the iPad writes `pdf_ink` blocks whose
// properties carry the PKDrawing source, a whole-block PNG preview and a
// per-stroke `.inkjson` display derivative. The web DISPLAYS those images and
// does not edit them — the editable source stays on iPad — so nothing here
// ever rewrites a block.
//
// These are separate from the browser's own `ink_url` groups in ../ink/: an
// upstream ink group is drawn here, a `pdf_ink` block is drawn on iPad. Both
// can live on one page and each keeps its own marker and layer.

// The block's stored asset reference is validated on its exact bare path: no
// scheme, no host, no traversal, no query. The workspace/share scope a
// browser-issued request needs is added at the RENDER site (shared/lib/utils
// assetUrl), never read out of block data.
const PREVIEW_REF = /^\/api\/assets\/[a-f0-9]{64}\.png$/;

export function inkBlockPreview(block) {
  const props = block?.properties;
  if (props?.type !== "pdf_ink") return null;
  const url = props.preview_asset;
  if (typeof url !== "string" || !PREVIEW_REF.test(url)) return null;
  return {
    url,
    page: Number.isSafeInteger(props.pdf_page) && props.pdf_page > 0 ? props.pdf_page : null,
  };
}

export function blocksToPdfInk(blocks) {
  const result = [];
  function walk(list) {
    for (const block of list || []) {
      if (inkBlockPreview(block)?.page) result.push(block);
      if (block.children?.length) walk(block.children);
    }
  }
  walk(blocks);
  return result;
}

// PKDrawing canonical points: unrotated crop top-left, x right/y down
// (`pdf-crop-top-left-v1`). Map preview-local points through PDF page space
// into pdf.js viewport space. The affine map preserves quarter-turn rotation;
// a bounding box alone would place the image correctly but leave the
// handwriting itself unrotated.
export function pdfInkPlacement(block, viewport) {
  const preview = inkBlockPreview(block);
  const props = block?.properties;
  const box = props?.bounds, crop = props?.crop_box, view = viewport?.viewBox;
  if (!preview?.page || props.coordinate_space !== "pdf-crop-top-left-v1" ||
      !box || !crop || !view || view.length !== 4 ||
      typeof viewport.convertToViewportPoint !== "function") return null;
  const numbers = [box.x, box.y, box.width, box.height, crop.width, crop.height, ...view];
  if (!numbers.every(Number.isFinite) || box.x < 0 || box.y < 0 ||
      box.width <= 0 || box.height <= 0 || crop.width <= 0 || crop.height <= 0 ||
      box.x + box.width > crop.width + 0.001 || box.y + box.height > crop.height + 0.001 ||
      view[2] <= view[0] || view[3] <= view[1]) return null;
  const sx = (view[2] - view[0]) / crop.width;
  const sy = (view[3] - view[1]) / crop.height;
  const point = (x, y) => viewport.convertToViewportPoint(view[0] + x * sx, view[3] - y * sy);
  const origin = point(box.x, box.y);
  const right = point(box.x + 1, box.y);
  const down = point(box.x, box.y + 1);
  const matrix = [right[0] - origin[0], right[1] - origin[1],
    down[0] - origin[0], down[1] - origin[1], origin[0], origin[1]];
  if (!matrix.every(Number.isFinite)) return null;
  return { url: preview.url, width: box.width, height: box.height, matrix };
}
