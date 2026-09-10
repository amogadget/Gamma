# Note Replay — Phase 5A

## How to use

1. Open a Gamma PDF and start a **new recording** from the microphone button.
2. Create/select an Ink block, write with Pencil, and navigate between PDF pages. New text entered into an empty note is also marked on the recording timeline.
3. Pause/stop recording. In Recordings, tap **Replay**.
4. The inline **NOTE REPLAY** bar controls audio and note rendering: play/pause, ±10 seconds, slider, and Done. Seeking restores the recorded PDF page and the final surviving ink that had begun by that point. Current strokes are progressively revealed.
5. Tap visible timed ink with a finger or Pencil to jump back to its audio position (with a two-second lead-in). Done exits Replay and restores the normal editable final drawing.

Old recordings cannot acquire timing retroactively. If a recording has no timing index, the UI explicitly reports audio-only playback with static notes.

## Exact semantics

Phase 5A is **not historical document reconstruction**. If A was written and later erased, and only B survives in the final PKDrawing, Replay never shows A. There is no stroke-add/remove/undo/redo history store in this implementation. Untimed/pre-existing ink remains static context; timed future ink is hidden. Timed ink whose audio segment is unavailable is not fabricated as untimed baseline. Future note text is dimmed in Notes; it is the final text, not a keystroke replay.

Ink coordinates stay unchanged. Playback uses a separate read-only canvas, with no save delegate. A partial replay frame can never replace the editable source. Editing/new ink is disabled during Replay. Finger/Pencil taps seek only on visible timed strokes, while ordinary finger navigation remains available.

## Timing and synchronization

- Gesture start and drawing changes use AVAudioRecorder.currentTime, not wall-clock elapsed time.
- Events refer to a stable recording segment UUID plus segment-relative start/end time. Actual finalized segment durations determine cumulative offsets; pause gaps are excluded. Small encoder duration discrepancies are clamped at segment ends.
- Stroke IDs use a reproducible creation-lineage/first-point fingerprint. PencilKit creationDate contributes to identity only, not the audio clock. Fragmented surviving strokes may inherit timing by creation lineage; this is not an erase history.
- Automatic audio rollover waits for the active Pencil gesture to finish. Interruption recovery may still truncate the active segment, which is explicitly handled by the audio recovery flow.
- Final source, time events and pending mutations are saved in the same account-scoped page snapshot. Failed-save retry retains the original stroke time and merges unrelated newly saved events rather than timing the retry as new writing.
- The audio block stores validated `replay_events`; only events referring to finalized uploaded segments are sent. Missing replay_events from older clients preserves the current server timeline; an explicit empty array clears it under revision control.
- The player seeks between actual AAC segment files. The UI follows the audio player's clock; paused seeks still update notes and page position. Refresh/reopen restores timing from Gamma/cache, not a second knowledge model.

## Verification

- `ReplayLive-1.xcresult`: 15 tests passed, including real-backend audio timeline round-trip/cache reopen, phase-5A erased-stroke semantics, progressive stroke geometry, segment offsets/page navigation, actual AAC segment seeks, stable IDs through PencilKit serialization, and read-only replay layer isolation.
- `ReplayRetry-1.xcresult`: 12 focused tests passed after final fixes, including simulated failed writes, retained original stroke time and preservation of intervening page events.
- Backend audio/ink suite: 19 passed; Ruff passed. Replay validation/idempotency/omitted-field preservation has dedicated backend coverage.
- Production API deployed after backup `/home/ubuntu/gamma-deployment-backups/before-note-replay-20260910T045509Z.tar.gz`; rollback image `gamma:before-note-replay` retained. Public health 200 and OpenAPI replay_events field verified.

The final GUI-session build exited 0, strict signature verification passed, and the app was installed and launched on the connected iPad (installation sequence 1756).

These tests use framework-generated strokes/audio and deterministic gesture callbacks, not physical Pencil touch synthesis. Long real recording-plus-handwriting sessions, touch arbitration and actual on-device performance still need user acceptance. No Phase 5B exact edit-history replay is included. Browser Note Replay has subsequently been implemented using per-stroke display assets; see `../docs/dev/note-replay.md`. Updating iPad and opening a document backfills existing ink previews without changing ink revisions or fabricating old audio timing.
