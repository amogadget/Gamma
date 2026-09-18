# UI design conventions

The rules that keep the frontend looking like one product. New UI should
follow them instead of inventing new patterns.

## One control set, everywhere

Mermaid diagram previews in notes and chat use the shared component and toolbar
described in [mermaid.md](mermaid.md); their buttons use `uiBtn sm`.

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

### Control size and text size

Two separate size levers, deliberately not one "zoom":

- **Control size** (Settings / Appearance, `gamma-ui-scale`, a `Stepper` over
  the `UI_SCALE` range in `app/prefs.js`, 70–160 % in 10 % steps) is a CSS
  `zoom` on every button and toggle —
  `:where(button, .uiBtn, .ctlBtn, .uiClose, .switch)` in `shared/styles/app.css` reads
  `--ui-scale` off the root element. Zoom scales the box, its text and its
  SVG icon as one unit, so rows and toolbars just grow to fit; a second rule
  resets the zoom on a control nested in another so it never compounds.
  `index.html` applies the stored value before first paint (like the theme),
  App.jsx keeps the property in sync afterwards. Content — notes, PDF, chat
  text — is untouched.
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

### The share dialog

`sharing/ShareDialog.jsx` (the topbar link button) is the one place a page is
published. It is built exactly like the workspace Manage dialog: a
`SubDialog` of `Section`s — Link (the address as the row hint, Copy link),
General access (`Row`s with a `MenuSelect` for Anyone with the link /
Signed-in users / Only people invited and one for Can view / Can edit, an
amber `.shareWarn` hint when a link is editable without sign-in), People
(`aiProvRow` rows: the owner, then each invited account with its own
`MenuSelect` and a `uiBtn sm iconSq` remove; the section's action opens the
invite sub-dialog: `AccountPicker` + access), the page's Citation section
(App.jsx owns it) and Actions (Reset link, Stop sharing `uiBtn sm danger`).
Every change saves at once; nothing is a bespoke control. The read-only view
shows the counterpart tag ("Can edit · shared by …", and "as <name>" for a
visitor without an account) in its top bar.

## Settings primitives

### Show the result while editing

A setting that changes a visible surface shows one live example of that
surface with its controls beside it. Each control adds, removes or updates
the matching element at once. Reuse the real product component so the
preview stays accurate, and keep its shared styling and states (hover,
shadow, focus). Bespoke CSS around it is layout only. On small screens the
controls go below the preview.

Library Display is the model: one `PageCard` with independent Thumbnails,
Folders and Labels switches. Mutually exclusive palettes (themes) use a set
of miniature cards instead.

The Import and Export dialogs are the other `PictureChoices` surface: format
and source cards grouped by file type (app logos for app formats, the shared
PDF, notes and Markdown icons for document formats, all monochrome at one
size), then a review step whose switches sit beside an illustrative page
(`shared/illustrations/TransferPreview.jsx`, an example of the output, not a
render of the document). The flow and its rules are described in
[import_export.md](import_export.md).

UI illustrations live in [illustrations/](../../frontend/src/shared/illustrations/README.md),
one file per subject: React components for drawings that change with
controls, SVG files for fixed ones, and one shared stylesheet. They reuse
existing icons and widgets; control logic and layout stay with their owners.

Settings panes are built only from
[SettingsKit.jsx](../../frontend/src/settings/SettingsKit.jsx):

- `PaneHead` / `Section` / `Row` / `Toggle`: small icon, readable label, short
  hint and shared control. Rows use the shared hover background without a drop
  shadow. Important effects stay visible; supplementary help uses a hover
  tooltip, without an explicit Details toggle.
- Larger areas (AI, workspace management and administration) get second-level
  navigation with Back to settings. Short pages keep the main sidebar. Search
  opens the relevant page and focuses the matching setting.
- Appearance uses `PictureChoices` theme cards (`uiBtn` + `on`) with small
  decorative SVG palette sketches beside the labels (stacked on narrow
  screens). Its rows are not interactive surfaces, so they suppress the
  shared hover fill; grouped rows use straight dividers. A PDF sample
  reflects the current tint and dark-page switch. Account and browser scopes
  sit beside section headings; the controls are the shared `Row`, `Toggle`
  and `Stepper`.
