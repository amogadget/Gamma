import test from "node:test";
import assert from "node:assert/strict";
import { appendInkSample, predictedInkSamples } from "../src/ink/inkInput.js";

const drawing = (k = 1) => ({ samples: [], pen: true, pressure: true, startTime: 100, k,
  use: { tool: "pen" }, toPt: (e) => ({ x: e.clientX / k, y: e.clientY / k }) });
const event = (x, timeStamp, pressure = 0.7) => ({ clientX: x, clientY: 20, timeStamp, pressure });

test("samples retain hardware timing, pressure changes and the pen-up endpoint", () => {
  const d = drawing();
  appendInkSample(d, event(10, 100, 0.2));
  appendInkSample(d, event(20, 104, 0.8));
  appendInkSample(d, event(20, 108, 0.4));
  appendInkSample(d, event(30, 112, 0), true);
  appendInkSample(d, event(30, 113, 0), true);
  assert.deepEqual(d.samples.map(({ x, p, t }) => [x, p, t]),
    [[10, 0.2, 0], [20, 0.8, 4], [20, 0.4, 8], [30, 0.4, 12]]);
});

test("pressure-off and finger strokes stay even; sample times cannot run backwards", () => {
  for (const patch of [{ pressure: false }, { pen: false }]) {
    const d = Object.assign(drawing(), patch);
    appendInkSample(d, event(10, 110, 0.1));
    appendInkSample(d, event(20, 105, 0.9));
    assert.deepEqual(d.samples.map(({ p, t }) => [p, t]), [[0.5, 10], [0.5, 10]]);
  }
});

test("prediction is bounded in time and screen distance and never changes stored samples", () => {
  for (const k of [0.5, 1, 3]) {
    const d = drawing(k);
    appendInkSample(d, event(10, 100));
    const move = { ...event(10, 100), getPredictedEvents: () => [event(15, 108), event(20, 116), event(21, 120)] };
    assert.equal(predictedInkSamples(d, move).length, 2);
    move.getPredictedEvents = () => [event(23, 108)];
    assert.deepEqual(predictedInkSamples(d, move), []);
    assert.equal(d.samples.length, 1);
    assert.deepEqual(predictedInkSamples(d, event(10, 100)), []);
    d.use.tool = "highlighter";
    assert.deepEqual(predictedInkSamples(d, move), []);
  }
});
