# Handwriting (ink) annotations

Draw on a PDF page with a stylus, mouse or finger; the strokes become a
block in the page's notes. The survey behind the shape, and how Notability
does the same things, is in
[research/handwriting.md](../research/handwriting.md). Code:
`gamma/ink.py` + `gamma/routers/ink.py` (server), `frontend/src/ink/ink.js`,
`ink/inkStore.js`, `ink/InkLayer.jsx`, `ink/inkInput.js` (client), tests `backend/tests/test_ink.py`,
`frontend/tests/ink.test.mjs`, `frontend/tests/inkInput.test.mjs`,
e2e `tests/e2e/scenarios/ink.mjs` and `inkEditing.mjs`.

## What the user sees

- The pen button in the viewer's zoom column opens the **tool strip** at
  the top of the page, laid out like Notability's: a row of **tool
  presets** — each a pen or a highlighter with its own colour and width,
  shown as the icon over a colour bar (four pens and three highlighters
  to start) — then the eraser, the lasso, a hand (nothing armed: scroll
  and select text), *New group* (+) and close. One tap arms a tool;
  **tapping the armed tool again opens its options row** under the strip.
  For a preset that row is the palette (14 pen / 8 highlighter colours
  plus a custom colour through the browser's picker), eight widths as
  dots, *Duplicate* (a copy right after it, armed and still open for
  editing) and *Remove*; the change applies to that preset, so the row is
  the user's own set of pens (up to 12, kept in localStorage,
  `gamma-ink-tools`). Keys while the strip is open: `1`–`9` arm the preset
  at that position, `P` / `H` step through the pens / highlighters, `E`
  `L` `V` the eraser / lasso / hand, `Esc`, `Delete` (the lasso
  selection), and **`Ctrl+Z` / `Ctrl+Shift+Z` step the strokes** (each
  stroke or selection edit is one entry; the history is per visit
  of the page). Opening the strip arms the last pen used.
- The **eraser**'s options row: *whole strokes* removes anything it
  touches, *partial* cuts through them (the pieces on either side become
  their own strokes), and three sizes. The
  **lasso**'s row: *freeform* circles strokes (more than half their
  samples inside), *box* drags a rectangle; the dashed box then moves by
  dragging and deletes with `Delete`. Both work across groups on the page.
- **Tap existing ink to select it.** With *Fingers never draw* on, a finger
  tap or a 450 ms stationary hold selects the nearest stroke (10 CSS px hit
  tolerance, topmost wins). A mouse click in Hand mode and a short tap with
  the lasso select the same way. A swipe still scrolls: more than 8 CSS px
  of movement, a second contact, a pen contact or a cancel drops the pending
  selection. With finger drawing on, armed tools draw at once; use Hand to
  tap-select.
- The **selection menu** opens after a tap or a lasso: Color, Width,
  Duplicate, Select note (every stroke of the selected ink blocks), Show
  note (jump to the notes pane) and Delete. Edits apply at once and keep
  pressure and time; a mixed pen/highlighter selection gets a width row per
  kind. Duplicate offsets fresh-id copies by 12 screen pixels and selects
  them; a full group refuses. One action across several blocks is one undo
  entry. The menu follows scrolling and resizing, flips above or below the
  selection and hides while the selection is off-screen. A blank tap or
  Escape dismisses it.
- A **finger drag inside the selection** moves it, even in pen-only mode
  (the dashed box is a `touch-action: none` hit surface; fingers outside it
  scroll). A pen with a writing tool clears the selection and writes. The
  box has a bottom-right **resize** handle and a top-right **rotate**
  handle for mouse, pen and touch: both act around the selection centre,
  preview while dragging and commit one undo entry on release; resize keeps
  proportions and scales the stroke width, rotate does not. Shift snaps
  rotation to 15°; a focused handle takes arrow keys (10% / 15°). The
  handles keep their screen size and follow the live preview. Pressure,
  timing, tilt and stroke ids are untouched.
- **Hover feedback:** a mouse or hovering pen shows the tool's footprint
  around a centre mark. Pen and highlighter widths follow the zoom; the
  eraser radius stays in screen pixels, like the erasure. Tool and menu
  buttons show their description on hover or keyboard focus.
- **Undo / Redo buttons** on the strip step the stroke history; their
  disabled state follows it and resets on leaving the page. Selecting alone
  is not an entry.
- **A stylus draws right away** even with the strip closed (Settings →
  Editor → PDF viewer → Handwriting; on by default), with the last pen
  preset armed on the strip. **Fingers never draw**
  when *Fingers never draw* is on (default on touch screens): they keep
  scrolling and pinch-zooming. The pen's eraser end and barrel button erase.
