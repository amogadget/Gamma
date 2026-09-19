# Branding artwork

Authoritative artwork and variant guidance live in
[`design/brand/`](../../design/brand/README.md).

From the repository root:

```sh
node tools/branding/build.mjs          # regenerate all published copies and ledger
node tools/branding/build.mjs --check  # check sources, coverage, hashes, dimensions
node tools/branding/render.mjs         # optional inspection PNGs in artifacts/
```

Generation uses Python 3 (standard library), the frontend's locked Playwright
dependency and its Chromium headless shell. Run `npm ci --prefix frontend`,
then `npx playwright install chromium-headless-shell` from `frontend/`.
Set `PYTHON` if the interpreter has a different name. Rendering is offline;
The logo uses the same Inter/Segoe UI system font stack as the hero.

`build.mjs` distributes canonical artwork, generates README scenes, renders
Store art and hero PNGs, and records provenance. `store-layouts.mjs` owns Store
dimensions and layouts while loading geometry from the canonical sources.
The desktop's `npm run store-art` remains an alias for the unified generation.

Edit hero templates in `design/brand/compositions/`. The other scenes live in
`build-connections.py`, `build-workspaces.py` and `build-library.py`.
Their shared `branding.py` reads `design/brand/marks/favicon.svg` directly,
independent of the hero layout. All main branding headers and Store posters
reuse `design/brand/compositions/logo.svg`. Run the full build after modifying any source.

Consumer copies stay committed at existing paths. The generator does not alter
recordings, screenshots, third-party logos, or frontend theme CSS. The Gamma
Light/Dark app themes remain in `frontend/src/shared/styles/app.css`.
