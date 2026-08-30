// Pointer-trajectory hover intent for hierarchical menus (the "safe triangle").
//
// The problem it solves: with a submenu open to the side, the natural cursor
// path from the parent row to the submenu cuts diagonally ACROSS the rows
// below it. A menu that switches on plain hover closes the submenu right
// under the cursor, so the user has to travel in an L shape to reach it.
//
// The fix (the classic Amazon-flyout trick): while a submenu is open, build a
// triangle from where the cursor just was to the near edge of the open panel.
// Any move that lands inside that triangle is "still aiming at the submenu" —
// the hover change it would have caused is HELD instead of applied, and only
// runs once the aim breaks (a move outside the triangle) or goes stale (the
// cursor stopped for `graceMs`).
//
// Deliberately UI-agnostic: plain geometry plus one hook that turns "the
// pointer entered row X" into "activate X — now, or later". Any menu can
// inherit it by feeding it the open panel's rect and wrapping its hover
// handlers in guard(); menus.jsx's ContextMenu/SubMenuItem are just the first
// caller.
import { useCallback, useEffect, useRef } from "react";

// Twice the signed area of the triangle abc — positive when abc winds
// counter-clockwise in a y-down screen frame.
function cross(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// Point-in-triangle by consistent winding (edges count as inside).
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = cross(ax, ay, bx, by, px, py);
  const d2 = cross(bx, by, cx, cy, px, py);
  const d3 = cross(cx, cy, ax, ay, px, py);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// The aim triangle: apex at the cursor's earlier position, base the vertical
// edge of `rect` facing it (padded by `slack` so the corners aren't a cliff).
// Returns [apex, cornerA, cornerB] as flat coordinates.
function aimTriangle(fromX, fromY, rect, slack = 6) {
  // Which side of the panel the cursor is on. When it is already inside the
  // panel's x-range (shouldn't normally happen) treat the near edge as the
  // closer one so the test still degrades sensibly.
  const edgeX = fromX <= rect.left ? rect.left
    : fromX >= rect.right ? rect.right
      : (Math.abs(fromX - rect.left) <= Math.abs(fromX - rect.right) ? rect.left : rect.right);
  return [fromX, fromY, edgeX, rect.top - slack, edgeX, rect.bottom + slack];
}

// Is the cursor at (x, y) heading into `rect`, coming from (fromX, fromY)?
function isAimingAt(x, y, fromX, fromY, rect, slack) {
  if (!rect) return false;
  const [ax, ay, bx, by, cx, cy] = aimTriangle(fromX, fromY, rect, slack);
  // A degenerate triangle (cursor parked exactly on the panel edge) can't
  // express an aim — say no rather than trapping the menu open.
  if (ax === bx && ax === cx) return false;
  return pointInTriangle(x, y, ax, ay, bx, by, cx, cy);
}

// How far back in time the aim vector's tail is taken from. One frame of
// travel is too short to read as a direction; ~120 ms of trail is stable
// without lagging behind a fast flick.
const TRAIL_MS = 120;

// useMenuAim() — the hook form.
//
//   const aim = useMenuAim();
//   aim.setTarget(rect | null)  // the open panel's rect ("nothing open" = null)
//   aim.guard(fn)               // do fn now, or hold it while the cursor aims
//   aim.keep()                  // cursor reached the panel — drop what's held
//
// The pointer trail is tracked on the document (capture phase) so moves over
// the gap between the parent row and the panel count too.
function useMenuAim({ graceMs = 300, slack = 6 } = {}) {
  const st = useRef({ trail: [], rect: null, pending: null, timer: null });

  const keep = useCallback(() => {
    const s = st.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    s.pending = null;
  }, []);

  const flush = useCallback(() => {
    const s = st.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    const fn = s.pending;
    s.pending = null;
    if (fn) fn();
  }, []);

  useEffect(() => {
    function onMove(e) {
      const s = st.current;
      const now = e.timeStamp;
      // Tail of the aim vector: the oldest sample still inside the window.
      const tail = s.trail.find((p) => now - p.t <= TRAIL_MS) || s.trail[s.trail.length - 1];
      const aiming = tail && isAimingAt(e.clientX, e.clientY, tail.x, tail.y, s.rect, slack);
      s.trail.push({ x: e.clientX, y: e.clientY, t: now });
      while (s.trail.length > 1 && now - s.trail[0].t > TRAIL_MS) s.trail.shift();
      if (s.pending && !aiming) flush();
    }
    document.addEventListener("pointermove", onMove, true);
    return () => { document.removeEventListener("pointermove", onMove, true); keep(); };
  }, [flush, keep, slack]);

  const setTarget = useCallback((rect) => {
    st.current.rect = rect || null;
    if (!rect) keep();
  }, [keep]);

  // Hold the action for the next pointermove to judge: that move either
  // breaks the aim (applied immediately — one frame, invisible) or continues
  // it (held). The timer is the backstop for a cursor that simply stopped
  // inside the triangle.
  const guard = useCallback((fn) => {
    const s = st.current;
    if (!s.rect) { keep(); fn(); return; }
    s.pending = fn;
    if (!s.timer) s.timer = setTimeout(flush, graceMs);
  }, [flush, keep, graceMs]);

  return { setTarget, guard, keep };
}

export { useMenuAim, isAimingAt, aimTriangle, pointInTriangle };