- Strokes on one page join the **current group** until *New group*, a
  stroke on another page, or leaving the page. A group is one block in the
  notes: a rounded pen marker, the strokes as a picture, and the block's
  text as its caption (children allowed). The marker or the card scrolls
  the PDF to the group and outlines it briefly; a click on ink selects it
  (Show note scrolls the notes to its block), and in read-only views jumps
  to the block directly.
- A group erased empty deletes its block (and comes back on undo).
- Read-only views (workspace viewers, view shares) show ink without tools;
  edit shares draw.

## Model

An ink group is a block with these properties (no schema change):

| key | value |
|---|---|
| `ink_url` | `/api/uploads/<hash>.ink`, the group's stroke file; `""` for the moment between the first stroke and its upload |
| `pdf_page` | 1-based PDF page (the highlight key) |
| `pdf_position` | the group's bounding box in the highlight shape (`{pageNumber, boundingRect: {x1, y1, x2, y2, width, height, pageNumber}, rects: [...]}`), so jump-to-position, markers and the exporters treat ink like any region |
| `ink_strokes` | stroke count |
| `imported_annot` / `annot_stripped` | as on highlights, for ink that came from the PDF's own `/Ink` annotations |

Why a file, not strokes in the properties: a page's tree is sent whole on
open and every property change is an op-log row and a socket message
carrying the full value; a paper's handwriting is hundreds of kB. As an
upload it behaves like a pasted image — the tree carries a URL, the viewer
fetches files per page, and orphan cleanup, share-scoped serving, quota,
the export bundlers and backups understand `/api/uploads/` references in
properties, as well as the native `/api/assets/` family described below.

## Native handwriting blocks and audio replay

The iPad integration is a second representation, not a replacement for the
browser's `gamma-ink` codec or tools. A native `properties.type: "pdf_ink"`
block names a full-SHA256 `.pkdrawing` editable source (`ink_asset`), a PNG
preview (`preview_asset`), and optionally an `.inkjson` per-stroke replay
rendering (`replay_asset`). The source remains Apple's PencilKit data; the
browser does not pretend to edit that binary or convert its preview back
into a drawing. Native geometry uses **unrotated crop-local top-left PDF
points**, unlike the rotation-applied pdf.js viewport used by `gamma-ink`.
`frontend/src/native/inkBlock.js` supplies the placement transform.

Native recordings are `type: "audio"` blocks with finalized M4A segments,
segment-relative stroke/page/note events, and a revision. The audio player's
clock drives replay; stroke sample timestamps in an upstream `.ink` file
are not an audio synchronization timeline. A replay derivative is accepted
only when its `source_sha256` matches the current PencilKit source. Missing
or stale replay data must remain explicit rather than inventing timing.

The native modules live in `frontend/src/native/`, `gamma/native_ink.py`,
`gamma/routers/native_ink.py` and `ipad/`. Browser-issued media URLs carry
`?ws=` (and share context where applicable); server paths and permissions
are workspace-scoped. Native mutations preserve revision/idempotency
checks and enter the upstream page-ops log. Ordinary block writers may
edit text but cannot replace reserved recording/ink manifests. See
[api.md](api.md) for endpoints and retention, [collab.md](collab.md) for
write protection, and `ipad/NATIVE_INTEGRATION.md` for cache and bridge
identity. Recorded verification results and boundaries are in [iPad validation](../../ipad/VALIDATION.md).

## The stroke file (`gamma-ink` v1)

Plain JSON (`application/json`), one per group:

```json
{"format": "gamma-ink", "version": 1,
 "space": {"kind": "pdf-page", "page": 3, "width": 612, "height": 792},
 "strokes": [{"id": "k7Qm2x", "tool": "pen", "color": "#1f1f1f", "size": 1.6,
              "opacity": 1, "pen": true, "t0": 1757760000000,
              "ch": "xypt", "pts": [12040, 30512, 620, 0, 18, -3, 700, 8]}]}
```

- `space`: `page` is 1-based; `width`/`height` the page as displayed at
  scale 1 (pdf.js viewport: points, origin top-left, y down, rotation
  applied) — the same frame highlight rects normalise to and the frame the
  PDF writers map to user space. A `canvas` kind is reserved for ink on
  pages without a PDF (not built yet).
- `ch` names the channels of each sample, InkML-style: `x` `y` always, then
  any of `p` pressure, `t` time, `a` altitude, `z` azimuth. `pts` is one
  flat integer array: x/y in 1/100 pt and t in ms are deltas after the
  first sample, p is 0..1000, a/z degrees. ~300 bytes per stroke.
