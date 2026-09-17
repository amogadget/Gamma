// Keep native touch scrolling and inertia entirely browser-owned. Correct
// small sideways drift ONCE after scrolling settles, never during a fling.
const MIN_TRAVEL = 8;
const VERTICAL_RATIO = Math.tan(Math.PI / 6);
const IDLE_MS = 250; // fallback for older Safari without scrollend

export function installVerticalScrollSnap(el) {
  let gesture = null, target = null, idle = 0;
  const hasScrollEnd = "onscrollend" in el;
  const release = () => { clearTimeout(idle); idle = 0; gesture = null; target = null; };
  const settle = () => {
    if (gesture || target === null) return;
    const left = Math.max(0, Math.min(target, el.scrollWidth - el.clientWidth));
    release(); // the correction's scroll events must not schedule another snap
    if (Math.abs(el.scrollLeft - left) > 1.5) {
      el.scrollTo({ left, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  };
  const armIdle = () => {
    clearTimeout(idle);
    if (!hasScrollEnd && !gesture && target !== null) idle = setTimeout(settle, IDLE_MS);
  };
  const start = (e) => {
    release();
    if (e.touches.length !== 1 || el.scrollWidth - el.clientWidth <= 1) return;
    const t = e.touches[0];
    gesture = { x: t.clientX, y: t.clientY, left: el.scrollLeft, decided: false };
  };
  const move = (e) => {
    if (!gesture) return;
    if (e.touches.length !== 1) { release(); return; }
    const dx = Math.abs(e.touches[0].clientX - gesture.x), dy = Math.abs(e.touches[0].clientY - gesture.y);
    if (!gesture.decided) {
      if (Math.hypot(dx, dy) < MIN_TRAVEL) return;
      if (dx > dy * VERTICAL_RATIO) { release(); return; }
      gesture.decided = true;
      target = gesture.left;
    } else if (dx > Math.max(24, dy * 0.8)) {
      release(); // user turned sideways deliberately: do not pull them back
    }
  };
  const end = (e) => {
    if (e.touches.length) { release(); return; }
    gesture = null;
    armIdle();
  };
  const pointer = (e) => {
    if (e.pointerType !== "touch" || !el.contains(e.target)) release();
  };
  const bindings = [["touchstart", start], ["touchmove", move], ["touchend", end],
    ["touchcancel", release], ["scroll", armIdle], ["scrollend", settle], ["wheel", release]];
  for (const [name, fn] of bindings) el.addEventListener(name, fn, { passive: true });
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", release, true);
  window.addEventListener("blur", release);
  window.addEventListener("resize", release);
  return () => {
    release();
    for (const [name, fn] of bindings) el.removeEventListener(name, fn);
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("keydown", release, true);
    window.removeEventListener("blur", release);
    window.removeEventListener("resize", release);
  };
}
