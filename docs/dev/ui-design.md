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
| `categoryTag`, `uiTag` | chips and small badges |

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
first paint; `color-scheme` follows so scrollbars and native controls match.
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
