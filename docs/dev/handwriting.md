# Handwriting (ink) annotations

Draw on a PDF page with a stylus, mouse or finger; the strokes become a
block in the page's notes. The survey behind the shape, and how Notability
does the same things, is in
[research/handwriting.md](../research/handwriting.md). Code:
`gamma/ink.py` + `gamma/routers/ink.py` (server), `frontend/src/ink.js`,
`inkStore.js`, `inkLayer.jsx`, `inkInput.js` (client), tests `backend/tests/test_ink.py`,
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
- **Tap existing ink to edit it.** With *Fingers never draw* enabled, a
  finger tap (or a 450 ms stationary hold) selects the nearest stroke,
  including thin ink within a 10 CSS px hit tolerance. Mouse clicks in
  Hand mode and short taps with Lasso also select. A swipe still scrolls;
  movement beyond 8 CSS px, a second contact, a pen contact or cancellation
  clears a pending touch selection. Finger-drawing mode keeps armed writing
  tools immediate; use Hand to tap-select in that mode.
- The **selection menu** appears after direct selection or a lasso:
  Color, Width, Duplicate, Delete, Select note (all strokes in the selected
  ink blocks), Show note (jump to the notes pane), and Done. Color/width
  edit existing strokes and preserve pressure/time. Mixed pen/highlighter
  selections have separate width choices. Duplicate offsets fresh-ID copies
  by 12 screen pixels and selects them; a full group rejects duplication
  without dropping original strokes. One action across several blocks is
  one undo entry. The menu follows scrolling/resizing, flips above/below the
  selection and hides when that selection leaves the visible PDF area.
- Drag inside a selection with a **finger**, even in pen-only mode, to move
  it. That bounded hit surface reserves touch gestures for moving; fingers
  outside it navigate. A pen using a writing tool clears the selection and
  writes immediately. Blank taps and Done dismiss the selection.
- **Undo and Redo buttons** on the handwriting strip expose stroke history
  without a keyboard. Their disabled state follows the history and resets
  on leaving the page. Selection alone does not create an undo entry.
- **A stylus draws right away** even with the strip closed (Settings →
  Editor → PDF viewer → Handwriting; on by default), with the last pen
  preset armed on the strip. **Fingers never draw**
  when *Fingers never draw* is on (default on touch screens): they keep
  scrolling and pinch-zooming. The pen's eraser end and barrel button erase.
- Strokes on one page join the **current group** until *New group*, a
  stroke on another page, or leaving the page. A group is one block in the
  notes: a rounded pen marker, the strokes as a picture, and the block's
  text as its caption (children allowed). The marker or the card scrolls
  the PDF to the group and outlines it briefly; clicking ink on the page
  selects it for editing; Show note scrolls the notes to its block. Read-only
  ink retains direct click-to-note navigation.
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
the export bundlers and backups already understand `/api/uploads/`
references in properties.

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
`ink.js` `decodeStroke`/`encodeStroke`); the two test files pin the same
sample bytes.

## Client

