# Handwriting workflows: Goodnotes, Notability, and Gamma

Research date: 2026-09-14. Scope: writing, selecting, editing, navigating,
reusing and reviewing handwritten notes, including the surrounding tools.
Based on official product documentation and a Gamma source audit. Native
apps were not operated during this survey. Features can vary with platform,
plan and staged rollout; an undocumented behavior is marked **unverified**.

This supplements [handwriting.md](handwriting.md), whose earlier survey
concentrated on formats and the pen/tool strip. Current Gamma behavior is
documented in [the development guide](../dev/handwriting.md).

## Main finding: ink needs direct editing

Touching existing writing to bring up edit buttons is part of a larger
selection workflow. A toolbar and a smooth pen do not
complete that workflow. Users need to select existing marks, see what is
selected, change them locally, and resume writing without a keyboard.

The two reference apps have different documented entry gestures:

| Situation | Goodnotes | Notability |
|---|---|---|
| Finger selects an object | Updated UI documents finger-tap selection, highlighting the object, opening its menu and activating Lasso. | Direct shape selection is documented; arbitrary unselected freehand ink uses the documented Select/lasso workflow. |
| Finish a lasso | Updated UI shows the Object Menu immediately. | Tap once inside the selection to show the popover. |
| Press a stroke with the pen | Circle to Lasso: draw a circle, lift, then long-press that circle to turn it into a selection. | No equivalent circle-to-lasso gesture verified in the reviewed sources. |
| Move selection | Drag selected content. | Drag inside with finger or stylus. |
| Paste | Available selection actions depend on the object and clipboard. | Copy/cut first, then touch and hold at the destination. |
| Hold while drawing | Draw-and-hold corrects a line or shape. | Draw-and-hold corrects a line or shape. |
| Hold on the page | A finger long-press can expose Zoom. | Optional tap-and-hold enters Zoom View. |

Sources: [Goodnotes updated UI][g-ui], [Goodnotes selection][g-select],
[Goodnotes Zoom][g-zoom], [Notability Select][n-select],
[Notability shapes][n-shape], [Notability gestures][n-settings].

**Important uncertainty:** Goodnotes' documentation says “object”;
it does not specify whether an arbitrary freehand tap selects one stroke,
a recognized word, a connected drawing, or an existing group. Notability's
shape-tap rule should not be generalized to every handwritten stroke.
Gamma must explicitly choose its selection unit. Merely attaching a menu
to every pointer-down would also interfere with writing and scrolling.

## Feature inventory

The Gamma status column is the working tree of 2026-09-14, before the
selection work that followed this survey; [handwriting.md](../dev/handwriting.md)
describes the current behaviour. “Missing” refers to Gamma's handwriting
workflow, not unrelated text-block capabilities.

### Writing and correction