- Editor dialogs: `SubDialog` › `.settingsForm` › `Step` (numbered wizard
  stages) or `Field` (caption + hint + one control), closed by a
  `.reportModalBtns` footer. Pass the draft to `SubDialog` so unsaved edits are
  protected on Cancel, Escape and backdrop clicks.
- Shared controls: `Segmented` (joined pills for exclusive choices),
  `PictureChoices` (illustrated cards for one exclusive choice: the theme
  cards, the import/export format cards; `onConfirm` fires on double-click),
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
  `CharSlider` (log-scaled character budget), `Stat` and `StatText` (the
  numeric and the text tiles of a `.setStats` grid — the Server dashboard),
  `LogBox` (level badges, an `extra` slot for a filter), `Empty`, `QuotaMeter`.

## Theme

Eight states: System (default, tracks `prefers-color-scheme` live) or pinned
Light/Dark/Gamma Light/Gamma Dark/Sepia/Solarized Light/Gray — `gamma-theme` in
localStorage (valid values are `THEMES` in `app/prefs.js`), applied as
`data-theme` on the root element. The choice (plus
"Flip page colors") also follows the account through `/api/prefs/appearance` —
server wins on login and on window focus, changes push back; localStorage
stays the instant-paint cache the `index.html` script reads. An inline script in `index.html` applies a pinned theme before
first paint; `color-scheme` follows so native controls match. Scrollbars are
themed rather than left to the OS: a global `scrollbar-width: thin` +
`scrollbar-color: var(--scrollbar-thumb) transparent` (with a
`::-webkit-scrollbar` fallback for older WebKit/Blink) in `shared/styles/app.css`.
"Flip page colors" (`gamma-pdf-dark`) is separate and display-only: it
inverts the PDF canvas (`.pdfDark`), swaps highlight blending from multiply
to screen, and darkens the scroller surround.

**Gamma Light** and **Gamma Dark** (`gamma-light`, `gamma-dark`) are the
hero-derived brand themes: warm gray and amber, charcoal and soft gold. They
add `--on-accent` (text on an accent surface) and `--accent-hover`. Gamma
Light joins the light-ground and tinted-surround selector lists below; Gamma
Dark gives the PDF viewer dark pages by default (`[data-theme="gamma-dark"]
.pdfViewer` rules next to `.pdfDark`), so "Flip page colors" adds nothing there.