- `tool`: `pen` (pressure-shaped outline) or `highlighter` (constant width,
  multiplied onto the page). `pen: false` marks mouse/finger strokes (no
  real pressure, drawn even). `size` is the nominal diameter in pt; drawn
  width = `size × (1 + 0.5 × (p − 0.5))` for a real pen. `t0` is wall-clock
  ms of the first sample — a client without timing omits `t`/`t0` rather
  than inventing them.
- Limits (`gamma/ink.py`, enforced on upload): 5 000 strokes, 500 000
  samples, 4 MB, finite numbers, unique stroke ids.

The codec lives twice by design (`ink.py` `decode_stroke`/`encode_points`,
`ink/ink.js` `decodeStroke`/`encodeStroke`); the two test files pin the same
sample bytes.

## Client

- `ink/ink.js` (pure): the codec, bounds (`strokeBounds`, `inkBounds`,
  `boundsOf`, `unionBox`), `pdfPositionOf`, the stroke edits and the
  rendering. `hitStrokes` is the whole-stroke eraser's test; `eraseAt` the
  partial eraser, which re-encodes the surviving runs as new strokes;
  `translateStrokes` only touches the first sample's two absolute integers;
  `transformStrokes` scales/rotates selected XY samples around a shared
  origin without changing the other encoded channels;
  `strokesInLasso` picks strokes with more than half their samples inside
  the polygon. A pen stroke renders as perfect-freehand's outline in one
  filled SVG path (page units; the layer's `viewBox` does the zoom), a
  highlighter as a stroked polyline with `mix-blend-mode: multiply`. Paths
  and decoded samples are cached per stroke object.
  `nearestInkStroke` resolves a touch to the nearest stroke edge (topmost
  stroke wins ties); `restyleStrokes` changes selected color/width, returning
  the original object for a no-op; `duplicateStrokes` preserves original
  samples and channels while assigning unique IDs to translated copies.
- `ink/inkStore.js`: files by URL, and per-block **drafts** — the strokes as
  edited here, ahead of upload. A draft wins over the block's file until
  the upload replaces `ink_url` with the draft's; a remote `ink_url` change
  on a block with nothing unsaved drops the draft.
- `ink/InkLayer.jsx`: `InkLayer` (per `PdfPage`, a sibling of the highlight
  layer) is the retained SVG plus a `desynchronized` canvas for the stroke
  in progress. `InkSelectionMenu` is a portalled `ContextMenu` (its controls
  sit outside the page's pointer listeners) that measures its own height for
  placement; `InkTransformHandles` are the resize/rotate buttons;
  `InkTooltips` shows a button's title on hover or focus for the strip and
  the menu, since native titles are unreliable under Pencil hover. `InkCard`
  is the picture in the notes; `InkToolbar` the strip. Edit callbacks are
  absent on read-only pages and shares.
  - Claiming input: a capture-phase `pointerdown` listener on the page
    wrapper takes the pointer when a tool is armed or a stylus touches the
    page (`pointerType === "pen"` with *Stylus draws right away*), so text
    selection and the area drag never see it. Other pointers pass through.
    Pointer-up encodes the stroke and swallows the click it would deliver to
    whatever lies beneath. Lost capture, `pointercancel` and window blur
    discard the unfinished stroke.
  - Touch: non-passive capture `touchstart`/`touchmove` listeners cancel the
    Pencil's touch gesture on iPad Safari (cancelling the pointer events
    alone does not stop native panning). They match stylus touches, or any
    touch while a pen pointer is down, and leave finger scrolling and pinch
    zoom alone between strokes. The global `html { touch-action:
    manipulation }` (app.css) removes Chrome's double-tap zoom while keeping
    panning and pinch zoom.
  - Palms: while a pen is down, finger touches on that page are swallowed
    and kept from the viewer's pan/pinch handlers. A pen takes over an
    unfinished finger stroke when the palm landed first; a second contact
    never takes over a pen.
  - Samples (`ink/inkInput.js`): `getCoalescedEvents()` where available
    (Safari has none but delivers 120/240 Hz moves), hardware timestamps,
    the pressure preference snapshotted at stroke start, the pointer-up
    position with the last contact pressure (up reports zero), repeated
    points dropped. The live outline gets the same endpoint treatment as
    saved ink, so it reaches the pen tip. With `getPredictedEvents()` the pen
    preview adds at most 16 ms / 12 CSS px of prediction, expiring after
    32 ms and never encoded.
  - Canvas: `shared/lib/canvasSize.js` caps the live bitmap (8 Mi pixels /
    4096 per edge) and the context transform uses the real backing-to-page
    ratio; lift and cancel release the bitmap. Canvas and SVG share the
    dark-page colour filter.
  - Selection: the lasso draws its polygon on the same canvas. A drag inside
    the selection box moves the selected strokes (previewed as a translated
    copy, committed on pointer-up). A pending tap/hold state, separate from
    the drawing, lets a native scroll cancel a touch selection without ink.
- `app/App.jsx` owns the tool state: `inkUi` (`open`, the armed `tool` — a
  preset id, `eraser`, `select` or `null` for the hand — its `options` row,
  and `pen`, the last pen preset, which a stylus writes with when nothing
  is armed) plus the prefs (`inkTools`, the preset list validated by
  `ink/ink.js` `normalizeTools`; the eraser's mode and size; the lasso mode),
  the group the next stroke joins (`inkActiveRef`), the lasso
  selection (`inkSelection`) and the **stroke history** (`inkHistRef`:
  entries of `{changes: [{id, page, before, after}], label}`, one per action; a group whose
  block is gone is re-inserted when an entry brings strokes back). Every
  edit funnels through `applyInk`, which updates the drafts, records the
  entry and schedules `flushInk` (700 ms after the
  last one, and on `pagehide` / `visibilitychange` / leaving the page).
  The flush uploads the draft (`POST /api/upload-ink`) and PATCHes the
  block through `PUT /api/blocks/{id}` — a server-side writer, so the
  change fans out over the page socket and reaches this tree like a remote
  op; only the group's block itself (first stroke) is inserted through the
  tree. An empty group is deleted the same way; its empty draft keeps
  masking the saved strokes until the tree sees the deletion (the HTTP
  response can land before the socket op), and `inkStore.markDeleted` marks
  it clean only after a successful delete, so a failure retries. A failed
  flush (the block's insert may still be queued) retries after two seconds.
- With the strip open, Ctrl+Z is the stroke history (a capture-phase key
  handler, so the page's block undo never sees it); with it closed, Ctrl+Z
  is the page's block history, which knows the group's block but not its
  strokes. Two clients drawing into one group resolve by
  server order on `ink_url` (property-level last writer wins, as every
  property); each keeps a fresh group after *New group*.
  A focused note editor keeps the block history even with the strip open,
  and other text inputs keep their own undo; an empty ink history never
  falls through to block undo. Undo and redo report the action and PDF page
  in the status pill (“Undone: ink width change (page 1).”); the labels
  distinguish drawing, erasure, partial erasure, move, colour, width,
  duplicate and delete.

## Server

- `gamma/ink.py`: the pydantic schema and limits, the codec, `read_upload`
  (the parsed file behind a block's `ink_url`, None when unreadable — the
  exporters' one loader),
  `stroke_polyline` (variable-width polylines every renderer draws from),
  `bounding_box` / `pdf_position`, `to_svg`, `pdf_path_ops` (content-stream
  operators for the notes-as-PDF writer), `ink_buckets` and `from_pdf_ink`
  for the `/Ink` interchange, `dumps` (canonical bytes: sorted keys, so the
  same strokes dedup to one upload).
- `POST /api/upload-ink` (`routers/ink.py`): the file as the JSON body,
  validated, stored as `<hash>.ink` with the usual quota check →
  `{url, size, strokes, bbox, pdf_position, already_existed}`. Editors and
  edit shares (`require_ws_writer`). `.ink` is in `storage.FILE_MEDIA_TYPES`
  (`application/json`), so `GET /api/uploads/<hash>.ink` is the ordinary
  upload route with its share scoping and cache headers.
- Interchange ([import_export.md](import_export.md)): the annotated PDF
  writes one `/Ink` per look bucket (colour × tool × size × opacity) with
  `/InkList` in user space, the mean drawn width as `/BS /W`, the note on
  the first, an `/NM` for Zotero, and a private `/GammaInk` key carrying the
  bucket's strokes so a Gamma re-import keeps pressure and time; the
  embedded-annotation importer reads `/Ink` (Gamma's or anyone's) into ink
  blocks and strips them like the other types; the Markdown export writes
  `![Handwriting (p.N)](assets/<hash>.svg)` with the SVG generated into the
  zip; the notes-as-PDF document draws the strokes as vectors under a
  "handwriting, p. N" line. The agent's `read_block` outline labels an ink
  block "handwriting on p. N, K strokes" before its caption.

## Not built yet

Shape tools, reordering presets
by drag, syncing the preset row across devices (it is per browser),
ballpoint / fountain / dashed pen styles, a `canvas` space for ink blocks
on pages without a PDF, Xournal++ `.xopp` import, *Transcribe with AI*,
live co-drawing over presence, audio replay (the per-sample `t` and stroke
ids are stored for it). Obsidian vault export writes an ink block's
caption only. The Notability comparison in the research note lists what a
closer pen experience still needs (draw-and-hold straightening, an eraser
that returns to the last tool, the highlighter behind the ink, clipboard
operations). The broader interaction survey is
[handwriting-interactions.md](../research/handwriting-interactions.md).