| Capability | Reference behavior | Gamma status |
|---|---|---|
| Pen styles | Goodnotes: fountain, ball, brush; solid/dashed/dotted; tip, pressure and stabilization options. [Pen][g-pen] | One pressure-shaped pen; pressure toggle, fixed smoothing; no per-preset pen style or patterns. |
| Graphite pencil | Goodnotes has a separate Pencil with shading and configurable thickness. [Pencil][g-pencil] | Missing. |
| Pen/color presets | Goodnotes supports per-tool color slots and reordering. Notability allows duplicated, reordered and hidden tools. [Colors][g-colors], [Toolbox][n-tools] | Pen/highlighter presets, custom color, size, duplicate/remove; no reorder/hide. |
| Finger/stylus roles | Notability separates Pencil writing from one-finger navigation and supports temporarily disconnecting Pencil. [Pencil input][n-pencil] | Auto-pen and fingers-never-draw preferences; pen priority and same-page palm suppression. |
| Stylus shortcuts | Notability documents Pencil double-tap choices, pressure and automatic tool return after erasing. [Pencil input][n-pencil] | Eraser/barrel button handling; native Pencil-specific gestures unimplemented. |
| Freehand highlighting | Notability styles and erases highlighting like ink, with pressure and line patterns. [Highlighter][n-highlight] | Separate translucent presets; constant width, multiply blending. |
| Straight/smart highlighting | Notability: draw-and-hold straightens; long-press PDF/typed text and drag snaps highlighting to words. [Highlighter][n-highlight] | Freehand highlighter plus a separate PDF text-selection highlight flow. |
| Precise and whole erasing | Goodnotes: precision, standard and stroke modes. Notability: partial and whole. [Goodnotes eraser][g-eraser], [Notability eraser][n-eraser] | Partial and whole, three radii. Partial erasure currently tests stored sample points. |
| Eraser filters | Goodnotes can limit erasure to chosen stroke types, including highlighter only. [Eraser][g-eraser] | Missing. |
| Return to previous tool | Both document eraser auto-deselect. [Goodnotes][g-eraser], [Notability][n-pencil] | Missing for the toolbar eraser. |
| Scribble to erase | Goodnotes can erase covered writing using a pen scribble; can be disabled. [Gesture][g-scribble] | Missing. Notability equivalent unverified. |
| Undo/redo without keyboard | Goodnotes documents two-/three-finger double taps. Notability offers two-/three-finger taps or three-finger swipes, plus visible controls. [Goodnotes gestures][g-undo], [Notability settings][n-settings], [Getting started][n-start] | Ink undo/redo is keyboard-driven while its strip is open. No ink touch controls. |

### Selection, transformation and reuse

| Capability | Reference behavior | Gamma status |
|---|---|---|
| Direct object selection | Goodnotes finger-tap opens its contextual menu. [UI][g-ui] | Unarmed ink click jumps to the note block. Armed ink has no tap-to-edit action. |
| Freeform/box selection | Both offer lasso and rectangle selection. [Goodnotes][g-select], [Notability][n-select] | Present, with a dashed bounding box. |
| Selection filters | Goodnotes can include/exclude content types, allowing ink selection over an image. [Selection][g-select] | Ink only; no pen/highlighter filter. |
| Contextual actions | Goodnotes menu includes copy/cut/duplicate/delete, color, ordering and other object-specific actions. Notability includes Style, Convert, Copy, Cut, Duplicate, Group, Save, Delete. [Goodnotes][g-select], [Notability][n-select] | No selection action menu. Move and keyboard delete only. |
| Move with finger | Notability allows finger or pen dragging inside a selection. [Select][n-select] | Move exists, but `penOnly` rejects finger input before the selection branch. |
| Resize and rotate | Goodnotes has selection handles. Notability supports bounding handles, pinch scaling and twist rotation. [Goodnotes][g-ui], [Notability][n-select] | Missing. |
| Restyle existing ink | Notability can change an existing line's pattern; partially erased pieces retain independently editable width/color. [Conversion/editing][n-convert], [Eraser][n-eraser] | Preset changes affect future strokes only. No selected-ink restyling. |
| Mirror | Notability documents horizontal/vertical ink flipping on iOS. [Pencil input][n-pencil] | Missing. |
| Copy, cut and paste elsewhere | Both expose clipboard operations for selections. Notability documents hold-to-paste and dragging ink as an image to another app. [Goodnotes][g-select], [Notability][n-select] | No ink clipboard or cross-page ink paste. |
| Group and reuse | Notability groups ink for joint transforms and saves it as reusable stickers. [Conversion/editing][n-convert] | Ink note blocks group persistence, but there is no explicit reusable selection/group or sticker action. |
| Alignment and page transfer | Goodnotes has object snapping guides and moving lasso selections across page boundaries. [Selection][g-select] | Page-local translation only; no guides. |
| Object locking | Goodnotes locks images, shapes, sticky notes and text boxes; explicitly excludes handwriting. Notability documents shape locks with Notability Cloud. [Goodnotes locks][g-lock], [Notability shapes][n-shape] | No object lock model. Do not label ink-locking a shared reference feature. |
| Layers and ordering | Goodnotes documents front/back selection actions and experimental notebook layers on supported iPad/Mac Pro installations. Layers are not supported on Web/Windows/Android. [Selection][g-select], [Layers][g-layers] | Stroke array order; no user-facing layer controls. |

