# Repository layout and assets

The deployable applications stay at the repository root. Docker, the local
launcher, and desktop release workflows use these locations.

| Location | Owns |
|---|---|
| `backend/gamma/` | FastAPI application, routers, and backend logic |
| `backend/tests/` | Backend tests using temporary data directories |
| `frontend/src/` | React application and code-defined UI icons |
| `frontend/public/` | Files copied as-is into the frontend build |
| `desktop/` | Electron shell and desktop packaging |
| `extension/` | Browser connector, loaded unpacked without a build step |
| `docs/dev/` | Architecture, implementation notes, and plans |
| `docs/research/` | Design research: surveys, findings, and the reasoning behind chosen shapes |
| `docs/user_guide.md` | User documentation |
| `docs/assets/` | Documentation images and animations |
| `data/` | Ignored runtime databases and uploads, controlled by `GAMMA_DATA_DIR` |

Desktop-specific developer documentation remains in `desktop/docs/`.
The [frontend refactor plan](frontend-refactor.md) describes proposed source
folders; those folders have not been created yet.

## Asset ownership

| Location | Contents and consumers |
|---|---|
| `docs/assets/branding/` | Light/dark SVG wordmarks, and the light/dark hero image (`gamma-hero-*.svg`, hand-authored vector; the `.png` renders are for the Microsoft Store listing) used by the root README |
| `docs/assets/demos/` | README demo GIFs |
| `docs/assets/screenshots/` | Documentation stills; guest welcome blocks reference their GitHub raw URLs |
| `frontend/public/media/icons/` | Favicon, served at `/media/icons/favicon.svg` |
| `frontend/public/vendor/pdfjs/` | Vendored legacy PDF worker, served at `/vendor/pdfjs/pdf.worker.min.mjs` |
| `desktop/assets/icon.png` | Electron window and installer icon |
| `desktop/assets/entitlements.mac.plist` | macOS signing entitlements |
| `desktop/assets/appx/` | Microsoft Store package tiles, splash screens, and scale variants |
| `desktop/assets/store/` | Store listing artwork and listing text |
| `extension/assets/icons/` | Connector toolbar, manifest, and notification icons |

Keep assets with their consumer so the frontend build and the extension
archive remain self-contained. React SVG components in `frontend/src/icons.jsx`
and inline shell glyphs remain source code; they are not duplicate image files
to move into a media directory.

The frontend's `/assets/` URL namespace belongs to Vite's generated,
content-hashed bundles. The backend sends those files with an immutable,
one-year cache policy. Unversioned public files belong under `/media/` or
`/vendor/`, where the backend revalidates them on upgrade.

The PDF worker must match the legacy `pdfjs-dist` build imported by
`frontend/src/pdfViewer.jsx`. When updating it, also check the worker URL in
that file and the preload in `frontend/index.html`.

## Desktop inputs and outputs

`desktop/electron-builder.cjs` explicitly sets `directories.buildResources`
to `assets`. This lets the packager discover `assets/appx/` and the app icon.
Its application file list includes `assets/icon.png` for the Electron window;
Store artwork and signing inputs do not need to ship inside the application.

`npm run store-art` runs `desktop/scripts/store-art.js` and writes the tracked
images in `desktop/assets/store/` and `desktop/assets/appx/`. It requires the
existing Windows/Chromium setup described in
[desktop release documentation](../../desktop/docs/release.md).

Generated PyInstaller intermediates remain under `desktop/build/`; frozen
servers, installers, and Store packages go into `dist-backend/`, `dist/`, and
`dist-store/`, respectively. These outputs are ignored. Do not delete
`desktop/assets/` as build cleanup.

## Updating documentation media

The recording instructions and helpers in `.claude/skills/readme-media/`
reference `docs/assets/demos/` and `docs/assets/screenshots/`. Keep the README's
relative image links and `backend/gamma/seed.py` screenshot URLs in sync when
renaming media. New guest pages use the seed URLs; existing guest pages pick
up changes on their next reset. Existing user-authored links are not rewritten.
GitHub raw URLs reflect the published repository, so moved screenshots become
available there once the asset changes reach `main`.
