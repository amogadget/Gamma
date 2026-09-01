# UI design conventions

The rules that keep the frontend looking like one product. New UI should
follow them instead of inventing new patterns.

## One control set, everywhere

Reuse the unified classes; never invent a bespoke style for a control that
already exists. Bespoke CSS classes are for **layout only**.

| Class / component | Use for |
|---|---|
| `uiBtn` (+ `sm`, `on`, `primary`, `danger`, `iconSq`) | every button; `sm` is the shared 28 px compact size, `on` = toggled state, `iconSq` = square icon-only (combine with `sm` for compact toolbars) |
| `uiClose` (+ `uiCloseSm`/`uiCloseLg`) | every × close button |
| `aiKeyInput` | every text/number/password input in dialogs and settings |
| `switch` / `switchTrack` | every on/off toggle |
| `MenuSelect` / `ActionMenu` ([menus.jsx](../../frontend/src/menus.jsx)) | every dropdown: Codex-style pill trigger + checkmarked `ContextMenu`. No native `<select>` anywhere |
| `MenuItem` / `MenuLabel` / `SubMenuItem` ([menus.jsx](../../frontend/src/menus.jsx)) | every row inside a menu: icon column + ellipsizing label (+ `danger`, `trailing`). `SubMenuItem` is the nested flyout — hover-opened, safe-triangle guarded |
| `categoryTag`, `uiTag` | chips and small badges |

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

## Settings primitives

Settings panes are built only from
[settingsKit.jsx](../../frontend/src/settingsKit.jsx):

- `PaneHead` › `Section` › `Row` / `Toggle` — a pane is a stack of sections,
  a section a stack of rows: icon · label · one short hint · control. Nothing
  expands inline between rows; the long explanation lives in the row's
  `title` attribute (hover only).
- Editor dialogs: `SubDialog` › `.settingsForm` › `Step` (numbered wizard
  stages) or `Field` (caption + hint + one control), closed by a
  `.reportModalBtns` footer.
- Shared controls: `Segmented` (joined pills for exclusive choices),
  `UnitInput` (number + unit suffix — units never live in labels),
  `CharSlider` (log-scaled character budget), `Stat`, `Empty`, `QuotaMeter`.

## Theme

Four states: System (default, tracks `prefers-color-scheme` live) or pinned
Light/Dark/Sepia — `gamma-theme` in localStorage (valid values are `THEMES`
in `prefs.js`), applied as `data-theme` on the root element. An inline script
in `index.html` applies a pinned theme before
first paint; `color-scheme` follows so native controls match. Scrollbars are
themed rather than left to the OS: a global `scrollbar-width: thin` +
`scrollbar-color: var(--scrollbar-thumb) transparent` (with a
`::-webkit-scrollbar` fallback for older WebKit/Blink) in `app.css`.
"Flip page colors" (`gamma-pdf-dark`) is separate and display-only: it
inverts the PDF canvas (`.pdfDark`), swaps highlight blending from multiply
to screen, and darkens the scroller surround.

**Sepia** is the eye-comfort mode and the one theme that reaches the PDF
page as well as the chrome: its tokens are Solarized Light (warm cream ground
`#fdf6e3`, charcoal-teal text, Solarized accents darkened where a token is
used as text — the stock accents sit near 3:1 on cream), and
`[data-theme="sepia"] .pdfViewer:not(.pdfDark)` tints the page by giving the
page wrapper the `--pdf-paper` ground and letting the canvas `multiply` onto
it. Multiply, not a `sepia()`/`hue-rotate` filter: white paper lands exactly
on the ground color while figures only warm slightly. The canvas also carries
`opacity: var(--pdf-ink-alpha)` (0.82): under multiply that leaves the paper
invariant and lifts only the ink, black → `(1−α)·paper` ≈ `#2e2c29` (measured
12.9:1 against the ground, against a 7:1 AAA bar), the softened charcoal the
eye-strain guidance recommends over pure black; colour washes ~18%. The
translated view's text is a DOM layer that never passes through the blend, so
it sets that ink colour directly. The tint needs no prop — `data-theme` is global, so it is pure CSS
— and "Flip page colors" wins when both are on. Light-ground rules that were
`[data-theme="light"] …` are now `:is([data-theme="light"], [data-theme="sepia"])`;
extend that list, don't add a third copy.

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
| `App.jsx` | routing, block-tree editor state, docks, autosave, AI chat glue (decomposition in progress) |
| `prefs.js` | every localStorage preference (`useAppPrefs`) |
| `settings.jsx` + `settingsKit/Ai/Users.jsx` | the Settings dialog |
| `chatDock.jsx` | the AI chat panel (incl. agent wiring) |
| `pdfViewer.jsx` | the custom pdf.js viewer |
| `search.jsx` | workspace search (Ctrl+F) |
| `blockTree.jsx`, `logseqPdfModel.js` | outliner rendering / pure tree ops |
| `blockCmEditor.jsx` | CodeMirror 6 block editor with a textarea-compatible facade and live math, `[[ref]]`, Markdown, task, and callout decorations; the construct touched by the caret stays as editable source |
| `slashCommands.js`, `slashMenu.jsx` | pure `/` command catalog and caret-anchored popup; `blockTree.jsx` owns trigger detection and key priority |
| `callouts.js` | remark plugin for `> [!note] Title` callouts and canonical type aliases shared with live editor decorations |
| `latexEditor.jsx` | caret-anchored LaTeX preview/autocomplete plus shared safe KaTeX rendering and popup positioning helpers |
| `libraryUtils.js` | folder-tag semantics (mirrored by `backend/gamma/ai_tools.py`) |
| `widgets.jsx`, `menus.jsx`, `icons.jsx` | shared components |
| `menuAim.js` | pointer-trajectory ("safe triangle") hover intent for hierarchical menus — UI-agnostic, consumed by `menus.jsx` |
