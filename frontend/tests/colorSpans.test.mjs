// Colored text as inline HTML (editor/mdMarks.js): the scanner the live
// editor uses to hide the tags, and the markup the "/" color commands write.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TEXT_COLORS, colorSpan, scanColorSpans } from "../src/editor/mdMarks.js";

test("colorSpan writes a text color or a translucent background tint", () => {
  assert.equal(colorSpan("#e5484d"), '<span style="color:#e5484d">');
  assert.equal(colorSpan("#e5484d", true), '<span style="background:#e5484d55">');
  assert.equal(TEXT_COLORS.length, 8);
});

test("scanColorSpans finds colored runs with their tag lengths and style", () => {
  const text = 'a <span style="color:#e5484d">red</span> b <span style="background:#fde04755">hi</span> c';
  const spans = scanColorSpans(text);
  assert.equal(spans.length, 2);
  const [red, tint] = spans;
  assert.equal(text.slice(red.from, red.to), '<span style="color:#e5484d">red</span>');
  assert.equal(text.slice(red.from + red.openLen, red.to - red.closeLen), "red");
  assert.equal(red.style, "color:#e5484d");
  assert.equal(tint.style, "background:#fde04755");
  // Hand-written variants: named colors, background-color, two properties.
  assert.equal(scanColorSpans('<span style="color: red">x</span>')[0].style, "color: red");
  assert.equal(scanColorSpans('<span style="background-color:#ff0">x</span>').length, 1);
  assert.equal(scanColorSpans('<span style="color:#f00; background:#ff0">x</span>')[0].style, "color:#f00; background:#ff0");
  // Not colors, not closed, or spanning lines: left alone.
  assert.equal(scanColorSpans('<span style="font-weight:bold">x</span>').length, 0);
  assert.equal(scanColorSpans('<span style="color:red">x').length, 0);
  assert.equal(scanColorSpans('<span style="color:red">a\nb</span>').length, 0);
  assert.equal(scanColorSpans('<span style="color:red"><b>x</b></span>').length, 0, "nested tags stay raw");
});
