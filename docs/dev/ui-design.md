# UI design conventions

The rules that keep the frontend looking like one product. New UI should
follow them instead of inventing new patterns.

## One control set, everywhere

Mermaid diagram previews in notes and chat use the shared component and toolbar
described in [mermaid.md](mermaid.md); the toolbar is the note image's hover
strip of `ctlBtn` icon buttons, and the diagram resizes with the same
right-edge grip as an image (`shared/ui/ResizeGrip.jsx`).

Reuse the unified classes; never invent a bespoke style for a control that
already exists. Bespoke CSS classes are for **layout only**.

| Class / component | Use for |
|---|---|
| `uiBtn` (+ `sm`, `on`, `primary`, `danger`, `iconSq`) | every button; `sm` is the shared 28 px compact size, `on` = toggled state, `iconSq` = square icon-only (combine with `sm` for compact toolbars) |
| `ctlBtn` / `ctlBtnRow` / `pdfCtlBox` | the flat 22 px icon buttons of the PDF zoom column: `pdfCtlBox` = the elevated vertical box, `ctlBtnRow` = the same buttons laid flat with no box (chat header), `modeActive` = on. **`ctlBtn` (frameless) is the DEFAULT style for any icon button** — new icon toolbars (e.g. the image hover tools) use it, not bespoke button styles |
| `uiClose` (+ `uiCloseSm`/`uiCloseLg`) | every × close button |
| `aiKeyInput` | every text/number/password input in dialogs and settings |
| `switch` / `switchTrack` | every on/off toggle |
| `MenuSelect` / `ActionMenu` ([Menus.jsx](../../frontend/src/shared/ui/Menus.jsx)) | every dropdown: Codex-style pill trigger + checkmarked `ContextMenu`. No native `<select>` anywhere |
| `MenuItem` / `MenuLabel` / `SubMenuItem` ([Menus.jsx](../../frontend/src/shared/ui/Menus.jsx)) | every row inside a menu: icon column + ellipsizing label (+ `danger`, `trailing`). `SubMenuItem` is the nested flyout — hover-opened, safe-triangle guarded |
| `categoryTag`, `uiTag` | chips and small badges |
| `popoverAnchor` | the `position: relative; inline-flex` wrapper every popover trigger sits in (`data-popover="…"` on the same element) — never inline that style |

### Interface size and text size

- **Interface size** (Settings / Appearance, `gamma-ui-scale`, a `Stepper` over
  the `UI_SCALE` range in `app/prefs.js`, 70–160 % in 10 % steps) scales both
  interface text and controls. Fixed font sizes in the application stylesheets
  multiply by `--ui-font-scale`, inherited from `--ui-scale`. Controls (buttons,
  summaries, button roles and the shared control classes) use CSS `zoom` for
  their box, text and icon, and reset `--ui-font-scale` to 1 to avoid doubling
  the text scale. Nested controls reset `zoom` to 1 as well.
  Keep PDF-coordinate positioning on an unscaled wrapper, with the control
  inside it (`pdfNoteAnchor` / `pdfNoteBadge`); zooming the positioned element
  also scales its offsets and makes it drift away from the highlight.
  `index.html` applies the stored value before first paint and App.jsx keeps
  it in sync. PDF page geometry and its text layer retain their separate zoom.
- **Text size** is per panel and per session: Ctrl/⌘+scroll over the notes
  list or the chat transcript. `useTextScale` (`shared/ui/Widgets.jsx`) owns it. It is
  a native non-passive wheel listener, because React's `onWheel` can't
  `preventDefault` and the browser would zoom the page. Each ~40 px of
  accumulated delta is one ×1.1 step (mouse notches and trackpad pinches
  both land on whole steps), clamped 0.6–2.5 and snapping back onto 100 %.
  The scale goes on the panel as the `--text-scale` custom property, which
  the base font sizes multiply in:
  `.blockRendered`, `.blockEditor`, `.blockEditorCm .cm-scroller`, `.chatBubble`.
  A transient `.textScaleBadge` pill (the panel's first child, sticky, zero
  height) reads out the percentage. Nothing is stored: reload resets it. On
  the home library the gesture is left to the browser.

### Fullscreen on touch devices

