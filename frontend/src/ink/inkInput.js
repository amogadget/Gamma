// Pointer samples stay in page units; predictions are a disposable preview.
export function inkSample(d, event, ending = false) {
  const previous = d.samples.at(-1);
  return {
    ...d.toPt(event),
    // Pointer-up pressure is always zero. Keep the last contact pressure
    // instead of making a bulb or a sudden thin spot at the end of a letter.
    p: d.pen && d.pressure
      ? (ending ? previous?.p ?? 0.5 : event.pressure > 0 ? event.pressure : 0.5)
      : 0.5,
    t: Math.max(previous?.t ?? 0, event.timeStamp - d.startTime),
  };
}

export function appendInkSample(d, event, ending = false) {
  const next = inkSample(d, event, ending);
  const previous = d.samples.at(-1);
  // Repeated endpoints should not turn a tap into a tiny artificial line.
  if (previous && next.x === previous.x && next.y === previous.y && next.p === previous.p) return;
  d.samples.push(next);
}

export function predictedInkSamples(d, event) {
  if (!d.pen || d.use.tool !== "pen") return [];
  const last = d.samples.at(-1);
  if (!last) return [];
  const out = [];
  for (const prediction of event.getPredictedEvents?.() || []) {
    const ahead = prediction.timeStamp - event.timeStamp;
    if (ahead <= 0) continue;
    if (ahead > 16) break;
    const point = inkSample(d, prediction);
    // Limit overshoot in screen pixels at every zoom level.
    if (Math.hypot(point.x - last.x, point.y - last.y) * d.k > 12) break;
    out.push({ ...point, p: last.p });
  }
  return out;
}
