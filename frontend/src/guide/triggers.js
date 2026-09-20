import { eventMatches } from "./events.js";

export function factsMatch(requires, facts) {
  return Object.entries(requires || {}).every(([key, value]) => facts[key] === value);
}

// An event is consumed only while its prerequisites hold. State-only triggers
// omit `event`; they are considered whenever the app's facts change.
export function canOfferTour(tour, { facts, progress, event }) {
  const trigger = tour.trigger;
  if (!trigger || !factsMatch(trigger.requires, facts)) return false;
  if (progress?.version >= tour.version) return false;
  return trigger.event
    ? !!event && eventMatches(trigger, event.name, event.payload)
    : !event;
}

export function guideProgressKey(tour, scope) {
  // Keep the existing manually launched first-run tour's storage compatible.
  return tour.trigger
    ? `gamma-guide:${encodeURIComponent(scope)}:${tour.id}`
    : `gamma-guide:${tour.id}`;
}

// Memory also remembers offers if browser storage is unavailable. A fresh
// read observes dismissals from other tabs; progress never stores chat text.
export function createGuideProgress(storage = () => globalThis.localStorage) {
  const memory = new Map();
  return {
    read(tour, scope) {
      const key = guideProgressKey(tour, scope);
      try {
        const value = JSON.parse(storage().getItem(key) || "null");
        if (value && Number.isInteger(value.version) && value.version >= (memory.get(key)?.version ?? 0)) return value;
      } catch { /* unavailable or malformed storage */ }
      return memory.get(key) || null;
    },
    write(tour, scope, value) {
      const key = guideProgressKey(tour, scope);
      const progress = { ...value, version: tour.version };
      memory.set(key, progress);
      try { storage().setItem(key, JSON.stringify(progress)); } catch { /* private mode */ }
    },
  };
}
