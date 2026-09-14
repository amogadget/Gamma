# Handwriting (ink) annotation: formats, input, and what the fork did

Survey from 2026-09-13, before the handwriting feature described in
[dev/handwriting.md](../dev/handwriting.md) was designed. Three questions:
which ink formats exist and which are worth speaking, what stylus input the
browser gives on each platform, and what the upstream fork's iPad-based
implementation taught. Findings only; the chosen mechanics live in the dev
doc.

## Ink formats in the wild

| Format | Who writes it | Shape | Pressure / tilt / time | Verdict for Gamma |
|---|---|---|---|---|
| **InkML** (W3C Recommendation, 2011) | Handwriting-recognition toolchains, some Microsoft/Samsung pipelines; no consumer note app | XML: `<trace>` = one stroke as a list of samples; `<traceFormat>` declares the *channels* per sample (`X Y F T`, tilt `OTx OTy`, colour, width); `<brush>`, `<context>`, `<traceGroup>` | All, as declared channels | Nothing produces or consumes it in a workflow Gamma's users have. Its one durable idea, "a stroke is samples over declared channels", is copied into the Gamma schema. Not an interchange target. |
| **Xournal++ `.xopp`** | Xournal++ (Linux/Windows/macOS), the open-source PDF annotator people actually use with pen tablets | gzipped XML document: pages with a `<background type="pdf" filename= page=>`, `<layer>`s, `<stroke tool= color="#RRGGBBAA" width="w0 w1 w2 …">x y x y …</stroke>`; pressure is stored as *per-point widths* (first value = base width), `capStyle`, dash `style`, `fill`, audio `ts`/`fn` | Pressure as widths; time only as an audio offset | Worth an **importer** (people migrate from it, and it is the only open document-level format with a PDF background). Not a storage model: it is a whole notebook, not a block. |
| **PDF `/Ink` annotation** (ISO 32000) | Every PDF app: Acrobat, PDF Expert, Xournal++ export, Zotero 7's reader (ink tool + import), GoodNotes/Notability when exporting with annotations | `/InkList [[x y x y …] …]` polylines in PDF user space, `/BS /W` constant width, `/C` colour, `/CA` opacity, `/Contents` note; private keys allowed | None (constant width) | **The interchange format.** Export to it (Gamma already writes `/Highlight` and `/Square`), import from it. Pressure is lost unless the writer stashes its own data in a private key. |
| **tldraw draw shape** | tldraw SDK, Logseq whiteboards | JSON record: `segments[{type: free|straight, path: delta-encoded base64 of (x,y,z)}]`, `isPen`, `isClosed`, style enums (`color`, `size`, `dash`, `fill`), `scale` | z = pressure; no time | Good engineering reference: compact delta encoding, a "real pen vs simulated pressure" flag, record-level collaboration (property LWW) that matches Gamma's op model. Its style enums are tldraw's; not a file people exchange. |
| **Excalidraw `freedraw` element** | Excalidraw, the Obsidian Excalidraw plugin | JSON element: `points[[x,y]]`, `pressures[]`, `simulatePressure`, `strokeOptions{variability, streamline}`, `strokeColor`, `strokeWidth`, `opacity` | Pressure; no time | Same lesson as tldraw: keep raw points + pressure, render with perfect-freehand, never store the outline. Whole-scene file, not a target. |
| **reMarkable `.rm` v6** | reMarkable tablets; parsers `rmscene`, `rmc` | Binary CRDT scene tree; `Line{tool, color, thickness_scale, points[{x, y, speed, direction, width, pressure}]}`, 24 pen variants | Pressure, tilt-derived width, speed | Niche importer at most (via `rmscene`). Shows what a *rich* per-point channel set looks like when a device owns the pen. |
| **Apple PencilKit `PKDrawing`** | iPadOS apps | Opaque "Apple Drawing Format" bytes; the API exposes `PKStroke{path: [PKStrokePoint{location, timeOffset, size, opacity, force, azimuth, altitude}], ink, transform}` but the serialisation is undocumented and version-gated (iOS 17 inks fail to decode on older OS) | All, but only inside Apple code | Never as a source of truth: cannot be read on the server, in a browser, or on any other device. The fork's whole derived-asset pipeline (PNG previews, per-stroke PNGs) exists only because of this. |
| MyScript JIIX, OneNote, Notability, GoodNotes | Proprietary | JSON (JIIX) or closed | n/a | No public reader; ignore. |

**Conclusion.** No open format is both a good *storage* unit for a block and
something other software exchanges. The two roles split cleanly: store raw
samples in Gamma's own small JSON schema (borrowing InkML's channel idea and
Excalidraw/tldraw's raw-points-plus-pressure rule), and exchange through PDF
`/Ink` (universal), SVG (rendering), and a `.xopp` importer (migration).

## Rendering pressure strokes

