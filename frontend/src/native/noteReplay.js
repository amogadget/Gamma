// Note Replay's timeline model, pure and audio-clock driven: segment durations
// (from finalized files, never wall-clock between button presses) give every
// replay event its position on ONE global clock.
//
// Phase 5A, deliberately: replay starts from the FINAL retained drawing and
// uses time to decide what may be shown. Nothing here reconstructs edit
// history, and ink with no recorded time stays static context — untimed
// strokes are never given invented timing.

import { audioSegments } from "./audioBlock.js";

const REPLAY_REF = /^\/api\/assets\/[a-f0-9]{64}\.inkjson$/;

export const replayAssetURL = (value) => (typeof value === "string" && REPLAY_REF.test(value) ? value : null);

export function replayTimeline(block) {
  const segments = audioSegments(block).filter((s) => Number.isFinite(s.duration) && s.duration > 0);
  const starts = new Map();
  let total = 0;
  for (const segment of segments) {
    starts.set(segment.id, total);
    total += segment.duration;
  }
  const durations = new Map(segments.map((s) => [s.id, s.duration]));
  const events = (Array.isArray(block?.properties?.replay_events) ? block.properties.replay_events : [])
    .filter((event) => ["stroke", "page", "note"].includes(event?.kind) && starts.has(event.segment_id) &&
      Number.isFinite(event.start) && Number.isFinite(event.end) && event.start >= 0 && event.end >= event.start &&
      Number.isSafeInteger(event.pdf_page) && event.pdf_page > 0)
    .map((event) => ({
      ...event,
      // Clamp inside its own segment: AAC priming/padding at a boundary may not
      // push an event past the segment's measured length.
      startTime: starts.get(event.segment_id) + Math.min(event.start, durations.get(event.segment_id)),
      endTime: starts.get(event.segment_id) + Math.min(event.end, durations.get(event.segment_id)),
    }));
  return { segments, starts, events, duration: total };
}

// The page the audio clock says we were on: the latest recorded page event at
// or before this time.
export function replayPageAt(events, time) {
  return events
    .filter((e) => e.kind === "page" && e.startTime <= time)
    .sort((a, b) => a.startTime - b.startTime)
    .at(-1)?.pdf_page ?? null;
}

// Stroke identity is `lineage.signature`, so a stroke's id may carry a
// fragment suffix after erasure/merge: an exact hit wins, else the same
// lineage matches.
export function strokeEvent(events, blockID, strokeID) {
  const candidates = events.filter((e) => e.kind === "stroke" && e.block_id === blockID && typeof e.stroke_id === "string");
  return candidates.find((e) => e.stroke_id === strokeID) ??
    candidates.find((e) => e.stroke_id.startsWith(strokeID.split(".")[0] + ".")) ?? null;
}

export function strokeProgress(event, time) {
  if (!event) return 1; // untimed ink is static context, never fabricated timing
  if (time < event.startTime) return 0;
  if (time >= event.endTime || event.endTime <= event.startTime) return 1;
  return (time - event.startTime) / (event.endTime - event.startTime);
}

// The sampled path prefix for a stroke in progress, interpolated up to the
// cutoff. Display approximation only — the final appearance is still the
// native-rendered PNG — so the source array is never modified.
export function revealPoints(points, progress) {
  if (!points.length || progress <= 0) return [];
  if (progress >= 1) return points;
  const cutoff = points[0].t + (points.at(-1).t - points[0].t) * progress;
  const prefix = points.filter((p) => p.t <= cutoff);
  const next = points.findIndex((p) => p.t > cutoff);
  if (next > 0) {
    const a = points[next - 1], b = points[next], fraction = (cutoff - a.t) / (b.t - a.t);
    prefix.push({
      x: a.x + (b.x - a.x) * fraction,
      y: a.y + (b.y - a.y) * fraction,
      t: cutoff,
      radius: a.radius + (b.radius - a.radius) * fraction,
    });
  }
  return prefix;
}

// A `.inkjson` derivative is only usable when it really belongs to THIS
// block's editable source (`ink_asset`), and only when its own numbers are
// bounded and finite. Everything is checked before any image is built from it:
// the SVG layer is constructed from validated numbers, never from the file's
// own markup.
export function validateReplayInk(data, inkAsset) {
  const fail = () => { throw new Error("Invalid or stale per-stroke replay preview"); };
  if (data?.format !== "gamma-ink-replay-v1" || !/^[a-f0-9]{64}$/.test(data.source_sha256 ?? "") ||
      inkAsset !== `/api/assets/${data.source_sha256}.pkdrawing` ||
      ![data.width, data.height].every((n) => Number.isFinite(n) && n > 0 && n <= 100000) ||
      !Array.isArray(data.strokes) || data.strokes.length > 2000) fail();
  let pixels = 0, points = 0;
  for (const s of data.strokes) {
    if (typeof s.id !== "string" || !s.id.length || s.id.length > 256) fail();
    const b = s.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 ||
        b.x + b.width > data.width + 0.01 || b.y + b.height > data.height + 0.01 ||
        typeof s.png !== "string" || s.png.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s.png)) fail();
    let header;
    try { header = atob(s.png.slice(0, 44)); } catch { fail(); }
    if (!header || header.length < 24 || header.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || header.slice(12, 16) !== "IHDR") fail();
    const integer = (start) => Array.from(header.slice(start, start + 4), (c) => c.charCodeAt(0)).reduce((n, v) => n * 256 + v, 0);
    const width = integer(16), height = integer(20);
    if (width < 1 || height < 1 || width > 4096 || height > 4096 || (pixels += width * height) > 24_000_000) fail();
    if (!Array.isArray(s.points) || !s.points.length || (points += s.points.length) > 200000) fail();
    let previous = -1;
    for (const p of s.points) {
      if (![p.x, p.y, p.t, p.radius].every(Number.isFinite) || Math.abs(p.x) > 1e7 || Math.abs(p.y) > 1e7 ||
          p.t < previous || p.t < 0 || p.radius <= 0 || p.radius > 1e6) fail();
      previous = p.t;
    }
  }
  // The document-level loader sums this against its budget without re-walking
  // thousands of strokes.
  Object.defineProperty(data, "__decodedPixels", { value: pixels, configurable: true });
  return data;
}
