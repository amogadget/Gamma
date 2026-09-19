# Native recording and browser Note Replay

This is the workspace-aware integration on the upstream-based branch. The old
fork's implementation notes are archived in `docs/legacy-native/note-replay.md`;
recorded verification results and boundaries are in [iPad validation](../../ipad/VALIDATION.md).

## User flow

1. Open a Gamma PDF in the iPad client. PencilKit retains editable `.pkdrawing`
   sources; recording produces finalized AAC `.m4a` segments.
2. Native ink and recording blocks synchronize through workspace-scoped APIs.
   The browser shows the handwriting on the PDF and in the notes, plus an audio
   card. **Open Note Replay** opens the synchronized player.
3. The audio element's clock drives stroke reveal and page following. Seeking
   crosses segment boundaries; clicking a visible timed stroke seeks to its
   lead-in. **Done** restores the complete static ink layer.
4. Missing or stale stroke previews are explicit. The user may select static
   fallback notes; no historical timing or strokes are fabricated.

## Data and boundaries

- Native ink: `type: pdf_ink`, `ink_asset`, `preview_asset`, optional
  `replay_asset`, `pdf_page`, crop-local geometry and `ink_revision`.
- Native audio: `type: audio`, finalized `segments`, server-derived offsets and
  total duration, `replay_events`, and `audio_revision`.
- `.inkjson` (`gamma-ink-replay-v1`) contains final surviving stroke PNGs and
  reveal paths, linked by `source_sha256` to the current editable source. It is
  a display derivative, not a browser-editable substitute for PencilKit.
- Replay events use recording segment time, not wall-clock time. This is not
  historical reconstruction of erased strokes, undo operations or every prior
  drawing state. Old untimed ink stays static.
- Upstream browser `.ink` strokes remain a separate representation. Their
  sample timestamps are not automatically associated with a native recording.
- Store canonical `/api/assets/<sha256>.<ext>` references in properties. Add
  workspace/share context when requesting media; never persist the active
  account's query parameters in a block's payload.
- Rendering uses original PDF bytes without modifying them. Native PDF exports
  use readable raster pictures, not invented editable vector strokes. Audio
  links in exported notes PDFs require the reader's own Gamma access.

## Implementation map

- `frontend/src/native/NoteReplayPlayer.jsx`: segmented media, playback clock,
  seek and preview loading; failed/stalled media cannot masquerade as playback.
- `frontend/src/native/noteReplay.js`: timeline and strict derivative checks.
- `frontend/src/native/ReplayInkLayer.jsx`: complete static strokes and partial
  reveal masks. Placement helpers: `inkBlock.js` and `inkNavigation.js`.
- `frontend/src/shared/lib/assetUrl.js`: scoped browser-issued media URLs.
- `backend/gamma/routers/native_ink.py`: uploads and conditional native saves;
  preview backfill checks the source digest and does not advance ink revision.
- `backend/gamma/ops.py`: live collaboration and protected native payloads.
- `ipad/GammaIPad/`: native recording/recovery, durable outbox and cache. See
  `ipad/NATIVE_INTEGRATION.md` for account/workspace identity and migration.

Native assets are conservatively retained, including old unreferenced sources;
there is no automatic native garbage collection. Generic duplicate/cross-page
moves of native-containing trees are refused instead of guessing new recording
identities. Same-page ink/audio nesting is supported; native child notes retain
their direct-parent contract. Web delete/undo uses server-recorded provenance
within the bounded page-op history, not an unlimited recycle bin.

## Verification

From `frontend/` after `npm ci` and `npm run build`:

```sh
npm test
GAMMA_E2E_PYTHON=/path/to/backend/python npm run e2e
CHROME_PATH=/path/to/aac-capable/chrome GAMMA_E2E_REQUIRE_AAC=1 \
  GAMMA_E2E_PYTHON=/path/to/backend/python npm run e2e
CHROME_PATH=/path/to/aac-capable/chrome npm run e2e:notereplay -- --require-aac
npm run e2e:native
```

Fixtures use valid visible PNG pixels and real ffmpeg-generated AAC. Browser
checks cover visible full/partial ink, audio-clock progression, segment changes,
seek, pause, native save/preview backfill, undo, workspace scoping and handoff.
Stock Chromium may lack AAC; its seek-only result is not playback evidence.
Physical Pencil/microphone, Bluetooth/interruption and app-relaunch acceptance
remain separate from browser and simulator tests.
