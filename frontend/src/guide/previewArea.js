import { anchorElement } from "./anchors.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exercise the viewer's real rectangle-drag path, then cancel before release
// would capture an image or create a pending annotation.
export async function previewArea(live, cancelled, onCleanup, findEquation) {
  const equation = await findEquation?.();
  if (cancelled()) return;
  const viewerElement = anchorElement("pdf.viewer");
  const viewer = viewerElement?.getBoundingClientRect();
  if (!viewer) return;
  const pages = [...document.querySelectorAll('[data-guide="pdf.page"]')];
  const equationPage = equation && pages.find((el) => Number(el.dataset.page) === equation.page);
  const page = equationPage || pages.find((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > viewer.top + 120 && r.top < viewer.bottom - 260;
  });
  if (!page) return;
  let formulaBox = null;
  if (equationPage) {
    const initial = page.getBoundingClientRect();
    const hit = equation.rects[0];
    viewerElement.scrollTop += initial.top + hit.y1 * initial.height / equation.pageH - viewer.top - viewer.height * 0.3;
    const deadline = performance.now() + 8000;
    while (!formulaBox && performance.now() < deadline) {
      if (cancelled()) return;
      const layer = page.querySelector('[data-guide="pdf.textLayer"]');
      if (layer) {
        const nodes = [];
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          nodes.push({ text: node.textContent, box: range.getBoundingClientRect() });
        }
        const pageRect = page.getBoundingClientRect();
        const expectedY = pageRect.top + hit.y1 * pageRect.height / equation.pageH;
        const start = nodes.filter((n) => /Attention/i.test(n.text))
          .sort((a, b) => Math.abs(a.box.top - expectedY) - Math.abs(b.box.top - expectedY))[0];
        if (start) {
          const baseline = start.box.top + start.box.height / 2;
          const parts = nodes.filter((n) => n.box.width > 0 && n.box.left >= start.box.left - 3
            && Math.abs(n.box.top + n.box.height / 2 - baseline) < start.box.height * 1.8
            && !/^\s*\(\d+\)\s*$/.test(n.text)
            && (n === start || n.text.trim().length < 20 || /softmax/i.test(n.text)));
          if (parts.some((n) => /softmax/i.test(n.text))) formulaBox = {
            left: Math.min(...parts.map((n) => n.box.left)) - 8,
            top: Math.min(...parts.map((n) => n.box.top)) - 8,
            right: Math.max(...parts.map((n) => n.box.right)) + 8,
            bottom: Math.max(...parts.map((n) => n.box.bottom)) + 8,
          };
        }
      }
      if (!formulaBox) await sleep(100);
    }
  }
  const r = page.getBoundingClientRect();
  const x = formulaBox?.left ?? Math.max(r.left, viewer.left) + 45;
  const y = formulaBox?.top ?? Math.max(r.top, viewer.top) + 80;
  const width = formulaBox ? formulaBox.right - x : Math.min(240, r.right - x - 30, viewer.right - x - 30);
  const height = formulaBox ? formulaBox.bottom - y : Math.min(110, r.bottom - y - 30, viewer.bottom - y - 220);
  if (width < 30 || height < 30) return;
  const pointerId = 971;
  let dragging = false;
  const emit = (type, clientX = x, clientY = y, target = document) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0,
    buttons: 1, ctrlKey: true, clientX, clientY,
  }));
  const clear = () => {
    if (dragging) { dragging = false; emit("pointercancel"); }
  };
  onCleanup(clear);
  const check = () => { if (cancelled()) throw new Error("cancelled"); };
  const show = (progress, pressed) => live({ anchor: "pdf.viewer", cursor: {
    x: x + width * progress, y: y + height * progress,
    pressed, dragging: pressed, modifier: "Ctrl",
  } });
  try {
    show(0, false);
    await sleep(650); check();
    dragging = true;
    emit("pointerdown", x, y, page);
    const frames = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 40;
    for (let i = 1; i <= frames; i++) {
      check();
      const progress = i / frames;
      emit("pointermove", x + width * progress, y + height * progress);
      show(progress, true);
      await sleep(frames === 1 ? 0 : 30);
    }
    await sleep(1000); check();
  } finally { clear(); }
}