- `ink.js` (pure): the codec, bounds (`strokeBounds`, `inkBounds`,
  `boundsOf`, `unionBox`), `pdfPositionOf`, the stroke edits and the
  rendering. `hitStrokes` is the whole-stroke eraser's test; `eraseAt` the
  partial eraser, which re-encodes the surviving runs as new strokes;
  `translateStrokes` only touches the first sample's two absolute integers;
  `strokesInLasso` picks strokes with more than half their samples inside
  the polygon. A pen stroke renders as perfect-freehand's outline in one
  filled SVG path (page units; the layer's `viewBox` does the zoom), a
  highlighter as a stroked polyline with `mix-blend-mode: multiply`. Paths
  and decoded samples are cached per stroke object.
  `nearestInkStroke` resolves a touch to the nearest stroke edge (topmost
  stroke wins ties); `restyleStrokes` changes selected color/width, returning
  the original object for a no-op; `duplicateStrokes` preserves original
  samples and channels while assigning unique IDs to translated copies.
- `inkStore.js`: files by URL, and per-block **drafts** — the strokes as
  edited here, ahead of upload. A draft wins over the block's file until
  the upload replaces `ink_url` with the draft's; a remote `ink_url` change
  on a block with nothing unsaved drops the draft.
- `inkLayer.jsx`: `InkLayer` (per `PdfPage`, a sibling of the highlight
  layer): the retained SVG, a `desynchronized` canvas for the stroke in
  progress, and a capture-phase `pointerdown` listener on the page wrapper
  that claims the pointer when a tool is armed or a stylus touches the page
  (`pointerType === "pen"` with *Stylus draws right away*), so text
  selection and the area drag never see it; other pointers pass through
  untouched. `getCoalescedEvents()` where available (Safari has none but
  delivers 120/240 Hz moves). Non-passive capture listeners cancel Pencil
  `touchstart`/`touchmove` events on iPad Safari: cancelling pointer events
  alone does not prevent native panning. They recognize stylus touches
  (or an active pen pointer when touch type is unavailable), while direct
  finger touches retain scrolling and pinch zoom between strokes. While a
  pen is down, direct touches on that page are suppressed as palms, including
  their propagation to the viewer's pan/pinch handlers. A pen can replace
  an unfinished finger stroke if the palm landed first; a second contact
  cannot replace an active pen. Lost capture, pointer cancellation and window
  blur discard the unfinished stroke and clear its preview.
  `inkInput.js` keeps the hardware event timestamps (including coalesced
  samples), snapshots the pressure preference at stroke start, and includes
  the final pointer-up position using the last contact pressure. Duplicate
  positions with unchanged pressure are omitted. The live outline uses the
  same endpoint treatment as saved ink so it reaches the pen tip. Where
  `getPredictedEvents()` is available, pen previews include at most 16 ms /
  12 CSS px of prediction; these samples expire after 32 ms and are never
  encoded or uploaded. Browsers without prediction use measured samples.
  Both canvas and SVG use the same dark-page colour filter.
  `canvasSize.js` caps the live bitmap to 8 Mi pixels / 4096 per edge, using
  the actual backing-to-page ratio for drawing at high zoom. Lift/cancel
  releases the bitmap; saved SVG stroke geometry remains full precision.
  Pointer-up encodes the stroke and swallows
  the click it would deliver to whatever lies beneath. The lasso tool
  draws its polygon on the same canvas; a drag inside the selection box
  moves the selected strokes (previewed as a translated copy, committed on
  pointer-up). `InkCard` is the picture in the notes; `InkToolbar` the
  strip. A separate pending tap/hold state lets native touch scrolling
  cancel selection without drawing ink. A selected region has a transparent
  `touch-action: none` hit surface for finger movement. `InkSelectionMenu`
  uses the shared portalled `ContextMenu`, keeps controls outside the native
  page pointer listeners, and measures its height for placement. Its actions
  and Undo/Redo use icon buttons with accessible names and tooltips; width
  choices preview thickness as dots. Global `html { touch-action: manipulation }`
  suppresses Chrome double-tap zoom on all layouts while preserving panning
  and pinch zoom ([Chrome guidance](https://developer.chrome.com/blog/300ms-tap-delay-gone-away)). Edit
  callbacks are absent for read-only pages/shares.
- `App.jsx` owns the tool state: `inkUi` (`open`, the armed `tool` — a
  preset id, `eraser`, `select` or `null` for the hand — its `options` row,
  and `pen`, the last pen preset, which a stylus writes with when nothing
  is armed) plus the prefs (`inkTools`, the preset list validated by
  `ink.js` `normalizeTools`; the eraser's mode and size; the lasso mode),
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
  tree. An empty group is deleted the same way. Its empty draft keeps masking
  the saved strokes during deletion, including the gap between the HTTP
  response and the socket update. Only a successful delete marks that draft
  clean; failures keep it dirty for retry. A failed flush (the block's
  insert may still be queued) retries after two seconds.
- With the strip open, Ctrl+Z is the stroke history (a capture-phase key
  handler, so the page's block undo never sees it); with it closed, Ctrl+Z
  is the page's block history, which knows the group's block but not its
  strokes. Two clients drawing into one group resolve by
  server order on `ink_url` (property-level last writer wins, as every
  property); each keeps a fresh group after *New group*.
  Focused note editors still use block history even with the strip open;
  other text inputs retain their own undo. Empty ink history never falls
  through to block undo. Keyboard and toolbar undo/redo report the action
  and PDF page, e.g. “Undone: ink width change (page 1).” Labels distinguish
  drawing, erasure/partial erasure, move, color/width, duplicate and delete.

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

Shape tools, resizing or rotating a lasso selection, reordering presets
by drag, syncing the preset row across devices (it is per browser),
ballpoint / fountain / dashed pen styles, a `canvas` space for ink blocks
on pages without a PDF, Xournal++ `.xopp` import, *Transcribe with AI*,
live co-drawing over presence, audio replay (the per-sample `t` and stroke
ids are stored for it). Obsidian vault export writes an ink block's
caption only. The Notability comparison in the research note lists what a
closer pen experience still needs (draw-and-hold straightening, an eraser
that returns to the last tool, the highlighter behind the ink, clipboard
operations and selection transforms). The broader interaction survey is
[handwriting-interactions.md](../research/handwriting-interactions.md).
