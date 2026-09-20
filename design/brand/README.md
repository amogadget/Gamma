# Gamma brand sources

Edit brand artwork here, then run from the repository root:

```sh
node tools/branding/build.mjs
node tools/branding/build.mjs --check
```

Generation needs Python 3 and the frontend's locked Playwright dependency:
`npm ci --prefix frontend`, then `cd frontend` and
`npx playwright install chromium-headless-shell`. The check needs only Node.
The generator runs offline using the hero's system font stack. Commit the
updated sources, consumer outputs and `generated.json` together. Normal builds
and unpacked extension installs use committed outputs; they need no generator.

## Source ownership

| Source | Purpose |
|---|---|
| `marks/favicon.svg` | The only editable Gamma mark, used for every icon and composition |
| `compositions/` | Hero layouts and the shared Gamma PDF logo layout |
| `tokens.json` | Brand palette and typography reference; Store background is consumed directly |

Open `marks/favicon.svg` in a browser or SVG editor to edit the mark. Keep the
32 by 32 viewBox and the `gamma-background` ID on its background rectangle:
the generators use that ID to omit the plate for monochrome masks and the
transparent Windows tiles (`Square150x150Logo` and friends, which the MSIX
manifest's `backgroundColor` paints instead). Geometry, stroke weights and icon colors come from this file.

The generator changes only size, positioning and presentation. Desktop, MCP,
plugin and extension icons share the same amber design. Disabled extension
icons are generated in grayscale. The Gamma PDF logo and README illustrations embed the
same mark; Store layouts control padding and transparent/full-bleed backgrounds.
There are no separate vector or raster icon masters to synchronize.

The main logo matches the hero: bold Gamma plus amber PDF, using the hero's
Inter/Segoe UI font stack. Store posters and all README headers reuse this logo. The amber accent is
`#e8a020`, the dark plate `#1e1e1c`, and the warm foreground `#eeebe4`.
SVG artwork retains its explicit colors for portability; when changing the
palette, update the reference tokens and relevant vector sources together.
These brand tokens do not replace the app's independent theme tokens.

Use `docs/assets/branding/gamma-logo.svg` for the standalone logo on light
backgrounds. Its layout is shared with all README headers and Store posters; edit
`compositions/logo.svg` to change it. The unused Gamma/PDF Annotator wordmarks
and their templates have been removed.

## Published copies and provenance

`outputs.json` maps direct copies and SVG templates to existing consumer paths.
Store sizes/layouts live in `tools/branding/store-layouts.mjs`; README scenes
remain in the three Python illustration generators. `generated.json` records
every generated destination, recipe, dimensions and SHA-256, plus hashes of
the sources and rendering toolchain. Do not edit this ledger manually.

`--check` detects missing/modified outputs, changed inputs, missing manifest
destinations and unregistered assets in managed directories without rendering.
It normalizes text line endings for Windows/Linux checkouts. It verifies the
recorded generation state, not pixel reproducibility across operating systems;
review regenerated images before committing renderer or font updates.

Published paths stay unchanged: `docs/assets/branding/`, the frontend favicon,
mask and home-screen icons (full-bleed plates through the `bleed` option,
[docs/dev/ipad.md](../../docs/dev/ipad.md)), desktop resources, extension icons, backend MCP icon and plugin icon.
They are generated copies because each package must remain self-contained.
Use this pipeline to supply brand assets to a future `site/` directory too.

Screenshots and recordings remain in `docs/assets/`; third-party logos and
licenses remain with the frontend; UI glyphs and React illustrations remain
code. Preview renders belong in ignored `artifacts/branding/`.

Removed during consolidation: unused disabled connector icons at 48/128px,
the README's superseded connector animation, and old local inspection PNGs.
The 16/32px disabled icons are still required by the extension toolbar.
