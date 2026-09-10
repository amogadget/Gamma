import test from "node:test";
import assert from "node:assert/strict";
import { audioAssetUrl, audioSegments, formatAudioDuration } from "./audioBlock.js";

test("audio helpers only approve local content-addressed m4a refs", () => {
  const url = `/api/assets/${"a".repeat(64)}.m4a`;
  assert.equal(audioAssetUrl(url), url);
  assert.equal(audioAssetUrl("https://example.test/a.m4a"), null);
  assert.deepEqual(audioSegments({ properties: { type: "audio", segments: [{ id: "x", asset: url, duration: 2.4 }, { id: "y", asset: "bad", duration: 1 }] } }), [{ id: "x", asset: url, duration: 2.4, url }]);
});

test("audio duration formatting is bounded and stable", () => {
  assert.equal(formatAudioDuration(65.2), "1:05");
  assert.equal(formatAudioDuration(Infinity), "0:00");
});
