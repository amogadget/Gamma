# UI design conventions

The rules that keep the frontend looking like one product. New UI should
follow them instead of inventing new patterns.

## One control set, everywhere

Reuse the unified classes; never invent a bespoke style for a control that
already exists. Bespoke CSS classes are for **layout only**.

| Class / component | Use for |
|---|---|
| `uiBtn` (+ `sm`, `on`, `primary`, `danger`, `iconSq`) | every button; `on` = toggled state, `iconSq` = square icon-only |
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

Three states: System (default, tracks `prefers-color-scheme` live) or pinned
Light/Dark — `gamma-theme` in localStorage, applied as `data-theme` on the
root element. An inline script in `index.html` applies a pinned theme before
first paint; `color-scheme` follows so native controls match. Scrollbars are
themed rather than left to the OS: a global `scrollbar-width: thin` +
`scrollbar-color: var(--scrollbar-thumb) transparent` (with a
`::-webkit-scrollbar` fallback for older WebKit/Blink) in `app.css`.
"Flip page colors" (`gamma-pdf-dark`) is separate and display-only: it
inverts the PDF canvas (`.pdfDark`), swaps highlight blending from multiply
to screen, and darkens the scroller surround.

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
| `libraryUtils.js` | folder-tag semantics (mirrored by `backend/gamma/ai_tools.py`) |
| `widgets.jsx`, `menus.jsx`, `icons.jsx` | shared components |
| `menuAim.js` | pointer-trajectory ("safe triangle") hover intent for hierarchical menus — UI-agnostic, consumed by `menus.jsx` |
