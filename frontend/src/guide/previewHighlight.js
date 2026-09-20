import { anchorElement } from "./anchors.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const ABSTRACT_PASSAGE = "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely";

function abstractPassage() {
  const needle = ABSTRACT_PASSAGE.replace(/\s/g, "").toLowerCase();
  for (const layer of document.querySelectorAll('[data-guide="pdf.textLayer"]')) {
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    const points = [];
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let offset = 0; offset < node.textContent.length; offset++) {
        const char = node.textContent[offset];
        if (/\s/.test(char)) continue;
        text += char.toLowerCase();
        points.push({ node, offset });
      }
    }
    const start = text.indexOf(needle);
    if (start >= 0) return points.slice(start, start + needle.length);
  }
  return null;
}

// Use the rendered text, so the gesture follows the PDF at any zoom. Pick a
// visible line above the coach mark rather than relying on a paper's wording.
function visiblePassage() {
  const viewer = anchorElement("pdf.viewer")?.getBoundingClientRect();
  if (!viewer) return null;
  for (const layer of document.querySelectorAll('[data-guide="pdf.textLayer"]')) {
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent;
      if (text.trim().length < 18) continue;
      const start = text.search(/\S/);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, Math.min(text.length, start + 65));
      const box = range.getBoundingClientRect();
      if (box.width < 30 || box.height < 5) continue;
      if (box.left < Math.max(viewer.left, 0) || box.right > Math.min(viewer.right, innerWidth)) continue;
      if (box.top < Math.max(viewer.top + 45, 0) || box.bottom > Math.min(viewer.bottom, innerHeight) - 220) continue;
      return Array.from({ length: range.endOffset - start }, (_, i) => ({ node, offset: start + i }));
    }
  }
  return null;
}

export async function previewHighlight(live, cancelled, onCleanup) {
  const check = () => { if (cancelled()) throw new Error("cancelled"); };
  const deadline = performance.now() + 15000;
  let passage;
  while (!(passage = abstractPassage() || visiblePassage())) {
    check();
    // Scanned PDFs may have no selectable text. Hand over without blocking.
    if (performance.now() > deadline) return;
    await sleep(100);
  }
  check();
  passage[0].node.parentElement.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  await sleep(200); check();
  const start = passage[0];
  const selection = window.getSelection();
  const range = document.createRange();
  let ownsSelection = false;
  const clear = () => {
    if (!ownsSelection) return;
    ownsSelection = false;
    selection.removeAllRanges();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  };
  onCleanup(clear);
  const show = (count, dragging = false) => {
    const end = passage[Math.max(0, count - 1)];
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + (count ? 1 : 0));
    const edge = document.createRange();
    edge.setStart(end.node, end.offset);
    edge.setEnd(end.node, end.offset + 1);
    const box = edge.getBoundingClientRect();
    live({ anchor: "pdf.viewer", cursor: {
      x: count === 0 ? box.left : box.right,
      y: box.top + box.height / 2, pressed: dragging, dragging,
    } });
    if (dragging) {
      ownsSelection = true;
      selection.removeAllRanges();
      selection.addRange(range.cloneRange());
    }
  };
  try {
    show(0);
    await sleep(600); check();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (let count = reduced ? passage.length : 1; count <= passage.length; count++) {
      check();
      if (!start.node.isConnected) return;
      show(count, true);
      await sleep(reduced ? 0 : 2000 / passage.length);
    }
    show(passage.length);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    const popupDeadline = performance.now() + 2000;
    let color;
    while (!(color = anchorElement("pdf.highlightColor"))) {
      check();
      if (performance.now() > popupDeadline) return;
      await sleep(50);
    }
    await sleep(400); check();
    const box = color.getBoundingClientRect();
    live({ anchor: "pdf.viewer", cursor: { x: box.left + box.width / 2, y: box.top + box.height / 2 } });
    await sleep(1300);
  } finally {
    clear();
  }
}
