import test from "node:test";
import assert from "node:assert/strict";
import { inkBlockPreview, blocksToPdfInk, pdfInkPlacement } from "./inkBlock.js";

const url = `/api/assets/${"a".repeat(64)}.png`;
const ink = { id: "ink1", properties: {
  type: "pdf_ink", pdf_page: 2, preview_asset: url,
  coordinate_space: "pdf-crop-top-left-v1",
  bounds: { x: 10, y: 20, width: 30, height: 40 }, crop_box: { width: 200, height: 300 },
}};

test("nested ink blocks retain page identity", () => {
  assert.deepEqual(blocksToPdfInk([{id: "note", children: [ink]}]), [ink]);
});
test("PDF ink uses crop origin and viewport scale without modifying bounds", () => {
  const viewport = { viewBox: [40, 60, 240, 360], convertToViewportPoint: (x, y) => [(x - 40) * 2, (360 - y) * 2] };
  assert.deepEqual(pdfInkPlacement(ink, viewport), {url, width: 30, height: 40, matrix: [2, 0, 0, 2, 20, 40]});
});
test("quarter-turn viewport rotates the handwriting, not merely its box", () => {
  const viewport = { viewBox: [40, 60, 240, 360], convertToViewportPoint: (x, y) => [y - 60, x - 40] };
  assert.deepEqual(pdfInkPlacement(ink, viewport)?.matrix, [0, 1, -1, 0, 280, 10]);
});
test("unsupported coordinates or invalid geometry never render on the PDF", () => {
  const viewport = { viewBox: [0, 0, 200, 300], convertToViewportPoint: (x, y) => [x, 300-y] };
  for (const patch of [{coordinate_space: "screen"}, {bounds: {x: 199,y: 0,width: 20,height: 20}},
    {crop_box: {width: 0,height: 300}}, {bounds: {x: NaN,y: 0,width: 2,height: 2}}]) {
    assert.equal(pdfInkPlacement({...ink, properties: {...ink.properties, ...patch}}, viewport), null);
  }
});
test("ink preview derives from the same unified block", () => {
  assert.deepEqual(inkBlockPreview({content: "My note", properties: {type: "pdf_ink", pdf_page: 3, preview_asset: url}}), {url, page: 3});
});
test("plain notes and invalid preview addresses are not ink previews", () => {
  assert.equal(inkBlockPreview({properties: {preview_asset: url}}), null);
  for (const preview_asset of ["https://example.com/ink.png", "//example.com/ink.png", "/api/assets/../secret.png", url + "?share=x", url.replace(".png", ".pkdrawing"), null]) {
    assert.equal(inkBlockPreview({properties: {type: "pdf_ink", preview_asset}}), null);
  }
});
test("invalid page metadata never becomes a navigation target", () => {
  for (const pdf_page of [0, -1, "1", 1.5, null]) {
    assert.deepEqual(inkBlockPreview({properties: {type: "pdf_ink", pdf_page, preview_asset: url}}), {url, page: null});
  }
});
