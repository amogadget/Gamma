// Native audio blocks (docs/dev/handwriting.md "Audio and Note Replay"): one
// recording session is one `audio` block whose segments are ordered, finalized
// `.m4a` assets. The web plays them; it never writes the manifest.
//
// Same rule as the ink previews: only a bare content-addressed same-origin ref
// is accepted, and the workspace/share scope is added where the browser issues
// the request, not stored in the block.

const AUDIO_REF = /^\/api\/assets\/[0-9a-f]{64}\.m4a$/;

export function audioAssetUrl(ref) {
  return typeof ref === "string" && AUDIO_REF.test(ref) ? ref : null;
}

export function formatAudioDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return "0:00";
  const whole = Math.round(n);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// The playable segments of a block, in recording order, with unusable refs
// dropped rather than rendered as a broken player.
export function audioSegments(block) {
  return block?.properties?.type === "audio" && Array.isArray(block.properties.segments)
    ? block.properties.segments
        .map((s) => ({ ...s, url: audioAssetUrl(s.asset) }))
        .filter((s) => s.url)
    : [];
}
