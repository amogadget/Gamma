# Branding artwork

The opening hero is hand-authored vector source:
[`gamma-hero-light.svg`](../../docs/assets/branding/gamma-hero-light.svg) and
[`gamma-hero-dark.svg`](../../docs/assets/branding/gamma-hero-dark.svg).
Edit those directly. The related illustrations are generated here, not in `tmp/`.

From the repository root (Python uses only its standard library):

```sh
python tools/branding/build-connections.py
python tools/branding/build-workspaces.py
python tools/branding/build-library.py
node tools/branding/render.mjs
```

Run connections first: the workspace and library illustrations reuse its Gamma mark.
All generators write the light/dark SVGs in `docs/assets/branding/`.
`build-library.py` tells the Link and organize story: automatic metadata on
download, folder/label filtering and search, then a citation jump and Back.
The renderer uses the existing frontend Playwright dependency and writes
1920 × 1080 inspection PNGs to ignored `artifacts/branding/`. Use
`--publish-hero` to refresh the two published hero PNGs for store listings.
If needed, set `PLAYWRIGHT_BROWSERS_PATH` to your browser installation.

The hero-derived Gamma Light and Gamma Dark schemes are available in the app's
Settings ? Appearance. Their tokens live in `frontend/src/shared/styles/app.css`.
