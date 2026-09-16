# UI design conventions

The rules that keep the frontend looking like one product. New UI should
follow them instead of inventing new patterns.

## One control set, everywhere

Reuse the unified classes; never invent a bespoke style for a control that
already exists. Bespoke CSS classes are for **layout only**.

| Class / component | Use for |
|---|---|
| `uiBtn` (+ `sm`, `on`, `primary`, `danger`, `iconSq`) | every button; `sm` is the shared 28 px compact size, `on` = toggled state, `iconSq` = square icon-only (combine with `sm` for compact toolbars) |
| `ctlBtn` / `ctlBtnRow` / `pdfCtlBox` | the flat 22 px icon buttons of the PDF zoom column: `pdfCtlBox` = the elevated vertical box, `ctlBtnRow` = the same buttons laid flat with no box (chat header), `modeActive` = on. **`ctlBtn` (frameless) is the DEFAULT style for any icon button** — new icon toolbars (e.g. the image hover tools) use it, not bespoke button styles |
| `uiClose` (+ `uiCloseSm`/`uiCloseLg`) | every × close button |
| `aiKeyInput` | every text/number/password input in dialogs and settings |
| `switch` / `switchTrack` | every on/off toggle |
| `MenuSelect` / `ActionMenu` ([menus.jsx](../../frontend/src/menus.jsx)) | every dropdown: Codex-style pill trigger + checkmarked `ContextMenu`. No native `<select>` anywhere |
| `MenuItem` / `MenuLabel` / `SubMenuItem` ([menus.jsx](../../frontend/src/menus.jsx)) | every row inside a menu: icon column + ellipsizing label (+ `danger`, `trailing`). `SubMenuItem` is the nested flyout — hover-opened, safe-triangle guarded |
| `categoryTag`, `uiTag` | chips and small badges |
| `popoverAnchor` | the `position: relative; inline-flex` wrapper every popover trigger sits in (`data-popover="…"` on the same element) — never inline that style |

### Control size and text size

Two separate size levers, deliberately not one "zoom":

- **Control size** (Settings / Appearance, `gamma-ui-scale`, a `Stepper` over
  the `UI_SCALE` range in `prefs.js`, 70–160 % in 10 % steps) is a CSS
  `zoom` on every button and toggle —
  `:where(button, .uiBtn, .ctlBtn, .uiClose, .switch)` in `app.css` reads
  `--ui-scale` off the root element. Zoom scales the box, its text and its
  SVG icon as one unit, so rows and toolbars just grow to fit; a second rule
  resets the zoom on a control nested in another so it never compounds.
  `index.html` applies the stored value before first paint (like the theme),
  App.jsx keeps the property in sync afterwards. Content — notes, PDF, chat
  text — is untouched.
- **Text size** is per panel and per session: Ctrl/⌘+scroll over the notes
  list or the chat transcript. `useTextScale` (`widgets.jsx`) owns it. It is
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

