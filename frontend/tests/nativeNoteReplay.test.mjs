import test from "node:test";
import assert from "node:assert/strict";
import { replayTimeline, replayPageAt, strokeEvent, strokeProgress, revealPoints, validateReplayInk } from "../src/native/noteReplay.js";

const hash = "a".repeat(64);
const segment = (id) => ({ id, asset: `/api/assets/${hash}.m4a`, duration: 10 });
const stroke = { kind: "stroke", segment_id: "two", start: 2, end: 4, pdf_page: 2, block_id: "ink", stroke_id: "line.part" };
const timeline = replayTimeline({
  properties: {
    type: "audio",
    segments: [segment("one"), segment("two")],
    replay_events: [
      { kind: "page", segment_id: "one", start: 0, end: 0, pdf_page: 1 },
      { kind: "page", segment_id: "two", start: 0, end: 0, pdf_page: 2 },
      stroke,
    ],
  },
});

test("audio segment time excludes pause gaps and restores the page", () => {
  assert.equal(timeline.duration, 20);
  assert.equal(replayPageAt(timeline.events, 9), 1);
  assert.equal(replayPageAt(timeline.events, 13), 2);
  const event = strokeEvent(timeline.events, "ink", "line.part");
  assert.equal(strokeProgress(event, 11), 0);
  assert.equal(strokeProgress(event, 13), 0.5);
  assert.equal(strokeProgress(event, 15), 1);
});

test("stroke fragments inherit lineage; unrelated/untimed ink stays static", () => {
  assert.equal(strokeEvent(timeline.events, "ink", "line.fragment")?.startTime, 12);
  assert.equal(strokeEvent(timeline.events, "other", "line.part"), null);
  assert.equal(strokeProgress(null, 0), 1);
});

test("events referencing an unfinalized segment or impossible times are dropped", () => {
  const partial = replayTimeline({
    properties: {
      type: "audio",
      segments: [segment("one")],
      replay_events: [
        { kind: "stroke", segment_id: "missing", start: 0, end: 1, pdf_page: 1, block_id: "ink", stroke_id: "s" },
        { kind: "stroke", segment_id: "one", start: 5, end: 4, pdf_page: 1, block_id: "ink", stroke_id: "s" },
        { kind: "page", segment_id: "one", start: 0, end: 0, pdf_page: 0 },
      ],
    },
  });
  assert.deepEqual(partial.events, []);
  assert.equal(replayPageAt(partial.events, 5), null);
});

test("progressive reveal interpolates the current point without modifying source", () => {
  const points = [{ x: 0, y: 10, t: 0, radius: 2 }, { x: 100, y: 10, t: 1, radius: 4 }];
  assert.deepEqual(revealPoints(points, 0.25).at(-1), { x: 25, y: 10, t: 0.25, radius: 2.5 });
  assert.equal(points.length, 2);
  assert.deepEqual(revealPoints(points, 0), []);
  assert.equal(revealPoints(points, 1), points);
});

test("malformed and stale replay assets are rejected", () => {
  const base = { format: "gamma-ink-replay-v1", source_sha256: hash, width: 612, height: 792, strokes: [] };
  assert.equal(validateReplayInk(base, `/api/assets/${hash}.pkdrawing`), base);
  assert.throws(() => validateReplayInk({ ...base, format: "svg" }, `/api/assets/${hash}.pkdrawing`));
  assert.throws(() => validateReplayInk(base, `/api/assets/${"b".repeat(64)}.pkdrawing`));
  assert.throws(() => validateReplayInk({ ...base, width: Infinity }, `/api/assets/${hash}.pkdrawing`));
  assert.throws(() => validateReplayInk(
    { ...base, strokes: [{ id: "x", bounds: { x: 0, y: 0, width: 2, height: 2 }, png: "javascript:bad", points: [] }] },
    `/api/assets/${hash}.pkdrawing`,
  ));
});

test("a derivative is checked against its own source, and its size is measured", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
    Buffer.from([0, 0, 0, 4, 0, 0, 0, 8]),
  ]).toString("base64");
  const data = validateReplayInk({
    format: "gamma-ink-replay-v1", source_sha256: hash, width: 100, height: 100,
    strokes: [{ id: "s", bounds: { x: 0, y: 0, width: 4, height: 8 }, png, points: [{ x: 0, y: 0, t: 0, radius: 1 }] }],
  }, `/api/assets/${hash}.pkdrawing`);
  assert.equal(data.__decodedPixels, 32);
  // The workspace/share scope lives on the URL, never in ink_asset.
  assert.throws(() => validateReplayInk(
    { format: "gamma-ink-replay-v1", source_sha256: hash, width: 1, height: 1, strokes: [] },
    `/api/assets/${hash}.pkdrawing?ws=personal`,
  ));
});
