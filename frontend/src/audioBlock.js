// Safe rendering helpers for native audio blocks.
export function audioAssetUrl(ref) {
  return typeof ref === "string" && /^\/api\/assets\/[0-9a-f]{64}\.m4a$/.test(ref) ? ref : null;
}
export function formatAudioDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return "0:00";
  const whole = Math.round(n);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
export function audioSegments(block) {
  return block?.properties?.type === "audio" && Array.isArray(block.properties.segments)
    ? block.properties.segments.map((s) => ({ ...s, url: audioAssetUrl(s.asset) })).filter((s) => s.url) : [];
}