The fullscreen button asks for native fullscreen first. App fullscreen
(`.app.pseudoFullscreen` + `html.appFocusFullscreen`) is the fallback when
the Fullscreen API is missing (iOS Safari) or rejects the request. It hides
the app bars, confines overscroll, and exits through the same button or
Escape; the browser's own bars may stay visible. The button handles a
stationary touch release itself, because a mobile browser may omit the
compatibility click after a scroll. The click that does follow is consumed,
so one tap cannot toggle twice. Mouse and keyboard keep the plain click path.

### Menus and submenus

Every cursor-anchored menu is a `ContextMenu`; every row inside one is a
`MenuItem` (icon column, ellipsizing label, optional `trailing` node,
`danger` for destructive actions). A row that opens a nested list is a
`SubMenuItem` — it renders its panel *inside* the parent menu's DOM (a
portalled panel would sit outside the parent's outside-pointerdown test, and
the parent would dismiss itself before a click on a flyout row could land),
flips to the other side and clamps vertically when the viewport is tight.

Submenus open on hover, and the hover-switching is guarded by
[menuAim.js](../../frontend/src/shared/ui/menuAim.js): while a flyout is open, a
pointer move that stays inside the triangle from the cursor's recent position
to the flyout's near edge counts as "aiming at the flyout", and the hover
change it would cause is held until the aim breaks or the cursor stops. That
is what lets a diagonal move into the flyout pass over the rows below the
trigger without closing it. The module is plain geometry plus a `useMenuAim`
hook (`setTarget` / `guard` / `keep`) — any other menu surface can adopt it
without going through `shared/ui/Menus.jsx`.

### Dialogs

`.reportOverlay` › `.reportModal` is the one dialog surface (settingsKit's
`SubDialog` wraps it for the settings editors). Confirm-style dialogs — the
shared `confirmBox`, the external-link prompt — add a `.confirmHead`: an icon
chip (`.confirmIcon`, `.danger` for destructive) leading a title plus one
line of explanation, the same shape as a settings `PaneHead`, over the
right-aligned `.reportModalBtns` row. Escape closes them.

Destructive affordances all read from one set of tokens — `--danger`,
`--danger-bg`, `--danger-border` — so the solid confirm button, the outlined
secondary, `.uiBtn.danger` and a menu's `danger` row are the same red in both
themes. Never hardcode a red.

### The share popover

`sharing/SharePopover.jsx` (the topbar link button) is the one place a page
is published. It is a popover under its button, like the account menu (App
wraps it in a `data-popover="share"` anchor, so the outside-click and Escape
rules close it; on phones the bottom bar's popover rule spans it across the
screen), built from the settings kit like the workspace Manage dialog:
`Section`s — Link (the address as the row hint, Copy link and a danger
`iconSq` Stop sharing), Access (pictured, not described: three
`IconChoices` tiles — Anyone / Signed in / Invited only — and, as the
section's action, one View / Edit
`Segmented`; one summary sentence under the tiles is the only prose, amber
`.shareWarn` when a link is editable without sign-in), People (`aiProvRow`
rows: the owner, then each invited account with its own View / Edit
`Segmented` and a `uiBtn sm iconSq` remove; the section's Invite action
toggles an inline form — compact `AccountPicker` + access — a popover can't
host a modal) and the page's Citation section (App.jsx owns it: a `citeHead`
label line, then a `CopyBox` — text with the copy button pinned top-right —
for the slide citation and for BibTeX; the section's action regenerates).
Every change saves at once; nothing is a bespoke control. There is no
"reset link": stopping and sharing again mints a new address. The read-only
view shows the counterpart tag ("Can edit · shared by …", and "as <name>" for
a visitor without an account) in its top bar.

