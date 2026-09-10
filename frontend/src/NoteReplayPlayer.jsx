import React, { useEffect, useMemo, useRef, useState } from "react";
import { replayAssetURL, replayTimeline, replayPageAt, validateReplayInk } from "./noteReplay.js";
import { formatAudioDuration } from "./audioBlock.js";

export function useReplayAssets(inkBlocks, recordingID) {
  const [state, setState] = useState({});
  const key = inkBlocks.map(b => `${b.id}:${b.properties?.replay_asset || ""}:${b.properties?.ink_asset || ""}`).join("|");
  useEffect(() => {
    if (!recordingID) { setState({}); return; }
    const controller = new AbortController(); let live = true;
    const initial = Object.fromEntries(inkBlocks.map(block => [block.id, {status: replayAssetURL(block.properties?.replay_asset) ? "loading" : "missing"}]));
    setState(initial);
    const queue = inkBlocks.filter(block => replayAssetURL(block.properties?.replay_asset));
    let cursor=0, totalBytes=0, totalPixels=0;
    async function worker() {
      while (live && cursor<queue.length) {
        const block=queue[cursor++], url=replayAssetURL(block.properties.replay_asset);
        try {
          const response = await fetch(url, {signal: controller.signal, credentials: "same-origin"});
          if (!response.ok) throw new Error(`Replay asset HTTP ${response.status}`);
          if (Number(response.headers.get("content-length")) > 32*1024*1024) throw new Error("Replay asset too large");
          const text = await response.text();
          if (text.length > 32*1024*1024 || totalBytes+text.length > 64*1024*1024) throw new Error("Document replay preview budget exceeded");
          const data = validateReplayInk(JSON.parse(text), block.properties.ink_asset);
          if (totalPixels+data.__decodedPixels > 48_000_000) throw new Error("Document replay image budget exceeded");
          totalBytes+=text.length; totalPixels+=data.__decodedPixels;
          if (live) setState(previous => ({...previous, [block.id]: {status: "ready", data}}));
        } catch (error) {
          if (live) setState(previous => ({...previous, [block.id]: {status: "error", message: error.message}}));
        }
      }
    }
    for(let i=0;i<3;i++) void worker();
    return () => { live = false; controller.abort(); };
    // key captures the asset/source identities; note text edits need no refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, recordingID]);
  return state;
}

export default function NoteReplayPlayer({block, inkBlocks, assets, onFrame, onClose, seekRequest}) {
  const timelineKey = JSON.stringify([block.id,block.properties?.segments,block.properties?.replay_events]);
  // Only audio/timing changes should reset the clock effect, not note text edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const timeline = useMemo(() => replayTimeline(block), [timelineKey]);
  const audioRef = useRef(null), playingRef = useRef(false), pendingSeek = useRef(0), indexRef = useRef(0);
  const [index, setIndex] = useState(0), [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [error, setError] = useState(""), [staticFallback, setStaticFallback] = useState(false);
  const callbackRef = useRef(onFrame); callbackRef.current = onFrame;
  const timed = new Set(timeline.events.filter(e => e.kind === "stroke").map(e => e.block_id));
  const required = inkBlocks.filter(b => timed.has(b.id));
  const loading = required.some(b => !assets[b.id] || assets[b.id].status === "loading");
  const missing = required.some(b => ["missing", "error"].includes(assets[b.id]?.status));
  const canPlay = timeline.segments.length > 0 && !loading && (!missing || staticFallback);
  const segment = timeline.segments[index];
  useEffect(() => {
    const audio=audioRef.current;
    if (audio && segment?.url && audio.getAttribute("src") !== segment.url) {
      audio.src=segment.url; audio.load();
    }
  }, [segment?.url, segment?.id]);
  function frame(value) {
    setTime(value);
    callbackRef.current({recordingID: block.id, time: value, events: timeline.events, page: replayPageAt(timeline.events, value)});
  }
  function seek(value) {
    const target = Math.max(0, Math.min(timeline.duration, value));
    let offset = 0, next = 0;
    while (next < timeline.segments.length-1 && offset + timeline.segments[next].duration <= target) {
      offset += timeline.segments[next].duration; next++;
    }
    if (!timeline.segments.length) return;
    pendingSeek.current = target-offset;
    if (target >= timeline.duration) { playingRef.current = false; setPlaying(false); audioRef.current?.pause(); }
    if (next !== indexRef.current) {
      indexRef.current = next;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = timeline.segments[next].url;
        audioRef.current.load();
      }
      setIndex(next);
    } else if (audioRef.current) { audioRef.current.currentTime = pendingSeek.current; }
    frame(target);
  }
  function play() {
    if (!canPlay) return;
    setError("");
    if (time >= timeline.duration) seek(0);
    playingRef.current = true;
    if (audioRef.current?.error) audioRef.current.load();
    audioRef.current?.play().catch(e => { playingRef.current = false; setPlaying(false); setError(e.message); });
  }
  function pause() { playingRef.current = false; audioRef.current?.pause(); setPlaying(false); }
  useEffect(() => {
    if (!canPlay) { playingRef.current=false; audioRef.current?.pause(); setPlaying(false); }
  }, [canPlay]);
  useEffect(() => {
    let alive = true, token, lastFrame = 0;
    const audioElement = audioRef.current;
    const update = now => {
      if (!alive) return;
      const audio = audioRef.current;
      if (audio && !audio.paused && !audio.ended && now-lastFrame >= 33) {
        lastFrame = now;
        const current = timeline.segments[indexRef.current];
        if (current) {
          const value = Math.min(timeline.duration, (timeline.starts.get(current.id) || 0) + Math.min(audio.currentTime,current.duration));
          setTime(value);
          callbackRef.current({recordingID: block.id, time: value, events: timeline.events, page: replayPageAt(timeline.events, value)});
        }
      }
      token = requestAnimationFrame(update);
    };
    token = requestAnimationFrame(update);
    callbackRef.current({recordingID:block.id,time:0,events:timeline.events,page:replayPageAt(timeline.events,0)});
    return () => { alive=false; cancelAnimationFrame(token); audioElement?.pause(); };
  }, [block.id, timeline]);
  useEffect(() => {
    if (seekRequest?.recordingID === block.id) {
      seek(seekRequest.time);
      if (canPlay) {
        playingRef.current = true;
        audioRef.current?.play().catch(e => { playingRef.current=false; setPlaying(false); setError(e.message); });
      }
    }
    // A new request token represents an explicit ink click, even at the same time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);
  return <section className="noteReplayBar" aria-label="Note Replay">
    <audio ref={audioRef} preload="metadata"
      onLoadedMetadata={() => {
        const audio = audioRef.current;
        audio.currentTime = Math.min(pendingSeek.current, Number.isFinite(audio.duration) ? audio.duration : pendingSeek.current);
        if (playingRef.current) audio.play().catch(e => { playingRef.current=false; setPlaying(false); setError(e.message); });
      }}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onError={() => { pause(); setError("Audio unavailable. Check your Gamma session and retry."); }}
      onEnded={() => {
        if (indexRef.current + 1 < timeline.segments.length) {
          pendingSeek.current=0; indexRef.current++; setIndex(indexRef.current);
        } else { playingRef.current=false; setPlaying(false); frame(timeline.duration); }
      }} />
    <div className="noteReplayControls">
      <strong>NOTE REPLAY</strong>
      <button className="uiBtn sm" onClick={() => seek(time-10)} disabled={!segment} aria-label="Back ten seconds">−10</button>
      <button className="uiBtn sm" onClick={playing ? pause : play} disabled={!canPlay} aria-label={playing ? "Pause replay" : "Play replay"}>{playing ? "Pause" : "Play"}</button>
      <button className="uiBtn sm" onClick={() => seek(time+10)} disabled={!segment} aria-label="Forward ten seconds">+10</button>
      <input type="range" min="0" max={Math.max(.01,timeline.duration)} step="0.01" value={time} onChange={e => seek(Number(e.target.value))} aria-label="Replay timeline" />
      <span>{formatAudioDuration(time)} / {formatAudioDuration(timeline.duration)}</span>
      <button className="uiBtn sm" onClick={() => { pause(); onClose(); }}>Done</button>
    </div>
    {loading && <div className="noteReplayMessage">Loading stroke previews…</div>}
    {missing && <div className="noteReplayMessage">Some timed notes need stroke previews. Open this document on the updated iPad, let it sync, then refresh this page.
      <label><input type="checkbox" checked={staticFallback} onChange={e => setStaticFallback(e.target.checked)} /> Play audio with static fallback notes</label>
    </div>}
    {!timeline.events.length && <div className="noteReplayMessage">This recording has no note timing. Audio plays with static notes.</div>}
    {error && <div className="noteReplayMessage" role="alert">{error}</div>}
  </section>;
}