**Sepia**, **Solarized Light**, and **Gray** are the eye-comfort modes and the themes that reach
the PDF page as well as the chrome. Sepia: warm beige surfaces and dark teal
text (`#073642`). Solarized Light (`solarized`) follows
[VS Code's Solarized Light](https://github.com/microsoft/vscode/blob/main/extensions/theme-solarized-light/themes/solarized-light-color-theme.json):
cream content surfaces (`#fdf6e3`), `#eee8d5` chrome, blue-gray text
(`#657b83`), the stock Solarized accents and Solarized `.hljs-*` token
colors; the desktop shell (`desktop/ui/theme.css`, `desktop/main.js`) and the
`index.html` first-paint background carry the same palette. All three tint
the PDF page the same way:
`[data-theme="sepia"] .pdfViewer:not(.pdfDark)` tints the page by giving the
page wrapper the `--pdf-paper` ground and letting the canvas `multiply` onto
it. Multiply, not a `sepia()`/`hue-rotate` filter: white paper lands exactly
on the ground color while figures only warm slightly. The canvas also gets
`opacity: 0.82` — under multiply that leaves the paper invariant and lifts
only the ink, black → `(1−α)·paper` ≈ `#2e2c29` (~12.6:1), the softened
charcoal the eye-strain guidance recommends over pure black. **Gray** is the
neutral counterpart — the same machinery driven by different tokens
(`--pdf-paper: #f4f4f4`, `#2d2d2d` text ladder, Light's role colors) for
users who want the glare cut without a color cast; the canvas multiply rule
selects `:is([data-theme="sepia"], [data-theme="solarized"], [data-theme="gray"])`
and the viewer surround adds `gamma-light` to that list, so a new tinted theme only
needs a token block plus membership in those lists. The tint needs no prop — `data-theme` is global, so it is pure CSS
— and "Flip page colors" wins when both are on. Light-ground rules select
`:is([data-theme="light"], [data-theme="gamma-light"], [data-theme="sepia"], [data-theme="solarized"], [data-theme="gray"])`;
extend that list, don't add another copy.

## Layout

- Desktop: dockable windows via `react-resizable-panels` **v2** (v4 has an
  incompatible API).
- Phone (< 700 px, or a short coarse-pointer viewport): single full-width
  panel with a bottom tab bar (`useIsPhone`, `.phoneTabBar` / `.phonePanel`).
- View modes come from the URL query, no router lib: `/` home,
  `/?page=<id>` paper, `/?share=<token>` read-only, `/?block=<id>`
  jump-to-block.
- Icons are hand-rolled SVGs in [Icons.jsx](../../frontend/src/shared/ui/Icons.jsx) —
  add there, keep the stroke style.

## File map (frontend/src)

| File | Owns |
|---|---|
| `app/App.jsx` | routing, block-tree editor state, docks, the page's live session glue, AI chat glue (decomposition in progress) |
| `collaboration/usePageCollab.js`, `shared/model/blockOps.js`, `collaboration/Presence.jsx` | the live session (ops out, ops + presence in), the pure tree diff/apply, the avatar stack / row chips ([collab.md](collab.md)) |
| `app/prefs.js` | every localStorage preference (`useAppPrefs`) |
| `settings/SettingsDialog.jsx` + the `settings/Settings*.jsx` panes | the Settings dialog (`SettingsKit.jsx` holds the shared primitives incl. `AccountPicker`, the search-box-over-account-rows people picker, and `LogBox`) |
| `settings/SettingsAppearance.jsx`, `settings/SettingsLibraryDisplay.jsx` | the Appearance pane (theme cards + PDF sample) and Library › Display (a live `PageCard` beside its switches) ([settings.md](settings.md)) |
| `transfers/ImportExport.jsx`, `transfers/transferFormats.js`, `shared/illustrations/` | the Import/Export dialogs, their format/source rules (`resolveExport` / `resolveImport`) and the decorative previews ([import_export.md](import_export.md)) |
| `pdf/pdfCitation.js`, `pdf/PdfCitationOverlay.jsx` | an AI reply's citation link → the quoted passage highlighted on the cited PDF page ([pdf_citations.md](pdf_citations.md)) |
| `shared/lib/canvasSize.js`, `pdf/verticalScrollSnap.js` | the canvas backing-store cap and the one-finger vertical scroll alignment ([pdf_loading.md](pdf_loading.md)) |
| `chat/ChatDock.jsx` | the AI chat panel (incl. agent wiring); header = a `.ctlBtnRow` of `.ctlBtn` icon buttons (the PDF zoom column's buttons laid flat) with the ⚙ settings popover |
| `pdf/PdfViewer.jsx` | the custom pdf.js viewer |
| `ink/ink.js`, `ink/inkStore.js`, `ink/inkInput.js`, `ink/InkLayer.jsx` | handwriting ([handwriting.md](handwriting.md)): the stroke codec + geometry (pure), the files/drafts store, pointer sampling, and the page layer + selection menu + notes card + tool strip (`.pdfInkBar`: `ctlBtn`s and `colorBtn` swatches) |
| `search/SearchPanel.jsx`, `library/librarySearch.js` | workspace search (Ctrl+F) and the title scorer shared with chat |
| `chat/PaperMentionInput.jsx`, `chat/paperMentions.js` | chat mention picker, mention text edits and `MAX_CHAT_REFERENCES` (six attached pages plus the current page) |
| `editor/BlockTree.jsx`, `shared/model/blockModel.js` | outliner rendering / pure tree ops (`shared/model/highlightColors.js` is the highlight palette both share with the viewer). Line breaks in a rendered note: one Enter is a hard line break (`remark-breaks`), one blank line the paragraph break, and every further blank line a visible empty line (`expandBlankLines` in `editor/mdMarks.js`, applied by `mdPreprocess` outside math and code) — what the editor shows is what the note renders |
| `transfers/FileChip.jsx` | the file chip an upload link renders as — a small card (kind icon in a tinted square, name, download arrow), inline so it sits in a sentence, identical for every type; a PDF or markdown chip whose page exists gets an accent "open page" button before the arrow; a `ContextMenu` on right-click with "Open page" / "Add to library" (fed by `FileChipContext` from App and one batched `POST /pages/by-docs` per render) and download; also the shared `postFile` / `uploadFilesAsLines` upload helpers |
| `editor/MdTools.jsx` | in-place tools on rendered notes: `MdImage` (hover toolbar of `ctlBtn` icons — zoom lightbox, caption via alt text, download, delete — plus a drag grip writing the Obsidian `![alt|300]` size; legacy Logseq `{:width N}` reads and normalizes on edit) and `MdTableWrap` (hover "+" strips, column/row handle menus — insert, align, delete — and click-a-cell in-place editing: an input over the cell, Tab/Shift-Tab hop cells across the commit remount via a module-level session map, Enter commits, Esc cancels; tables are never edited as raw markdown — a cell mousedown stops the block row's edit-on-mousedown), backed by pure source transforms (`scanImages`/`scanTables` locate the nth rendered construct; `applyImageEdit`/`applyTableEdit` rewrite it, tables re-serialized pretty-printed; `formatTables` also runs when a block's raw editor closes) and `htmlTableToMarkdown` for the spreadsheet-paste path |
| `editor/BlockCmEditor.jsx` | the CodeMirror 6 block editor (textarea-compatible facade) with live in-place rendering of closed `$…$`/`$$…$$` spans, ``` ``` ``` fences (highlight.js cards), `[[ref]]`/`![[embed]]` chips, `![alt](url)` images (the picture, sized like the rendered view, alt as caption; `scanImageSyntax` in `mdMarks.js` is the one image scanner, shared with `MdTools`), and markdown (headings, `**`/`*`/`` ` ``/`~~`/`==`, links + bare URLs, clickable `- [ ]` checkboxes, `- ` bullets, `---` rules, quote lines and full `> [!type]` callout boxes) — the construct the caret touches stays raw source (line-level touch for heading/quote prefixes, marker-only touch for list markers so a todo's checkbox survives editing its text). Raw math gets VSCode-style bracket-pair colorization (depth-cycled `--bracket-*` colors, enclosing pair boxed). Decorations come from a `StateField`, not a ViewPlugin — plugin decorations may not replace line breaks (multi-line fences/`$$` would throw). Formatting hotkeys: Ctrl/Cmd+B/I/E, Ctrl+Shift+X/H toggle `**`/`*`/`` ` ``/`~~`/`==` Obsidian-style, Ctrl+K inserts `[sel](url)` (clipboard URL fills the slot); swallowed inside math/fences/inline code |
| `editor/mdMarks.js` | the inline-mark table (regex + class per marker) shared by the live renderer and the hotkeys, plus the pure `toggleMark`/`insertLink` transforms (wrap / unwrap / empty pair / per-line for multi-line selections). `scanMarks` allows proper nesting (`**a *b* c**`, `*a **b** c*`; nothing inside inline code) and treats `***x***` as one bold+italic span with two `layers`, so Ctrl+B and Ctrl+I each peel off their own delimiters |
| `editor/SlashMenu.jsx` | the "/" command catalog + popup (link, embed, equations, highlight, headings, to-do, lists, quote, callout, code, divider, table, image, date) and the "Paste as" chooser shown after a URL paste (gamma block link → mention/synced block/URL, other URLs → URL/titled link); blockTree owns trigger detection and key handling |
| `editor/callouts.js` | remark plugin for `> [!note] Title` callouts (type aliases → note/tip/warning/danger/important/quote; colors in app.css) |
| `editor/codeHighlight.js` | fenced ``` ``` ``` code helpers shared by editor + renderer: `scanFences` (region scanner, mirrored in mdPreprocess exclusions and blockTree's Enter/Tab-in-fence handling), `fenceInnerAt`, and the highlight.js (`lib/common`) wrapper; token colors are theme-aware `.hljs-*` rules in app.css |
| `editor/LatexEditor.jsx` | LaTeX aids while editing: viewport-bounded, scrollable live preview, `\command` snippets, argument/Tab-out navigation, `renderKatex`/`useCaretAnchored` shared helpers; `editor/latexInput.js` supplies scalable delimiter pairing. See [LaTeX editing](latex_editing.md) for shortcuts and browser checks |
| `library/libraryUtils.js` | folder-tag semantics (mirrored by `backend/gamma/foldertags.py`) |
| `shared/ui/Widgets.jsx`, `shared/ui/Menus.jsx`, `shared/ui/Icons.jsx` | shared components |
| `shared/ui/menuAim.js` | pointer-trajectory ("safe triangle") hover intent for hierarchical menus — UI-agnostic, consumed by `shared/ui/Menus.jsx` |