### Diagramming, reading and study

| Capability | Reference behavior | Gamma status |
|---|---|---|
| Draw-and-hold geometry | Both straighten/recognize held strokes. Goodnotes adds connectors and diagram controls; Notability provides editable shape points/fill. [Goodnotes shapes][g-shape], [Notability shapes][n-shape] | Missing. |
| Ruler | Both have movable drawing rulers. Notability supports stamping precise lines; its article excludes Mac/iPhone. [Goodnotes ruler][g-ruler], [Notability ruler][n-ruler] | Missing. |
| Magnified writing window | Both provide an inset writing area with automatic advance/new-line behavior. Goodnotes documents Zoom Window as iOS-only. [Goodnotes Zoom][g-zoom], [Notability Zoom][n-zoom] | Whole-PDF zoom only. |
| Handwriting recognition/search | Notability converts/searches handwriting and converts math with editable LaTeX. Goodnotes supports text/math conversion. [Notability conversion][n-convert], [Goodnotes selection][g-select] | Search sees captions/PDF text; no ink recognition. |
| Reflow and word editing | Goodnotes Edit Handwriting supports word selection, line straightening, alignment, recoloring and width-driven reflow. [Reflow][g-reflow] | Missing; requires a model of words/lines beyond raw strokes. |
| Writing assistance | Goodnotes documents spellcheck and handwriting reflow; Math Assist has platform/language limits. [AI guide][g-ai], [Math Assist][g-math] | No handwriting-specific assistance. |
| Audio-linked handwriting | Both support recording linked to handwriting replay. Goodnotes replay modes are limited to iOS/macOS notebooks. [Goodnotes audio][g-audio], [Notability overview][n-start] | Sample timing exists; no recording or replay UI. |
| Tape and presentation pointer | Notability offers revealable study tape and a laser pointer that leaves no stored ink. [Overview][n-start], [Laser][n-laser] | Missing. |
| Page media and backgrounds | Notability includes text boxes, photos, stickers, sticky notes, scanned/PDF backgrounds, templates and multi-note viewing. [Overview][n-start] | PDF + ink overlay and notes-pane content; no mixed-object canvas or notebook paper tool. |

## Source audit before the selection work (2026-09-14)

Reviewed `frontend/src/ink/InkLayer.jsx`, `ink/ink.js`, `ink/inkInput.js`, `app/App.jsx`,
`pdf/PdfViewer.jsx`, `app/prefs.js`, `settings/SettingsDialog.jsx`, and the handwriting e2e scenarios,
as they were before the selection menu, handles and touch controls were built.
The findings shaped that work; the code they describe has changed since.

1. **Hit testing currently serves erasing.** `hitStrokes` returns every
   stroke within a radius. Direct selection needs a deliberate nearest/topmost
   choice, a screen-space touch tolerance, and a policy for overlapping ink.
2. **The click action is navigation.** `Strokes` calls `onJump(g.id)`;
   `showInkInNotes` scrolls the outliner. Preserve that useful action as an
   explicit “Show note” command when introducing edit selection.
3. **Finger editing is gated out.** `setup` rejects touch for `penOnly`
   before testing lasso or moving the selection. “Fingers never draw” needs
   to permit editing gestures while still allowing ordinary swipes to pan.
4. **Selection has a useful existing representation.** It already stores
   `{page, items: [{id, ids}]}` and can span several ink blocks on one page.
   Editing can use those IDs without splitting every stroke into a block.
5. **Persistence and undo have an existing entry point.**
   `editInkSelection`/`applyInk` can carry before/after snapshots across all
   affected groups. Each menu action or completed transform should be one
   history transaction. Clipboard copies need fresh stroke IDs when pasted.