The fullscreen button uses the app's CSS fullscreen layout when the primary
pointer is coarse (phones/tablets), and native Fullscreen API on desktop.
This avoids Safari's browser-owned downward-swipe dismissal
([WebKit issue](https://bugs.webkit.org/show_bug.cgi?id=227387)). App fullscreen
hides app bars, confines overscroll, and exits through the same button or
Escape. Browser bars may remain visible; it does not claim native fullscreen.
Browsers without the API, or rejected native requests, use the same layout.
The fullscreen control handles stationary touch release directly, since a
browser may omit its compatibility click after scrolling; a following click
is consumed so a tap cannot toggle twice. Mouse and keyboard activation keep
the regular click path.

### Menus and submenus

Every cursor-anchored menu is a `ContextMenu`; every row inside one is a
`MenuItem` (icon column, ellipsizing label, optional `trailing` node,
`danger` for destructive actions). A row that opens a nested list is a
`SubMenuItem` — it renders its panel *inside* the parent menu's DOM (a
portalled panel would sit outside the parent's outside-pointerdown test, and
the parent would dismiss itself before a click on a flyout row could land),
flips to the other side and clamps vertically when the viewport is tight.

Submenus open on hover, and the hover-switching is guarded by
[menuAim.js](../../frontend/src/menuAim.js): while a flyout is open, a
pointer move that stays inside the triangle from the cursor's recent position
to the flyout's near edge counts as "aiming at the flyout", and the hover
change it would cause is held until the aim breaks or the cursor stops. That
is what lets a diagonal move into the flyout pass over the rows below the
trigger without closing it. The module is plain geometry plus a `useMenuAim`
hook (`setTarget` / `guard` / `keep`) — any other menu surface can adopt it
without going through `menus.jsx`.

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

`.sharePopover` (App.jsx, the topbar link button) is the one place a page is
published, shaped like Notion's share sheet but built only from the shared
controls: an invite row (`aiKeyInput` + `uiBtn sm primary`), people entries
(`.shareEntry`: `.shareAvatar` initial · name + one-line sub · a `MenuSelect`
for Can view / Can edit · `uiClose` remove), a "General access" entry whose
avatar is the audience glyph and whose `MenuSelect` picks Anyone with the
link / Signed-in users / Only people invited, and a `.shareFooter` with Stop
sharing (`uiBtn sm danger`) left and Copy link right. The `.share*` classes
are layout only. The read-only view shows the counterpart `.shareBadge`
("Can edit · shared by …") in its top bar.

## Settings primitives

### Show the result while editing

For settings that change visible parts of a surface, show one realistic, live
example of that surface and place its controls alongside it. Each control
should immediately add, remove or update the corresponding element. Reuse
the actual product component where possible so the preview stays accurate.
Keep its shared styling and interaction states, including hover backgrounds,
shadows and focus indicators; do not override them just because the widget
appears in settings. Prefer layout-only CSS around existing widgets. Keep the
preview stable while elements change, with compact controls. On small screens
place the controls below the preview.

Library Display follows this pattern: one large `PageCard` with independent
Thumbnails, Folders and Labels switches. Use this approach for future visual
settings; a set of miniature alternative cards is appropriate for mutually
exclusive palettes such as themes.

Import and Export start with large format/source choices in PDF, MD and ZIP
rows. Use recognizable app logos for app formats and shared PDF, notes and
Markdown icons for document formats, with consistent monochrome sizing. A live illustrative
page follows only when there are editable options. Fixed contents get no switches:
Gamma exports directly; Logseq export shows only file bundling. Sources with no
import options open the file picker directly, with instructions on the selection
page. Double-click uses the same action as the footer button. The previous step
is a keyboard-accessible `crumbBtn`, matching library breadcrumbs; returning
preserves the chosen format and options.
The shared `SubDialog` header provides the standard `uiClose` × control. The
footer contains only Next or the final action; the breadcrumb handles going back.
Format names stay short because category rows already show file types. Longer
Zotero export instructions are expandable. Capability rules in
`transferFormats.js` determine the controls, effective values and need for review.
The dialogs reuse `PictureChoices`,
`Toggle` and `SubDialog`; their previews are hand-coded React/HTML and CSS in
`illustrations/TransferPreview.jsx` and `illustrations/illustrations.css`. These are examples of the output
options, not renders of the current document.

Keep UI illustrations together in [illustrations/](../../frontend/src/illustrations/README.md),
with one file per subject: React components for interactive drawings, SVG assets
for fixed drawings, and a shared illustration stylesheet. Reuse existing icons
and product widgets; keep control logic and surrounding layout in their owners.

Settings panes are built only from
[settingsKit.jsx](../../frontend/src/settingsKit.jsx):

- `PaneHead` / `Section` / `Row` / `Toggle`: small icon, readable label, short
  hint and shared control. Rows use the shared hover background without a drop
  shadow. Important effects stay visible; supplementary help uses a hover
  tooltip, without an explicit Details toggle.
- Larger areas (AI, workspace management and administration) get second-level
  navigation with Back to settings. Short pages keep the main sidebar. Search
  opens the relevant page and focuses the matching setting.
- Appearance uses shared `uiBtn`/`on` theme cards with small decorative SVG
  palette sketches beside the labels (stacked on narrow screens). Appearance
  buttons inherit shared shadows and hover states, and its noninteractive rows suppress the shared hover fill;
  grouped rows use straight dividers. A PDF sample reflects the current tint and dark-page
  switch. Account and browser scopes sit beside section headings; interface
  controls retain the shared `Row`, `Toggle` and `Stepper` primitives.
- Editor dialogs: `SubDialog` › `.settingsForm` › `Step` (numbered wizard
  stages) or `Field` (caption + hint + one control), closed by a
  `.reportModalBtns` footer. Pass the draft to `SubDialog` so unsaved edits are
  protected on Cancel, Escape and backdrop clicks.
- Shared controls: `Segmented` (joined pills for exclusive choices),
  `PictureChoices` (compact illustrated theme choices for Appearance,
  with a shared flat selected state and decorative SVG previews),
  `ToggleGroup` (its multi-select counterpart: a wrapping row of small
  icon + short-name chips, each an independent on/off — `uiBtn sm` with the
  shared `on` state; the agent's per-tool permissions in Settings and in the
  chat's ⚙ popover are one of these, never a column of checkboxes),
  `UnitInput` (number + unit suffix — units never live in labels),
  `Stepper` (−/+ around a readout for a small numeric range; the readout
  is followed by the shared Reset button),
  `PasswordInput` (a password box with a show/hide eye — a `ctlBtn` over the
  input's right edge, outside the Tab order; it wraps the input's own class,
  so the login page uses it with `loginInput` and every secret field in
  Settings — account passwords, API keys — with `aiKeyInput`),
  `CharSlider` (log-scaled character budget), `Stat`, `Empty`, `QuotaMeter`.

## Theme

Six states: System (default, tracks `prefers-color-scheme` live) or pinned
Light/Dark/Sepia/Solarized Light/Gray — `gamma-theme` in localStorage (valid values are `THEMES`
in `prefs.js`), applied as `data-theme` on the root element. The choice (plus
"Flip page colors") also follows the account through `/api/prefs/appearance` —
server wins on login and on window focus, changes push back; localStorage
stays the instant-paint cache the `index.html` script reads. An inline script in `index.html` applies a pinned theme before
first paint; `color-scheme` follows so native controls match. Scrollbars are
themed rather than left to the OS: a global `scrollbar-width: thin` +
`scrollbar-color: var(--scrollbar-thumb) transparent` (with a
`::-webkit-scrollbar` fallback for older WebKit/Blink) in `app.css`.
"Flip page colors" (`gamma-pdf-dark`) is separate and display-only: it
inverts the PDF canvas (`.pdfDark`), swaps highlight blending from multiply
to screen, and darkens the scroller surround.

**Sepia**, **Solarized Light**, and **Gray** are the eye-comfort modes and the themes that reach
the PDF page as well as the chrome. Sepia retains its original warm beige
surfaces and darker teal text (`#073642`). Solarized Light (`solarized`) follows
[VS Code's Solarized Light](https://github.com/microsoft/vscode/blob/main/extensions/theme-solarized-light/themes/solarized-light-color-theme.json):
cream content surfaces (`#fdf6e3`), surrounding chrome (`#eee8d5`), muted
blue-gray text (`#657b83`), and the original Solarized accents. The desktop
shell and first-paint background use the same palette. Code highlighting
uses Solarized token colors. PDF ink retains its separate softening:
`[data-theme="sepia"] .pdfViewer:not(.pdfDark)` tints the page by giving the
page wrapper the `--pdf-paper` ground and letting the canvas `multiply` onto
it. Multiply, not a `sepia()`/`hue-rotate` filter: white paper lands exactly
on the ground color while figures only warm slightly. The canvas also gets
`opacity: 0.82` — under multiply that leaves the paper invariant and lifts
only the ink, black → `(1−α)·paper` ≈ `#2e2c29` (~12.6:1), the softened
charcoal the eye-strain guidance recommends over pure black. **Gray** is the
neutral counterpart — the same machinery driven by different tokens
(`--pdf-paper: #f4f4f4`, `#2d2d2d` text ladder, Light's role colors) for
users who want the glare cut without a color cast; the PDF rules select
`:is([data-theme="sepia"], [data-theme="solarized"], [data-theme="gray"])`, so a new tinted theme only
needs a token block plus membership in those lists. The tint needs no prop — `data-theme` is global, so it is pure CSS
— and "Flip page colors" wins when both are on. Light-ground rules that were
`[data-theme="light"] …` are now
`:is([data-theme="light"], [data-theme="sepia"], [data-theme="solarized"], [data-theme="gray"])`;
extend that list, don't add another copy.

## Layout

- Desktop: dockable windows via `react-resizable-panels` **v2** (v4 has an
  incompatible API).
- Phone (< 700 px, or a short coarse-pointer viewport): single full-width
  panel with a bottom tab bar (`useIsPhone`, `.phoneTabBar` / `.phonePanel`).
- View modes come from the URL query, no router lib: `/` home,
  `/?page=<id>` paper, `/?share=<token>` read-only, `/?block=<id>`
  jump-to-block.
- Icons are hand-rolled SVGs in [icons.jsx](../../frontend/src/icons.jsx) —
  add there, keep the stroke style.

## File map (frontend/src)

| File | Owns |
|---|---|
| `App.jsx` | routing, block-tree editor state, docks, the page's live session glue, AI chat glue (decomposition in progress) |
| `collab.js`, `blockOps.js`, `presence.jsx` | the live session (ops out, ops + presence in), the pure tree diff/apply, the avatar stack / row chips ([collab.md](collab.md)) |
| `prefs.js` | every localStorage preference (`useAppPrefs`) |
| `settings.jsx` + `settingsKit/Ai/Users/Workspace/WorkspacesAdmin/Backups/Server.jsx` | the Settings dialog (`settingsKit` holds the shared primitives incl. `AccountPicker`, the search-box-over-account-rows people picker, and `LogBox`) |
| `chatDock.jsx` | the AI chat panel (incl. agent wiring); header = a `.ctlBtnRow` of `.ctlBtn` icon buttons (the PDF zoom column's buttons laid flat) with the ⚙ settings popover |
| `pdfViewer.jsx` | the custom pdf.js viewer |
| `ink.js`, `inkStore.js`, `inkLayer.jsx` | handwriting ([handwriting.md](handwriting.md)): the stroke codec + geometry (pure), the files/drafts store, and the page layer + notes card + tool strip (`.pdfInkBar`: `ctlBtn`s and `colorBtn` swatches) |
| `search.jsx` | workspace search (Ctrl+F) |
| `blockTree.jsx`, `logseqPdfModel.js` | outliner rendering / pure tree ops |
| `fileChip.jsx` | the file chip an upload link renders as — a small card (kind icon in a tinted square, name, download arrow), inline so it sits in a sentence, identical for every type; a PDF or markdown chip whose page exists gets an accent "open page" button before the arrow; a `ContextMenu` on right-click with "Open page" / "Add to library" (fed by `FileChipContext` from App and one batched `POST /pages/by-docs` per render) and download; also the shared `postFile` / `uploadFilesAsLines` upload helpers |
| `mdTools.jsx` | in-place tools on rendered notes: `MdImage` (hover toolbar of `ctlBtn` icons — zoom lightbox, caption via alt text, download, delete — plus a drag grip writing the Obsidian `![alt|300]` size; legacy Logseq `{:width N}` reads and normalizes on edit) and `MdTableWrap` (hover "+" strips, column/row handle menus — insert, align, delete — and click-a-cell in-place editing: an input over the cell, Tab/Shift-Tab hop cells across the commit remount via a module-level session map, Enter commits, Esc cancels; tables are never edited as raw markdown — a cell mousedown stops the block row's edit-on-mousedown), backed by pure source transforms (`scanImages`/`scanTables` locate the nth rendered construct; `applyImageEdit`/`applyTableEdit` rewrite it, tables re-serialized pretty-printed; `formatTables` also runs when a block's raw editor closes) and `htmlTableToMarkdown` for the spreadsheet-paste path |
| `blockCmEditor.jsx` | the CodeMirror 6 block editor (textarea-compatible facade) with live in-place rendering of closed `$…$`/`$$…$$` spans, ``` ``` ``` fences (highlight.js cards), `[[ref]]`/`![[embed]]` chips, and markdown (headings, `**`/`*`/`` ` ``/`~~`/`==`, links + bare URLs, clickable `- [ ]` checkboxes, `- ` bullets, `---` rules, quote lines and full `> [!type]` callout boxes) — the construct the caret touches stays raw source (line-level touch for heading/quote prefixes, marker-only touch for list markers so a todo's checkbox survives editing its text). Raw math gets VSCode-style bracket-pair colorization (depth-cycled `--bracket-*` colors, enclosing pair boxed). Decorations come from a `StateField`, not a ViewPlugin — plugin decorations may not replace line breaks (multi-line fences/`$$` would throw). Formatting hotkeys: Ctrl/Cmd+B/I/E, Ctrl+Shift+X/H toggle `**`/`*`/`` ` ``/`~~`/`==` Obsidian-style, Ctrl+K inserts `[sel](url)` (clipboard URL fills the slot); swallowed inside math/fences/inline code |
| `mdMarks.js` | the inline-mark table (regex + class per marker) shared by the live renderer and the hotkeys, plus the pure `toggleMark`/`insertLink` transforms (wrap / unwrap / empty pair / per-line for multi-line selections). `scanMarks` allows proper nesting (`**a *b* c**`, `*a **b** c*`; nothing inside inline code) and treats `***x***` as one bold+italic span with two `layers`, so Ctrl+B and Ctrl+I each peel off their own delimiters |
| `slashMenu.jsx` | the "/" command catalog + popup (link, embed, equations, highlight, headings, to-do, lists, quote, callout, code, divider, table, image, date) and the "Paste as" chooser shown after a URL paste (gamma block link → mention/synced block/URL, other URLs → URL/titled link); blockTree owns trigger detection and key handling |
| `callouts.js` | remark plugin for `> [!note] Title` callouts (type aliases → note/tip/warning/danger/important/quote; colors in app.css) |
| `codeHighlight.js` | fenced ``` ``` ``` code helpers shared by editor + renderer: `scanFences` (region scanner, mirrored in mdPreprocess exclusions and blockTree's Enter/Tab-in-fence handling), `fenceInnerAt`, and the highlight.js (`lib/common`) wrapper; token colors are theme-aware `.hljs-*` rules in app.css |
| `latexEditor.jsx` | LaTeX aids while editing: caret-anchored live preview, `\command` autocomplete, `renderKatex`/`useCaretAnchored` shared helpers |
| `libraryUtils.js` | folder-tag semantics (mirrored by `backend/gamma/ai_tools.py`) |
| `widgets.jsx`, `menus.jsx`, `icons.jsx` | shared components |
| `menuAim.js` | pointer-trajectory ("safe triangle") hover intent for hierarchical menus — UI-agnostic, consumed by `menus.jsx` |
