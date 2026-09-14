# Handwriting (ink) annotations

Draw on a PDF page with a stylus, mouse or finger; the strokes become a
block in the page's notes. Implemented 2026-09-14; the survey and the
reasons behind the shape are in
[research/handwriting.md](../research/handwriting.md). Code:
`gamma/ink.py` + `gamma/routers/ink.py` (server), `frontend/src/ink.js`,
`inkStore.js`, `inkLayer.jsx` (client), tests `backend/tests/test_ink.py`,
`frontend/tests/ink.test.mjs`, e2e `tests/e2e/scenarios/ink.mjs`.

## What the user sees

- The pen button in the viewer's zoom column opens the **tool strip** at
  the top of the page: pen / highlighter / eraser / lasso, colours, S/M/L,
  *New group* (+), close. Keys while it is open: `P` `H` `E` `L`, `Esc`,
  `Delete` (the lasso selection), and **`Ctrl+Z` / `Ctrl+Shift+Z` step the
  strokes** (each stroke, erasure, move or delete is one entry; the history
  is per visit of the page). Opening the strip arms the pen.
- The **eraser** has two modes on the strip (two icons next to it): *whole
  strokes* removes anything it touches, *partial* cuts through them (the pieces on either side become their own
  strokes; one pass is one undo entry). The **lasso** circles strokes (more
  than half their samples inside); the dashed box then moves by dragging
  and deletes with `Delete`. Both work across groups on the page.
- **A stylus draws right away** even with the strip closed (Settings →
  Editor → PDF viewer → Handwriting; on by default). **Fingers never draw**
  when *Fingers never draw* is on (default on touch screens): they keep
  scrolling and pinch-zooming. The pen's eraser end and barrel button erase.
- Strokes on one page join the **current group** until *New group*, a
  stroke on another page, or leaving the page. A group is one block in the
  notes: a rounded pen marker, the strokes as a picture, and the block's
  text as its caption (children allowed). The marker or the card scrolls
  the PDF to the group and outlines it briefly; clicking ink on the page
  scrolls the notes to its block.
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

- `ink.js` (pure): codec, bounds, `pdfPositionOf`, the stroke edits
  (`hitStrokes` / `eraseAt` — the partial eraser re-encodes the surviving
  runs as new strokes — `translateStrokes`, which only touches the first
  sample's two absolute integers, `strokesInLasso`, `boundsOf`), and
  rendering — a pen stroke is perfect-freehand's outline as one filled
  SVG path (page units; the layer's `viewBox` does the zoom), a highlighter
  a stroked polyline with `mix-blend-mode: multiply`. Paths and decoded
  samples are cached per stroke object.
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
  delivers 120/240 Hz moves). Pointer-up encodes the stroke and swallows
  the click it would deliver to whatever lies beneath. The lasso tool
  draws its polygon on the same canvas; a drag inside the selection box
  moves the selected strokes (previewed as a translated copy, committed on
  pointer-up). `InkCard` is the picture in the notes; `InkToolbar` the
  strip.
- `App.jsx` owns the tool state (`inkUi`, the S/M/L + colour + eraser-mode
  prefs), the group the next stroke joins (`inkActiveRef`), the lasso
  selection (`inkSelection`) and the **stroke history** (`inkHistRef`:
  entries of `[{id, page, before, after}]`, one per action; a group whose
  block is gone is re-inserted when an entry brings strokes back). Every
  edit funnels through `applyInk`, which updates the drafts, records the
  entry and schedules `flushInk` (700 ms after the
  last one, and on `pagehide` / `visibilitychange` / leaving the page).
  The flush uploads the draft (`POST /api/upload-ink`) and PATCHes the
  block through `PUT /api/blocks/{id}` — a server-side writer, so the
  change fans out over the page socket and reaches this tree like a remote
  op; only the group's block itself (first stroke) is inserted through the
  tree. An empty group is deleted the same way. A 404 (the insert still
  queued) retries after two seconds.
- With the strip open, Ctrl+Z is the stroke history (a capture-phase key
  handler, so the page's block undo never sees it); with it closed, Ctrl+Z
  is the page's block history, which knows the group's block but not its
  strokes. Two clients drawing into one group resolve by
  server order on `ink_url` (property-level last writer wins, as every
  property); each keeps a fresh group after *New group*.

## Server

- `gamma/ink.py`: the pydantic schema and limits, the codec,
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
  "handwriting, p. N" line. `ai_tools.read_page` labels ink blocks.

## Not built yet

Shape tools, resizing or rotating a lasso selection, a `canvas` space for ink blocks on pages without a PDF, Xournal++ `.xopp`
import, *Transcribe with AI*, live co-drawing over presence, audio replay
(the per-sample `t` and stroke ids are stored for it). Obsidian vault
export writes an ink block's caption only.