6. **Undo granularity needs a separate correction.** Whole erasing calls
   `applyInk` per hit/group; partial erasing folds by a `pass` flag without an
   explicit pointer-gesture boundary. Source inspection indicates that one
   pass can split across entries or separate partial passes can merge. Add
   gesture-boundary tests before promising one-gesture undo for every eraser.
7. **The group preview uses bounds shared with export/navigation.** Resize,
   rotate and restyle must update bounding boxes, note cards and
   `pdf_position`, and preserve pressure/time channels. A CSS-only transform
   would not be sufficient.
8. **The menu must survive touch input routing.** Its controls must not
   start ink/lasso beneath them. It must remain reachable near page/screen
   edges, at different zooms and in dark mode. Read-only users must retain
   viewing/navigation without edit actions.

## Recommended interaction contract for Gamma

These are design recommendations inferred from the research, not claims
about undocumented behavior in either reference app.

- A finger tap on ink selects the nearest stroke; show its outline and a
  compact menu immediately. An explicit “Select note” action expands to
  its ink block. Lasso handles arbitrary multi-stroke selections.
- A stationary finger hold on ink can provide the same menu as a forgiving
  alternative. A swipe crossing ink remains scrolling. A second contact,
  movement beyond the gesture tolerance, pointer cancellation or an active
  pen cancels pending touch selection.
- In finger-drawing mode, retain drawing with armed writing tools; expose
  tap selection through Hand/Lasso. Do not delay every finger stroke to
  guess whether it might become a long press.
- After lasso completion show the menu automatically; dragging inside an
  already-selected region moves it. Pressing a visible resize/rotate handle
  transforms it. Fingers outside the selection navigate the PDF.
- Primary actions: **Color, Width, Duplicate, Delete**. More actions:
  **Copy, Cut, Paste, Select note, Show note**, followed by supported
  transforms. Display only actions that work for the current selection.
- Put **Undo/Redo** on the ink strip. These are essential on a tablet even
  if gesture shortcuts are added later. A touch menu must never require a
  keyboard Delete key to finish an edit.
- Dismiss on a blank tap or Escape. Keep deliberate pen strokes usable;
  beginning a new stroke clears the selection instead of moving old ink.
- Keep the menu anchored to the selected ink, clamp it to the visible
  viewport, and provide touch-sized controls. Scrolling must not leave a
  floating menu pointing at the wrong writing.

## Implementation order and acceptance criteria

| Priority | Deliverable | Completion evidence |
|---|---|---|
| 1 | Direct touch selection, contextual menu, finger movement, selected color/width, duplicate/delete, visible undo/redo | Entire write → tap → edit → undo → resume flow works with touch; changes survive reload. |
| 2 | Copy/cut/paste, proportional resize, rotate, proper eraser gesture transactions and filters | Multi-group edits are atomic in history; transformed ink agrees in canvas, note preview and exported PDF. |
| 3 | Draw-and-hold straight lines/shapes, highlighter behavior, auto-return eraser, toolbar reordering | Gesture cancellation is predictable; normal letters are not silently converted or erased. |
| 4 | Zoom writing window, reusable ink, recognition/search/reflow, audio replay, study tools | Separate designs for word recognition, reusable objects and audio time alignment; platform limitations are explicit. |

Playwright coverage to add with priority 1:

1. Trusted touch tap on a thin stroke opens an anchored menu and selects
   only the intended stroke; blank taps dismiss it.
2. A finger swipe starting on that stroke scrolls without selecting,
   changing ink or triggering the note jump. Pinch likewise remains zoom.
3. Long press selects once; movement, cancellation, pen contact and a second
   finger invalidate a pending hold.
4. Lasso multiple strokes across ink blocks; menu appears on completion;
   finger drag moves only the selection while pen-only writing is enabled.
5. Color/width edits change existing strokes; duplicate uses fresh IDs;
   delete removes only selected strokes; visible undo/redo reverses each
   operation exactly once.
6. Menu button presses do not create dots or start a selection underneath.
   “Show note” preserves the original navigation feature.
7. Reload verifies uploaded `.ink` content, counts and bounds, rather than
   merely checking that a menu became visible.
