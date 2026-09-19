// The guide's event bus: the app emits a few named events at the point where
// a thing happens; tours advance and checklist items complete from them.
// The catalog is closed — a tour naming an unknown event fails the tests.

export const EVENTS = [
  "popover.opened",   // {name} — a topbar popover opened: add, search, user, share, downloads
  "page.opened",      // {id}
  "highlight.created",
  "block.created",
  "block.indented",
  "chat.sent",
  "settings.opened",  // {pane}
];

const listeners = new Set();

export const guideEvents = {
  emit(name, payload = {}) {
    if (!EVENTS.includes(name)) {
      console.warn(`guide: unknown event "${name}"`);
      return;
    }
    for (const fn of listeners) fn(name, payload);
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// Does an emitted event satisfy a step's `advanceOn`?
export function eventMatches(spec, name, payload) {
  if (!spec || spec.event !== name) return false;
  if (!spec.match) return true;
  return Object.entries(spec.match).every(([k, v]) => payload?.[k] === v);
}
