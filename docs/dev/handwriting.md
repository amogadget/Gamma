# Handwriting (ink) annotations

Status: proposed, 2026-09-13. Nothing below is implemented. The survey that
led here, including what the upstream fork's iPad implementation did and why
most of it is not copied, is [research/handwriting.md](../research/handwriting.md).

## Goal

Draw with a stylus (or mouse/finger) on a PDF page, in the browser, on every
platform Gamma already runs on: desktop browsers and the Electron app with
Wacom/Surface/Huion pens, Android Chrome, Safari on iPad with Apple Pencil.
One implementation, one open vector format, no native client. Ink follows
the same rules as highlights: it is a block in the page's tree, it changes
through ops, it exports to a standard PDF annotation, it never rewrites the
PDF.

## Model

**An ink group is a block.** One block holds the strokes drawn in one
sitting on one PDF page (a derivation in a margin, a circled figure, a
paragraph of handwriting). Strokes are drawing data inside the group, not
blocks. The group's `content` is its caption or transcription, so search
(`block_fts`), AI context and Markdown export see text; it can have
children like any block. The user starts a new group explicitly (the
toolbar's *New group*) or implicitly when drawing on a different page than
the active group's; otherwise strokes join the active group.

Block properties of an ink group (no new columns, no migration):

| key | value |
|---|---|
| `ink_url` | `/api/uploads/<sha256>.ink`, the group's stroke file (below) |
| `pdf_page` | 1-based PDF page, same key highlights use |
| `pdf_position` | `{pageNumber, boundingRect: {x1, y1, x2, y2, width, height, pageNumber}, rects: []}`, the group's bounding box in the highlight convention, so the existing jump-to-position, marker and export anchoring code works unchanged |
| `ink_strokes` | stroke count (card label, cheap "is it empty" check) |
| `imported_annot` / `annot_stripped` | same meaning as on highlights, for ink that came from a PDF's own `/Ink` annotations |

Why a file and not the strokes inline in `properties`: a page's tree is sent
whole on open and every property change is one op-log row and one socket
message carrying the full value. A heavily annotated paper holds thousands
of strokes (hundreds of kB even delta-encoded); inline, that rides along
with every tree load and every commit and bloats `page_ops`. As a
content-addressed upload it behaves exactly like a pasted image: the tree
carries a URL, the viewer fetches files for visible pages, orphan cleanup,
share-scoped serving, export bundling and quota already understand
`/api/uploads/<hash>.<ext>` references in properties, and identical content
dedups. The cost is one upload per commit (debounced) and a small cache rule
for undo (below).

**Ink is not tied to PDF pages.** The file's `space` says what the
coordinates mean. `pdf-page` is the only kind in the first release; a
`canvas` kind (an ink block that is a drawing area inside the notes of any
page, no attachment) reuses the whole pipeline later and is the
block-centric follow-up ([block_centric.md](block_centric.md)).

## The stroke file (`gamma-ink`, version 1)

Plain JSON, stored as `uploads/<sha256>.ink`, served as `application/json`.
Deliberately small and greppable; numbers are integers where a fixed unit
makes that lossless.

```json
{
  "format": "gamma-ink", "version": 1,
  "space": {"kind": "pdf-page", "page": 3, "width": 612, "height": 792},
  "strokes": [
    {
      "id": "k7Qm2x",
      "tool": "pen",
      "color": "#1f1f1f",
      "size": 1.6,
      "opacity": 1,
      "pen": true,
      "t0": 1757760000000,
      "ch": "xypt",
      "pts": [12040, 30512, 62, 0,  18, -3, 70, 8,  22, 1, 74, 9]
    }
  ]
}
```

- `space` for `pdf-page`: `page` is 1-based; `width`/`height` are the page's
  size as displayed at scale 1 (pdf.js `getViewport({scale: 1})`, points,
  rotation applied, origin top-left, y down). This is the *same frame* the
  highlight rects normalise to and the frame `pdf_notes._frame` /
  `pdf_export._viewer_rect_to_pdf` already map into PDF user space. If a
  reader finds a different page size (attachment replaced), it scales
  proportionally, as `_anchor_rect` does for highlights.
- `ch` declares the channels of each sample, InkML-style: `x` `y` always,
  `p` pressure, `t` time, optionally `a` altitude and `z` azimuth (tilt).
  `pts` is one flat integer array, `len(ch)` values per sample:
  - `x`, `y` in 1/100 pt, **delta-encoded** after the first sample (the
    first sample is absolute);
  - `p` in 0..1000 (`pressure * 1000`);
  - `t` in ms since `t0`, delta-encoded;
  - `a`, `z` in degrees, absolute.
  Typical stroke: ~30 samples × 4 channels of 1–3 digit ints, ~300 B.
- `tool`: `pen` (pressure-shaped outline), `highlighter` (constant width,
  `opacity` ≤ 0.5, drawn with multiply blend), `line`/`rect`/`ellipse`
  later (a `shape` stroke stores its two anchors in `pts`). Erasing removes
  or splits strokes; there is no eraser stroke.
- `size` is the nominal diameter in pt at scale 1; `pen: false` means the
  points came from a mouse/finger and pressure is simulated at render time
  (Excalidraw's `simulatePressure`, tldraw's `isPen`).
- `id` is a short random id, stable for the stroke's life, so a later
  audio-replay feature or a selection can name strokes. `t0` is wall-clock
  ms of the first sample; a client that did not record time omits `t` and
  `t0` rather than inventing them.

Limits enforced on upload: 5 000 strokes, 500 000 samples, 4 MB per file;
finite numbers; `page ≥ 1`; `ch` must contain `x` and `y` and `pts` length
must be a multiple of `len(ch)`.

Interchange: **PDF `/Ink`** out and in (every PDF app), **SVG** out
(Markdown export, previews), **Xournal++ `.xopp`** in (later stage). The
`.ink` file itself is what a Gamma-to-Gamma export carries.

## Rendering

- Per `PdfPage`, one `<svg class="inkLayer">` sibling of the highlight
  layer, `width/height` = scale-1 page size, `transform: scale(scale)` with
  `transform-origin: 0 0` (the text layer's trick), `pointer-events: none`
  unless a tool is armed. One `<path>` per stroke: perfect-freehand's
  outline of the decoded samples, computed once per stroke in page units
  and memoised by stroke id (zoom is a CSS transform, never a recompute).
  Highlighter strokes are a stroked polyline with `mix-blend-mode:
  multiply`. Dark-page mode (`gamma-pdf-dark`) inverts ink colour the way it
  flips the canvas.
- The in-progress stroke draws on a per-page `<canvas>` overlay created on
  pointer-down (`getContext("2d", {desynchronized: true})`) and moves to the
  SVG on pointer-up. Predicted events (Chromium) extend the canvas preview
  only.
- Ink files are fetched lazily for pages that become visible (the same
  IntersectionObserver that triggers page render), cached by URL in a
  module-level `Map` for the document's life. The cache is also the undo
  safety net: `blockHistory` restores a previous `ink_url`, and the
  client re-uploads the cached content for that URL before applying the op
  (content-addressed, so the server either already has it or gets the same
  bytes back). Orphan cleanup's 15-minute grace covers the normal case; the
  re-upload covers undo after a long pause.
- Notes tree: an ink block row renders an `InkCard` (the strokes as an
  inline SVG cropped to the bounding box, capped height, rendered from the
  same cached file) above the block's editable content, with a rounded-square
  pen marker in the dot slot instead of a highlight dot. Clicking the marker
  or card scrolls the viewer to `pdf_position` and flashes the group's box
  for ~1.8 s (adopted from upstream). The ⋮⋮ menu gains *Transcribe with
  AI* later (stage 4).

## Input

- Pointer Events only. Pointer-down on a page with a tool armed (or, on a
  touch device with *Pen starts drawing* on, any `pointerType === "pen"`
  even with no tool armed, Notability-style) captures the pointer and
  starts a stroke; `pointermove` appends samples (`getCoalescedEvents()`
  where present, else the raw event); `pointerup`/`pointercancel` commits.
  `buttons & 32` (eraser end) erases; the barrel button (`buttons & 2`)
  erases while held.
- Palm rejection: while a pen pointer is active, touch pointers are ignored
  on the ink layer; with *Pen-only input* on (default on touch devices),
  fingers never draw and keep scrolling and pinch-zoom. `touch-action:
  none` is set on the ink layer only while a tool is armed, so the viewer's
  own pinch gesture keeps working otherwise.
- Coordinates: `(clientX - pageRect.left) / scale` gives scale-1 page
  units directly, because the displayed page is the canonical frame.
- Eraser: stroke-level first (hit test = distance from the pointer to any
  segment ≤ half the stroke's size + tolerance, with a bounding-box
  pre-check); point-level splitting is stage 3.
- Group assignment: the active group per document session is the last
  group drawn into; a stroke on another page, or *New group*, or an idle
  gap above the *New group after* preference (default 10 min) starts a new
  block. A new block is inserted through the same path as a highlight
  (`addHighlightAsBlock`'s sibling for ink, appended at the top level with
  the client-minted id and position).
- Commit = debounce (800 ms after the last pointer-up, and immediately on
  tool change, group switch, page hide, or `visibilitychange`): encode the
  group, `POST /api/upload-ink`, then one `set` op patching `ink_url`,
  `pdf_position`, `ink_strokes`. Two clients drawing into the *same* group
  at once resolve by the server's op order (property-level last writer
  wins, the rule every other property already has); a client that sees a
  remote `ink_url` change while it has uncommitted strokes rebases them
  onto the new file (append, re-upload). Live "watch the other person's pen
  move" is not in scope; presence could carry it later.

Toolbar: a pen button next to the area-note toggle in the PDF toolbar opens
the ink tools: pen / highlighter / eraser, the shared `COLORS` swatches plus
black, three sizes, *New group*, *Done*. Keyboard `P` arms the pen, `E` the
eraser, `Esc` disarms. Settings → Editor → PDF viewer gains a *Handwriting*
section built from the settingsKit primitives: pen-only input, pen starts
drawing automatically, pressure on/off, default sizes, new-group idle gap.
All of it is in `prefs.js`, none of it synced (device-specific).

Read-only cases: a workspace viewer and a view share get the layer with no
tools; an edit share draws like an editor. The upload endpoint accepts an
edit share through `require_ws_writer` exactly like the block writers.

## Backend

New module `gamma/ink.py` (pure, no FastAPI):

- `InkFile` pydantic schema for `gamma-ink` v1 with the limits above;
  `parse_ink(bytes)`, `decode_stroke(stroke)` → list of `(x, y, p, t)` in
  points; `bounding_box(ink)`.
- `stroke_segments(stroke)` → polyline segments with per-segment width
  (size × pressure), the one renderer both PDF writers and the SVG exporter
  draw from (Xournal++'s model: variable-width polylines, no outline
  algorithm to port).
- `to_pdf_ink(ink, page, crop, rotation, note, block_id)` → `/Ink`
  annotation dicts for `pdf_export.annotate_pdf` (one per stroke: `/InkList`
  in user space through the existing `_viewer_rect_to_pdf` frame maths,
  `/BS /W` = size × mean pressure, `/C`, `/CA`, `/Contents`, `/NM` from the
  block id, plus a private `/GammaInk` string holding the stroke's own JSON
  so a Gamma re-import restores pressure and time).
- `from_pdf_ink(annots)` → one `InkFile` per `/Ink` annotation for the
  embedded-annotation importer.
- `to_svg(ink, bbox)` for Markdown export and server-side previews.

Endpoints (`gamma/routers/ink.py`, registered like `uploads`):

- `POST /api/upload-ink` (multipart or raw JSON body): `require_ws_writer`,
  validates with `InkFile`, stores through `storage` as `<sha256>.ink` with
  the same quota check as images, returns `{url, size, strokes}`.
- `GET /api/uploads/<sha>.ink` is the existing upload route once `.ink`
  is in `storage.FILE_MEDIA_TYPES` (`application/json`, download
  disposition like the other non-image types; `fetch` does not care). The
  share-scope check and the month-long cache header apply unchanged.

Everything else is existing machinery: the block is created and patched
through `apply_ops`, the op log and the page socket fan the change out,
`cleanup_orphan_uploads` frees replaced files after the grace period, the
Gamma export bundles `.ink` files because it scans properties for
`/api/uploads/`, backups copy `uploads/`.

Export and import (`routers/export.py`, `routers/imports.py`,
[import_export.md](import_export.md)):

- Annotated PDF: `_collect_marks` gets a sibling `_collect_ink` (skips
  ink still embedded in the file, same rule as highlights); `annotate_pdf`
  takes `ink=` and writes `/Ink`. Zotero 7 imports these as ink annotations.
- Notes as PDF: ink groups typeset as their SVG-equivalent vector drawing
  in the note flow (segments → path ops in `pdf_notes`), caption below.
- Markdown export: `![caption](assets/<sha>.svg)` generated by `to_svg`,
  with the `.ink` file bundled beside it.
- Embedded-annotation import: `/Ink` joins `_IMPORT_TYPES`; each becomes an
  ink block with `imported_annot` and, when stripping, `annot_stripped`.
  A `/GammaInk` private key wins over `/InkList` when present.
- Logseq graph export: ink groups export as their caption plus the SVG
  asset (Logseq has no ink type).
- Xournal++ import (stage 4): `.xopp` upload → the PDF background is
  matched to a page by content hash or attached, `<stroke>` elements become
  groups per layer and page, per-point widths become pressure
  (`width_i / width_0`).

AI: `ai_tools.read_page` describes an ink block as "handwritten note, N
strokes, PDF page P" plus its caption; a *Transcribe* action (stage 4)
renders the group to PNG client-side and asks the configured vision-capable
provider through the existing `/api/ai/chat` to fill the caption.

## Stages

Each stage leaves the app working; nothing changes stored shapes, so no
migration step at any stage.

1. **Format + server.** `gamma/ink.py` (schema, decode, segments, bbox),
   `POST /api/upload-ink`, `.ink` in the media-type table, tests
   (`tests/test_ink.py`: schema limits, delta round-trip, upload + serve +
   share scope, orphan cleanup keeps a referenced `.ink`).
2. **Draw and view.** `frontend/src/ink.js` (pure: encode/decode, bbox,
   hit test, group bookkeeping), `frontend/src/features/pdf/InkLayer.jsx`
   (retained SVG + in-progress canvas), `InkToolbar.jsx`, the ink block card
   and marker in `blockTree.jsx`, prefs, jump + flash, read-only gating.
   Ship pen + highlighter + stroke eraser + colours + sizes + groups.
   Verify with the `verify` skill on desktop; hand-test iPad Safari and
   Android Chrome (pressure, palm rejection, pinch still works).
3. **Interchange.** `/Ink` export in the annotated PDF (check in Zotero 7
   and Acrobat), notes-as-PDF drawing, SVG in Markdown export, `/Ink`
   import with strip. Docs: `api.md`, `import_export.md`, this file's
   status line.
4. **Polish and reach.** Point-level eraser (split strokes), lasso select
   + move/delete of strokes, shape tools, undo re-upload path exercised,
   predicted events, *Transcribe with AI*, `.xopp` import, `canvas` space
   for ink blocks on pages without a PDF.

Out of scope, kept possible by the format: audio recording with
stroke-synchronised replay (per-sample `t` and stroke ids are stored for
it), live co-drawing over presence, a native client writing the same
`.ink` files.

## Open decisions

- Whether *Pen starts drawing automatically* should default on for touch
  devices (Notability behaviour) or off (safer against accidental marks
  while navigating). Proposal: on, since a pen pointer with no tool armed
  is almost always intent to write.
- Highlighter over text: free-hand only (this plan) or also snap-to-line
  like the text highlighter. Free-hand first; snapping is a text-selection
  feature, not an ink one.
- Whether an ink group should be *movable* (drag the whole group on the
  page). Cheap once lasso exists (stage 4); until then groups are fixed.
