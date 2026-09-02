# Gamma Desktop

The double-clickable app. On first launch it asks whether to run Gamma locally
or connect to a server you already have; in local mode it starts and supervises
the bundled Python backend and shows the library in its own window. It never
opens a browser — only genuinely outbound links you click inside a note.

Design, decisions and phase status: [`docs/dev/client-app.md`](../docs/dev/client-app.md).

## Running from a source checkout

Needs `backend/venv` (or `GAMMA_PYTHON`) and a built frontend:

```sh
npm --prefix ../frontend run build     # once, or after frontend changes
npm install
npm start
```

Useful environment variables:

| | |
|---|---|
| `GAMMA_DATA_DIR` | use a throwaway library instead of the real one |
| `GAMMA_DESKTOP_MODE` | `local` or `remote` — skips the chooser without saving a choice |
| `GAMMA_DESKTOP_SERVER` | the address for `GAMMA_DESKTOP_MODE=remote` |
| `GAMMA_DESKTOP_VERBOSE` | print the backend's output to the terminal |

## Tests

```sh
npm run lint
npm test                  # 11 unit + 7 Electron; add `xvfb-run -a` on headless Linux
```

Every Electron test gets its own `userData` and library directory, so a run can
neither read nor damage a real installation.

## Building

```sh
npm --prefix ../frontend run build
npm run stage             # standalone CPython + site-packages + backend + static
npm run dist              # installers in dist/
```

`npm run stage` installs the backend's dependencies *with the interpreter it
just downloaded*, so the wheels match the target's OS and architecture. That is
why a macOS build has to be made on macOS — see
`.github/workflows/desktop-release.yml`, which does exactly this on a tag and
then runs the test suite against the artifact it produced:

```sh
GAMMA_PACKAGED_APP=dist/mac-arm64/Gamma.app/Contents/MacOS/Gamma npm test
```