**perfect-freehand** (MIT, ~2 kB, by tldraw's author) turns `[x, y, pressure]`
samples into a closed outline polygon; options `size`, `thinning`,
`smoothing`, `streamline`, `simulatePressure`, start/end taper. Excalidraw,
tldraw and most web ink apps use it. Its README's rule is the storage rule:
*store input points, never the outline*, so strokes stay editable and the
renderer can improve. The outline is one SVG `<path>` (or a canvas `Path2D`)
per stroke; page-unit coordinates plus a CSS `transform: scale()` make zoom
free, exactly how pdf.js's text layer is scaled in Gamma's viewer already.

pdf.js ships its own `InkEditor` (`AnnotationEditorType.INK`), but it lives
inside pdf.js's `PDFViewer` / annotation-editor layer, which Gamma's custom
viewer does not use; its serialisation targets `/Ink` (constant width). It is
a reference for the pointer plumbing, not a component to embed.

## Stylus input per platform (browser)

The W3C Pointer Events API is the one input path that covers every platform
Gamma runs on: Chrome/Edge/Firefox on Windows/Linux/macOS (Wacom, Surface
Pen, Huion), Electron (the desktop app), Android Chrome, and Safari on
iPadOS with Apple Pencil.

- `pointerType` = `pen` | `touch` | `mouse`; `pressure` (0..1), `tiltX/Y`,
  `twist`; `buttons & 32` is the eraser end (Surface/Wacom), `buttons & 2`
  the barrel button. `setPointerCapture` keeps a stroke alive off the
  element.
- `getCoalescedEvents()` yields the full sample rate between frames on
  Chromium and Firefox. Safari does not implement it but delivers
  `pointermove` at the Pencil's native 120/240 Hz, so the two paths give
  comparable density. `getPredictedEvents()` is Chromium-only; it is a
  latency nicety, not a requirement.
- Safari + Pencil: pressure and tilt are real; touch and pen arrive as
  separate pointer types, so "pen draws, finger scrolls" is a one-line
  rule. Setting `touch-action: none` only on the ink layer while a tool is
  armed keeps the viewer's pinch-zoom working otherwise.
- Latency: draw the in-progress stroke on a `<canvas>` with
  `{desynchronized: true}` and commit to the retained layer on pointer-up.
  Chromium's low-latency canvas path is what browser ink apps (Excalidraw,
  tldraw, Microsoft Whiteboard web) use.

So a browser ink layer is *the* multi-platform implementation. A native
client is not needed for pen quality; the fork built one because it wanted
PencilKit's look and audio replay, and paid for it with an opaque format.

## What the upstream fork built (amogadget/Gamma v0.4.0)

`docs/design/handwriting-recording-ipad.md` there describes a native iPad
app (PDFKit + PencilKit + AVFAudio) that logs into the Gamma server, embeds
the web workspace in a WKWebView, and syncs ink as blocks. The web side only
*displays* ink. The design went through three shapes (standalone `.note`
bundles, then Gamma-native blocks, then a hybrid app with browser replay),
which is itself a finding: keeping ink outside the block tree created a
second document identity and was abandoned.

Worth adopting:

- **One block per ink group, not per stroke.** A derivation in a margin is
  dozens of strokes; per-stroke blocks wreck the outliner and multiply ops.
  The user starts a new group explicitly ("New Ink"); strokes inside are
  drawing data.
- **Ink is a block**: it sits in the notes tree under the page, its
  `content` is the caption/transcription (what search and AI see), it can
  have children. Text edits and drawing edits must not clobber each other.
- **Canonical page coordinates** independent of zoom, scroll, device pixels
  and rotation, converted at the boundary with an affine map. They used
  unrotated crop-box points; Gamma's existing `pdf_position` convention is
  the displayed page at scale 1 and the PDF writers already map that to
  user space, so the plan keeps *that* rather than adding a second
  convention.
- **Never rewrite the PDF**; ink is an overlay, export is a separate file.
- **One editable source, no derived display asset that can go stale.** They
  learned this the hard way (blurry whole-block PNG, then per-stroke PNGs,
  then budgets and backfill endpoints). With an open vector format there is
  nothing derived to keep in sync.
- **Sidebar marker + jump + brief flash** for locating a group on the page.
- **Per-point time offsets** cost nothing to store and are what makes
  audio-synchronised replay possible later. Their rule "never fabricate a
  time you did not record" is right.

Not adopting, and why:

- PKDrawing as source of truth, PNG previews, per-stroke PNG `.inkjson`
  replay derivatives, the 32 MiB asset caps built around them: all
  consequences of an opaque format.
- A separate endpoint family (`PUT /blocks/{id}/ink|note|audio|replay-preview`
  with `expected_revision`, lost-response retry rules, an outbox) that wrote
  `unified_blocks` rows with raw SQL. This repo's `apply_ops` + op log + page
  socket already give idempotent inserts, property-level patches, ordering
  and live fan-out; a raw-SQL side channel would re-open exactly the
  problems [collaboration.md](collaboration.md) closed.
- `native_note` ancestry validation and "parent must be a PDF page" checks:
  the block-centric direction wants ink on *any* block, not only under a
  PDF page.
- Audio recording/replay: a separate feature; the format leaves the door
  open.

## Sources

- InkML: https://www.w3.org/TR/InkML/
- Xournal++ stroke model and saver: https://github.com/xournalpp/xournalpp/blob/master/src/core/model/Stroke.h and https://github.com/xournalpp/xournalpp/blob/master/src/core/control/xojfile/SaveHandler.cpp
- tldraw draw shape schema: https://github.com/tldraw/tldraw/blob/main/packages/tlschema/src/shapes/TLDrawShape.ts
- Excalidraw element types: https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/types.ts
- perfect-freehand: https://github.com/steveruizok/perfect-freehand
- pdf.js ink editor: https://github.com/mozilla/pdf.js/blob/master/src/display/editor/ink.js
- reMarkable v6 parser: https://github.com/ricklupton/rmscene
- PencilKit `PKDrawing`: https://developer.apple.com/documentation/pencilkit/pkdrawing-swift.struct ; decode failures across OS versions: https://developer.apple.com/forums/thread/734632
- Pointer Events spec: https://w3c.github.io/pointerevents/ ; Apple Pencil in Safari (pressure, no coalesced events, 240 Hz moves): https://dev.to/sendotltd/reading-apple-pencil-pressure-in-the-browser-pointerevent-getcoalescedevents-and-the-2e23 and https://developer.apple.com/forums/thread/689375
- Upstream fork design doc: https://github.com/amogadget/Gamma/blob/v0.4.0/docs/design/handwriting-recording-ipad.md