8. Small viewport, page edges, zoom, dark pages, read-only views and edit
   shares preserve menu placement and authorization.

Physical iPad/Pencil and Windows stylus checks remain necessary for hold
timing, native context-menu competition, palm rejection and perceived lag.

[g-ui]: https://support.goodnotes.com/hc/en-us/articles/13682253498767-Improved-User-Interface
[g-select]: https://support.goodnotes.com/hc/en-us/articles/7353695644175-Select-move-and-edit-content-on-the-page
[g-pen]: https://support.goodnotes.com/hc/en-us/articles/7353756785679-Write-and-customize-ink-with-the-Pen-tool
[g-pencil]: https://support.goodnotes.com/hc/en-us/articles/10730874907023-Create-lively-drawings-with-the-Pencil-tool
[g-colors]: https://support.goodnotes.com/hc/en-us/articles/7353743265039-Add-and-manage-writing-tool-color-presets
[g-eraser]: https://support.goodnotes.com/hc/en-us/articles/7353718249231-Erase-handwriting-and-page-content-with-the-Eraser-tool
[g-scribble]: https://support.goodnotes.com/hc/en-us/articles/7443501398671-How-to-Use-Scribble-to-Erase
[g-undo]: https://support.goodnotes.com/hc/en-us/articles/14069931315983-Quick-gestures-for-Undo-and-Redo
[g-lock]: https://support.goodnotes.com/hc/en-us/articles/14140907007375-Lock-objects-to-keep-them-in-place
[g-layers]: https://support.goodnotes.com/hc/en-us/articles/16536297803535-Organize-content-with-layers
[g-shape]: https://support.goodnotes.com/hc/en-us/articles/13682939148943-Draw-shapes-and-build-diagrams-in-Goodnotes
[g-ruler]: https://support.goodnotes.com/hc/en-us/articles/8254946748687-Draw-straight-lines-with-the-Ruler-tool
[g-zoom]: https://support.goodnotes.com/hc/en-us/articles/7353756826383-Write-with-the-Zoom-Window
[g-reflow]: https://support.goodnotes.com/hc/en-us/articles/10779441732111-Edit-and-reflow-handwriting-with-the-Lasso-tool
[g-ai]: https://support.goodnotes.com/hc/en-us/articles/10779112528399-A-guide-to-Goodnotes-AI
[g-math]: https://support.goodnotes.com/hc/en-us/articles/10779567357199-How-to-use-Math-Assist
[g-audio]: https://support.goodnotes.com/hc/en-us/articles/7352688559631-Add-Audio-Recordings-to-your-documents
[n-select]: https://support.gingerlabs.com/hc/en-us/articles/360018646412-Select-Tool
[n-shape]: https://support.gingerlabs.com/hc/en-us/articles/226905028-Creating-and-Styling-Perfect-Shapes
[n-settings]: https://support.gingerlabs.com/hc/en-us/articles/5955260981786-Settings-Appearances-Tools-Gestures
[n-pencil]: https://support.gingerlabs.com/hc/en-us/articles/218333197-Writing-with-Apple-Pencil
[n-tools]: https://support.gingerlabs.com/hc/en-us/articles/6272405402650-Customize-your-Toolbox
[n-highlight]: https://support.gingerlabs.com/hc/en-us/articles/4968218861978-Highlighter
[n-eraser]: https://support.gingerlabs.com/hc/en-us/articles/360029432891-Eraser
[n-convert]: https://support.gingerlabs.com/hc/en-us/articles/360003878731-Handwriting-and-Math-Conversion
[n-ruler]: https://support.gingerlabs.com/hc/en-us/articles/4546486303514-Ruler
[n-zoom]: https://support.gingerlabs.com/hc/en-us/articles/206058497-Zoom-View
[n-start]: https://support.gingerlabs.com/hc/en-us/articles/4867633230234-Getting-Started-with-Notability
[n-laser]: https://support.gingerlabs.com/hc/en-us/articles/5871329959066-Laser-Pointer
