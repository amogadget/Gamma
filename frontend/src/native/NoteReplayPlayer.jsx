// Note Replay in the browser (docs/dev/handwriting.md "Note Replay").
//
// The iPad records with an audio clock and exports a per-stroke `.inkjson`
// derivative next to the editable PKDrawing. This player drives one <audio>
// element through the recording's finalized segments IN ORDER and reads that
// element's own currentTime — never a timer of its own — to decide which
// strokes exist yet, which page we were on, and what the PDF layer masks.
//
// Two honesty rules are enforced in the UI, not just in the docs:
//   • A recording whose timed strokes have no usable derivative refuses to
//     pretend to be synchronized, and says what to do instead; "sound with
//     static notes" is an explicit opt-in.
//   • A recording with no timing at all plays audio with static notes and says
//     so — timing is never invented.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { replayAssetURL, replayTimeline, replayPageAt, validateReplayInk } from "./noteReplay.js";
import { formatAudioDuration } from "./audioBlock.js";
import { assetUrl } from "../shared/lib/utils";

// Per-document derivative loader: the SAME data feeds the static PDF layer and
// the Notes thumbnails, so entering or leaving Replay never re-fetches and
// never drops back to the low-resolution PNG. `scopeKey` is the account +
// workspace + document identity — switching any of them aborts and refetches.
export function useReplayAssets(inkBlocks, scopeKey) {
  const [state, setState] = useState({});
  // Identities only: a note text edit must not refetch.
  const key = inkBlocks.map((b) => `${b.id}:${b.properties?.replay_asset || ""}:${b.properties?.ink_asset || ""}`).join("|");
  useEffect(() => {
    if (!scopeKey) {
      setState({});
      return;
    }
    const controller = new AbortController();
    let live = true;
    const initial = Object.fromEntries(inkBlocks.map((block) => [
      block.id,
      { status: replayAssetURL(block.properties?.replay_asset) ? "loading" : "missing" },
    ]));
    setState(initial);
    const queue = inkBlocks.filter((block) => replayAssetURL(block.properties?.replay_asset));
    let cursor = 0, totalBytes = 0, totalPixels = 0;
    // Three workers, per the documented budget: one big document must not
    // open every derivative at once.
    async function worker() {
      while (live && cursor < queue.length) {
        const block = queue[cursor++], url = replayAssetURL(block.properties.replay_asset);
        try {
          const response = await fetch(assetUrl(url), { signal: controller.signal, credentials: "same-origin" });
          if (!response.ok) throw new Error(`Replay asset HTTP ${response.status}`);
          if (Number(response.headers.get("content-length")) > 32 * 1024 * 1024) throw new Error("Replay asset too large");
          const text = await response.text();
          if (text.length > 32 * 1024 * 1024 || totalBytes + text.length > 64 * 1024 * 1024) {
            throw new Error("Document replay preview budget exceeded");
          }
          // Rejects a derivative whose source hash is not this block's
          // PKDrawing — a stale preview must never be shown as current ink.
          const data = validateReplayInk(JSON.parse(text), block.properties.ink_asset);
          if (totalPixels + data.__decodedPixels > 48_000_000) throw new Error("Document replay image budget exceeded");
          totalBytes += text.length;
          totalPixels += data.__decodedPixels;
          if (live) setState((previous) => ({ ...previous, [block.id]: { status: "ready", data } }));
        } catch (error) {
          if (live) setState((previous) => ({ ...previous, [block.id]: { status: "error", message: error.message } }));
        }
      }
    }
    for (let i = 0; i < 3; i++) void worker();
    return () => { live = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the asset identities
  }, [key, scopeKey]);
  return state;
}

export default function NoteReplayPlayer({ block, inkBlocks, assets, onFrame, onClose, seekRequest }) {
  const timelineKey = JSON.stringify([block.id, block.properties?.segments, block.properties?.replay_events]);
  // Only audio/timing changes reset the clock effect, not note text edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const timeline = useMemo(() => replayTimeline(block), [timelineKey]);
  const audioRef = useRef(null), playingRef = useRef(false), pendingSeek = useRef(0), indexRef = useRef(0);
  const [index, setIndex] = useState(0), [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [error, setError] = useState(""), [staticFallback, setStaticFallback] = useState(false);
  const callbackRef = useRef(onFrame);
  callbackRef.current = onFrame;
  // Blocks the recording has stroke events for: those are the ones that MUST
  // have a derivative before synchronized playback may start.
  const timed = new Set(timeline.events.filter((e) => e.kind === "stroke").map((e) => e.block_id));
  const required = inkBlocks.filter((b) => timed.has(b.id));
  const loading = required.some((b) => !assets[b.id] || assets[b.id].status === "loading");
  const missing = required.some((b) => ["missing", "error"].includes(assets[b.id]?.status));
  const canPlay = timeline.segments.length > 0 && !loading && (!missing || staticFallback);
  const segment = timeline.segments[index];
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && segment?.url && audio.getAttribute("src") !== segment.url) {
      audio.src = segment.url;
      audio.load();
    }
  }, [segment?.url, segment?.id]);
  function frame(value) {
    setTime(value);
    callbackRef.current({
      recordingID: block.id,
      time: value,
      events: timeline.events,
      page: replayPageAt(timeline.events, value),
    });
  }
  // One clock: a global time is resolved to (segment, offset) and both the
  // element and the frame state move together, at boundaries and inside a
  // segment alike.
  function seek(value) {
    const target = Math.max(0, Math.min(timeline.duration, value));
    if (!timeline.segments.length) return;
    let offset = 0, next = 0;
    while (next < timeline.segments.length - 1 && offset + timeline.segments[next].duration <= target) {
      offset += timeline.segments[next].duration;
      next++;
    }
    pendingSeek.current = target - offset;
    if (target >= timeline.duration) {
      playingRef.current = false;
      setPlaying(false);
      audioRef.current?.pause();
    }
    if (next !== indexRef.current) {
      indexRef.current = next;
      if (audioRef.current) {
        // Changing src restarts playback: pause first so the old segment can
        // never keep playing past the new position.
        audioRef.current.pause();
        audioRef.current.src = timeline.segments[next].url;
        audioRef.current.load();
      }
      setIndex(next);
    } else if (audioRef.current) {
      audioRef.current.currentTime = pendingSeek.current;
    }
    frame(target);
  }
  function play() {
    if (!canPlay) return;
    setError("");
    if (time >= timeline.duration) seek(0);
    playingRef.current = true;
    if (audioRef.current?.error) audioRef.current.load();
    // A rejected play() must also stop the element: onError is not guaranteed
    // to have run first, and an element left with paused=false keeps the frame
    // loop running against a clock that will never move.
    audioRef.current?.play().catch((e) => {
      playingRef.current = false;
      audioRef.current?.pause();
      setPlaying(false);
      setError(e.message);
    });
  }
  function pause() {
    playingRef.current = false;
    audioRef.current?.pause();
    setPlaying(false);
  }
  useEffect(() => {
    // The derivative set changed under us (or playback was never possible):
    // stop rather than keep a half-active player.
    if (!canPlay) {
      playingRef.current = false;
      audioRef.current?.pause();
      setPlaying(false);
    }
  }, [canPlay]);
  useEffect(() => {
    let alive = true, token, lastFrame = 0;
    const audioElement = audioRef.current;
    const update = (now) => {
      if (!alive) return;
      const audio = audioRef.current;
      // The AUDIO element is the clock; the animation frame only reads it, and
      // ~30 fps is enough for the mask. It counts as a clock only while it is
      // really playing MEDIA: an element that is merely unpaused can still be
      // empty or in an error state, and its currentTime is then just the last
      // position a seek put there — reading it would walk the timeline back to
      // that stale time (and, in a browser with no decoder for the recording,
      // look like playback that never happened). HAVE_CURRENT_DATA is the
      // threshold, so a stalled or failed source freezes the mask instead.
      const playingMedia = audio && !audio.paused && !audio.ended && !audio.error && audio.readyState >= 2;
      if (playingMedia && now - lastFrame >= 33) {
        lastFrame = now;
        const current = timeline.segments[indexRef.current];
        if (current) {
          const value = Math.min(timeline.duration,
            (timeline.starts.get(current.id) || 0) + Math.min(audio.currentTime, current.duration));
          setTime(value);
          callbackRef.current({
            recordingID: block.id,
            time: value,
            events: timeline.events,
            page: replayPageAt(timeline.events, value),
          });
        }
      }
      token = requestAnimationFrame(update);
    };
    token = requestAnimationFrame(update);
    callbackRef.current({ recordingID: block.id, time: 0, events: timeline.events, page: replayPageAt(timeline.events, 0) });
    return () => { alive = false; cancelAnimationFrame(token); audioElement?.pause(); };
  }, [block.id, timeline]);
  useEffect(() => {
    // Clicking a visible timed stroke: seek a short lead-in before the stroke
    // and start playing. A new request token is an explicit click even at the
    // same time, so it always acts.
    if (seekRequest?.recordingID === block.id) {
      seek(seekRequest.time);
      if (canPlay) {
        playingRef.current = true;
        audioRef.current?.play().catch((e) => { playingRef.current = false; setPlaying(false); setError(e.message); });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);
  return (
    <section className="noteReplayBar" aria-label="Note Replay">
      <audio ref={audioRef} preload="metadata"
        onLoadedMetadata={() => {
          const audio = audioRef.current;
          audio.currentTime = Math.min(pendingSeek.current, Number.isFinite(audio.duration) ? audio.duration : pendingSeek.current);
          if (playingRef.current) audio.play().catch((e) => { playingRef.current = false; setPlaying(false); setError(e.message); });
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => { pause(); setError("Audio unavailable. Check your Gamma session and retry."); }}
        onEnded={() => {
          if (indexRef.current + 1 < timeline.segments.length) {
            // Segments are played in order: the next one starts and the
            // element's own events keep the clock monotonic.
            pendingSeek.current = 0;
            indexRef.current++;
            setIndex(indexRef.current);
          } else {
            playingRef.current = false;
            setPlaying(false);
            frame(timeline.duration);
          }
        }} />
      <div className="noteReplayControls">
        <strong>NOTE REPLAY</strong>
        <button className="uiBtn sm" onClick={() => seek(time - 10)} disabled={!segment} aria-label="Back ten seconds">−10</button>
        <button className="uiBtn sm" onClick={playing ? pause : play} disabled={!canPlay}
          aria-label={playing ? "Pause replay" : "Play replay"}>{playing ? "Pause" : "Play"}</button>
        <button className="uiBtn sm" onClick={() => seek(time + 10)} disabled={!segment} aria-label="Forward ten seconds">+10</button>
        <input type="range" min="0" max={Math.max(0.01, timeline.duration)} step="0.01" value={time}
          onChange={(e) => seek(Number(e.target.value))} aria-label="Replay timeline" />
        <span>{formatAudioDuration(time)} / {formatAudioDuration(timeline.duration)}</span>
        <button className="uiBtn sm" onClick={() => { pause(); onClose(); }}>Done</button>
      </div>
      {loading ? <div className="noteReplayMessage">Loading stroke previews…</div> : null}
      {missing ? (
        <div className="noteReplayMessage">Some timed notes need stroke previews. Open this document on the updated iPad, let it sync, then refresh this page.
          <label><input type="checkbox" checked={staticFallback} onChange={(e) => setStaticFallback(e.target.checked)} /> Play audio with static fallback notes</label>
        </div>
      ) : null}
      {!timeline.events.length ? (
        <div className="noteReplayMessage">This recording has no note timing. Audio plays with static notes.</div>
      ) : null}
      {error ? <div className="noteReplayMessage" role="alert">{error}</div> : null}
    </section>
  );
}