---|---|
| `app/App.jsx` | routing, block-tree editor state, docks, the page's live session glue, AI chat glue (decomposition in progress) |
| `collaboration/usePageCollab.js`, `shared/model/blockOps.js`, `collaboration/Presence.jsx` | the live session (ops out, ops + presence in), the pure tree diff/apply, the avatar stack / row chips ([collab.md](collab.md)) |
| `collaboration/MirrorPopover.jsx`, `collaboration/MergeResolver.jsx`, `settings/SettingsMirrors.jsx` | a clone's sync pill with its settings and conflicts views, the conflict card + the row chip, Settings → Workspaces → Clones ([mirror.md](mirror.md)) |
| `app/prefs.js` | every localStorage preference (`useAppPrefs`) |
| `settings/SettingsDialog.jsx` + the `settings/Settings*.jsx` panes | the Settings dialog (`SettingsKit.jsx` holds the shared primitives incl. `AccountPicker`, the search-box-over-account-rows people picker, and `LogBox`) |
| `settings/SettingsAppearance.jsx`, `settings/SettingsLibraryDisplay.jsx` | the Appearance pane (theme cards + PDF sample) and Library › Display (a live `PageCard` beside its switches) ([settings.md](settings.md)) |
| `transfers/ImportExport.jsx`, `transfers/transferFormats.js`, `shared/illustrations/` | the Import/Export dialogs, their format/source rules (`resolveExport` / `resolveImport`) and the decorative previews ([import_export.md](import_export.md)) |
| `pdf/pdfCitation.js`, `pdf/PdfCitationOverlay.jsx` | an AI reply's citation link → the quoted passage highlighted on the cited PDF page ([pdf_citations.md](pdf_citations.md)) |
| `shared/lib/canvasSize.js`, `pdf/verticalScrollSnap.js` | the canvas backing-store cap and the one-finger vertical scroll alignment ([pdf_loading.md](pdf_loading.md)) |
| `chat/ChatDock.jsx` | the AI chat panel (incl. agent wiring); header = a `.ctlBtnRow` of `.ctlBtn` icon buttons (the PDF zoom column's buttons laid flat) with the ⚙ settings popover |
| `pdf/PdfViewer.jsx` | the custom pdf.js viewer |
| `ink/ink.js`, `ink/inkStore.js`, `ink/inkInput.js`, `ink/InkLayer.jsx` | handwriting ([handwriting.md](handwriting.md)): the stroke codec + geometry (pure), the files/drafts store, pointer sampling, and the page layer + selection menu + notes card + tool strip (`.pdfInkBar`: `ctlBtn`s and `colorBtn` swatches) |
| `search/SearchPanel.jsx`, `library/librarySearch.js` | workspace search (Ctrl+F) and the title scorer shared with chat and quick open |
| `library/QuickOpen.jsx` | quick open (Ctrl+P): a `.reportOverlay` palette over the library's page titles — recents, then open tabs, then the rest; rows are the chat mention picker's `chatMentionOption` |
| `chat/PaperMentionInput.jsx`, `chat/paperMentions.js` | chat mention picker, mention text edits and `MAX_CHAT_REFERENCES` (six attached pages plus the current page) |
| `editor/BlockTree.jsx`, `shared/model/blockModel.js` | outliner rendering / pure tree ops (`shared/model/highlightColors.js` is the highlight palette both share with the viewer). Line breaks in a rendered note: one Enter is a hard line break (`remark-breaks`), one blank line the paragraph break, and every further blank line a visible empty line (`expandBlankLines` in `editor/mdMarks.js`, applied by `mdPreprocess` outside math and code) — what the editor shows is what the note renders |
| `transfers/FileChip.jsx` | the file chip an upload link renders as — a small card (kind icon in a tinted square, name, download arrow), inline so it sits in a sentence, identical for every type; a PDF or markdown chip whose page exists gets an accent "open page" button before the arrow; a `ContextMenu` on right-click with "Open page" / "Add to library" (fed by `FileChipContext` from App and one batched `POST /pages/by-docs` per render) and download; also the shared `postFile` / `uploadFilesAsLines` upload helpers |
| `editor/MdTools.jsx` | in-place tools on rendered notes: `MdImage` (hover toolbar of `ctlBtn` icons — zoom lightbox, caption via alt text, download, delete — plus a drag grip writing the Obsidian `![alt|300]` size; legacy Logseq `{:width N}` reads and normalizes on edit) and `MdTableWrap` (hover "+" strips, column/row handle menus — insert, align, delete — and click-a-cell in-place editing: an input over the cell, Tab/Shift-Tab hop cells across the commit remount via a module-level session map, Enter commits, Esc cancels; tables are never edited as raw markdown — a cell mousedown stops the block row's edit-on-mousedown), backed by pure source transforms (`scanImages`/`scanTables` locate the nth rendered construct; `applyImageEdit`/`applyTableEdit` rewrite it, tables re-serialized pretty-printed; `formatTables` also runs when a block's raw editor closes) and `htmlTableToMarkdown` for the spreadsheet-paste path |
| `editor/BlockCmEditor.jsx` | the CodeMirror 6 block editor (textarea-compatible facade) with live in-place rendering of closed `$…$`/`$$…$$` spans, ``` ``` ``` fences (highlight.js cards), `[[ref]]`/`![[embed]]` chips, `![alt](url)` images (the picture, sized like the rendered view, alt as caption; `scanImageSyntax` in `mdMarks.js` is the one image scanner, shared with `MdTools`), and markdown (headings, `**`/`*`/`` ` ``/`~~`/`==`, links + bare URLs, clickable `- [ ]` checkboxes, `- ` bullets, `---` rules, quote lines and full `> [!type]` callout boxes with their fold flag, colored runs — `<span style="color:…">` / `background:…` inline HTML, tags hidden, `scanColorSpans` in `mdMarks.js`) — the construct the caret touches stays raw source (line-level touch for heading/quote prefixes, marker-only touch for list markers so a todo's checkbox survives editing its text). Raw math gets VSCode-style bracket-pair colorization (depth-cycled `--bracket-*` colors, enclosing pair boxed). Decorations come from a `StateField`, not a ViewPlugin — plugin decorations may not replace line breaks (multi-line fences/`$$` would throw). Formatting hotkeys: Ctrl/Cmd+B/I/E, Ctrl+Shift+X/H toggle `**`/`*`/`` ` ``/`~~`/`==` Obsidian-style, Ctrl+K inserts `[sel](url)` (clipboard URL fills the slot); swallowed inside math/fences/inline code |
| `editor/mdMarks.js` | the inline-mark table (regex + class per marker) shared by the live renderer and the hotkeys, plus the pure `toggleMark`/`insertLink` transforms (wrap / unwrap / empty pair / per-line for multi-line selections). `scanMarks` allows proper nesting (`**a *b* c**`, `*a **b** c*`; nothing inside inline code) and treats `***x***` as one bold+italic span with two `layers`, so Ctrl+B and Ctrl+I each peel off their own delimiters |
| `editor/SlashMenu.jsx` | the "/" command catalog + popup (link, embed, equations, highlight, headings, to-do, lists, quote, callout, code, mermaid, divider, table, image, date, and the `hidden` text/background color commands from `mdMarks.TEXT_COLORS` that show only when the query matches) and the "Paste as" chooser shown after a URL paste (gamma block link → mention/synced block/URL, other URLs → URL/titled link); blockTree owns trigger detection and key handling |
| `editor/callouts.js` | remark plugin for `> [!note] Title` callouts (type aliases → note/tip/warning/danger/important/quote; colors in app.css); Obsidian's `[!note]-` / `+` fold flag makes a native `<details>` with the title as `<summary>` (chevron in app.css) |
| `editor/codeHighlight.js` | fenced ``` ``` ``` code helpers shared by editor + renderer: `scanFences` (region scanner, mirrored in mdPreprocess exclusions and blockTree's Enter/Tab-in-fence handling), `fenceInnerAt`, and the highlight.js (`lib/common`) wrapper; token colors are theme-aware `.hljs-*` rules in app.css |
| `editor/LatexEditor.jsx` | LaTeX aids while editing: the live preview docked to the editor column with a caret marker, the `\command` popup, `renderKatex`/`useCaretAnchored` shared helpers; `editor/latexCompletion.js` is the pure catalog (prefix/abbreviation/fuzzy tiers, snippets, Tab-out navigation) it re-exports; `editor/latexInput.js` supplies scalable delimiter pairing. See [LaTeX editing](latex_editing.md) for shortcuts and browser checks |
| `library/libraryUtils.js` | folder-tag semantics (mirrored by `backend/gamma/foldertags.py`) |
| `shared/ui/Widgets.jsx`, `shared/ui/Menus.jsx`, `shared/ui/Icons.jsx` | shared components |
| `shared/ui/MermaidDiagram.jsx`, `shared/ui/ResizeGrip.jsx` | the Mermaid figure with its hover toolbar of `ctlBtn`s ([mermaid.md](mermaid.md)); the right-edge drag grip + `useDragResize` hook that size note images and diagrams alike |
| `shared/ui/menuAim.js` | pointer-trajectory ("safe triangle") hover intent for hierarchical menus — UI-agnostic, consumed by `shared/ui/Menus.jsx` |
