# Repository layout and assets

The deployable applications stay at the repository root. Docker, the local
launcher, and desktop release workflows use these locations.

| Location | Owns |
|---|---|
| `backend/gamma/` | FastAPI application, routers, and backend logic |
| `backend/tests/` | Backend tests using temporary data directories |
| `frontend/tests/` | `node --test` tests of the pure modules; `e2e/` the Playwright browser suite (`npm run e2e`, [debugging.md](debugging.md)) |
| `tests/shared/` | JSON cases for rules mirrored between backend and frontend (search normalization, folder paths), read by both test suites |
| `frontend/src/` | React code grouped by function (`editor/`, `pdf/`, `settings/`, etc.), orchestration in `app/`, reused code/assets in `shared/`; [source map](../../frontend/src/README.md) |
| `frontend/public/` | Files copied as-is into the frontend build |
| `desktop/` | Electron shell and desktop packaging |
| `extension/` | Browser connector, loaded unpacked without a build step |
| `docs/dev/` | Architecture, implementation notes, and plans |
| `docs/research/` | Design research: surveys, findings, and the reasoning behind chosen shapes |
| `docs/user_guide.md` | User documentation |
| `docs/assets/` | Documentation images and animations |
| `tools/readme-media/` | README capture scripts, renderers, and recording recipes |
| `tools/branding/` | Connections/workspace SVG generators, and hero renderer |
| `artifacts/readme-media/` | Ignored media workspace exports, private builds, raw captures, and QA frames |
| `artifacts/` | Ignored local sources and outputs; [retention guide](../../artifacts/README.md) |
| `tmp/` | Disposable test/build scratch only; no maintained source code |
| `data/` | Ignored runtime databases and uploads, controlled by `GAMMA_DATA_DIR` |

Desktop-specific developer documentation remains in `desktop/docs/`.
The [frontend refactor plan](frontend-refactor.md) describes proposed source
folders; those folders have not been created yet.

## Asset ownership

| Location | Contents and consumers |
|---|---|
| `docs/assets/branding/` | Light/dark SVG wordmarks, and the light/dark hero image (`gamma-hero-*.svg`, hand-authored vector; the `.png` renders are for the Microsoft Store listing) used by the root README |
| `docs/assets/demos/` | README demos as small animated WebP images |
| `docs/assets/screenshots/` | Documentation stills; guest welcome blocks reference their GitHub raw URLs |
| `frontend/public/media/icons/` | Favicon, served at `/media/icons/favicon.svg` |
| `desktop/assets/icon.png` | Electron window and installer icon |
| `desktop/assets/entitlements.mac.plist` | macOS signing entitlements |
| `desktop/assets/appx/` | Microsoft Store package tiles, splash screens, and scale variants |
| `desktop/assets/store/` | Store listing artwork and listing text |
| `extension/assets/icons/` | Connector toolbar, manifest, and notification icons |

Keep assets with their consumer so the frontend build and the extension
archive remain self-contained. React SVG components in `frontend/src/shared/ui/Icons.jsx`
and inline shell glyphs remain source code; they are not duplicate image files
to move into a media directory.

The frontend's `/assets/` URL namespace belongs to Vite's generated,
content-hashed bundles. The backend sends those files with an immutable,
one-year cache policy. Unversioned public files belong under `/media/`, sent
`no-cache` with a real `304` on revalidation (`gamma/app.py`).

The pdf.js worker is one of those hashed assets: `frontend/src/pdf/PdfViewer.jsx`
imports `pdfjs-dist/legacy/build/pdf.worker.min.mjs?url`, so it is always the
installed package's legacy build and is cached like the bundle. Nothing to
copy or check when `pdfjs-dist` is upgraded.

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

The recording instructions and helpers live in [tools/readme-media/](../../tools/readme-media/README.md).
`.claude/skills/readme-media/SKILL.md` is a short entry point to that workflow.
Published assets live in `docs/assets/demos/` and `docs/assets/screenshots/`;
raw captures, workspace exports and QA frames stay in ignored `artifacts/readme-media/`.
Keep the README's
relative image links and `backend/gamma/seed.py` screenshot URLs in sync when
renaming media. New guest pages use the seed URLs; existing guest pages pick
up changes on their next reset. Existing user-authored links are not rewritten.
GitHub raw URLs reflect the published repository, so moved screenshots become
available there once the asset changes reach `main`.
