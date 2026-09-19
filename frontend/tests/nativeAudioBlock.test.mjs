import test from "node:test";
import assert from "node:assert/strict";
import { audioAssetUrl, audioSegments, formatAudioDuration } from "../src/native/audioBlock.js";

test("audio helpers only approve local content-addressed m4a refs", () => {
  const url = `/api/assets/${"a".repeat(64)}.m4a`;
  assert.equal(audioAssetUrl(url), url);
  assert.equal(audioAssetUrl("https://example.test/a.m4a"), null);
  assert.equal(audioAssetUrl(`${url}?ws=personal`), null, "the scope query is added at render time, not stored");
  assert.deepEqual(
    audioSegments({ properties: { type: "audio", segments: [{ id: "x", asset: url, duration: 2.4 }, { id: "y", asset: "bad", duration: 1 }] } }),
    [{ id: "x", asset: url, duration: 2.4, url }],
  );
});

test("a non-audio block has no segments, and a malformed manifest is not a player", () => {
  assert.deepEqual(audioSegments({ properties: { type: "pdf_ink", segments: [{ id: "x", asset: "/api/assets/x.m4a" }] } }), []);
  assert.deepEqual(audioSegments({ properties: { type: "audio", segments: "nope" } }), []);
  assert.deepEqual(audioSegments(null), []);
});

test("audio duration formatting is bounded and stable", () => {
  assert.equal(formatAudioDuration(65.2), "1:05");
  assert.equal(formatAudioDuration(Infinity), "0:00");
  assert.equal(formatAudioDuration(-3), "0:00");
  assert.equal(formatAudioDuration("nope"), "0:00");
});
