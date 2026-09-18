# Branding artwork

The opening hero is hand-authored vector source:
[`gamma-hero-light.svg`](../../docs/assets/branding/gamma-hero-light.svg) and
[`gamma-hero-dark.svg`](../../docs/assets/branding/gamma-hero-dark.svg).
Edit those directly. The three related illustrations are generated here.

From the repository root (Python uses only its standard library):

```sh
python tools/branding/build-connections.py
python tools/branding/build-workspaces.py
python tools/branding/build-library.py
node tools/branding/render.mjs
```

All generators write light/dark SVGs into `docs/assets/branding/`; `branding.py`
holds what they share (the hero's Gamma mark as a `<defs>` block, the light to
dark palette, the validating writer). The renderer uses the frontend's
Playwright dependency and writes 1920 × 1080 inspection PNGs to ignored
`artifacts/branding/`; `--publish-hero` also refreshes the two published hero
PNGs for store listings. Browser location: see
[artifacts/README.md](../../artifacts/README.md).

The hero-derived Gamma Light and Gamma Dark themes live in the app's
Settings → Appearance; their tokens are in `frontend/src/shared/styles/app.css`.
