# README media tooling

Record real Gamma interactions; publish small, looping **animated WebP** images.
The production research is in [demo-production.md](../../docs/research/demo-production.md).

| Location | Contents |
|---|---|
| This directory | Recorders, renderers, shared helpers and [shot recipes](WORKFLOW.md) |
| `docs/assets/demos/` | Published WebP animations, including the retained connector demo |
| `docs/assets/screenshots/` | Documentation stills |
| `artifacts/readme-media/` | Ignored workspace export, private build, WebM recordings, timing files and QA frames |
| `.claude/skills/readme-media/SKILL.md` | Agent entry point pointing here |

Delivery rules (every renderer applies them; `media_output.py` checks the result):

| Rule | Value |
|---|---|
| Capture | 1440 x 900 viewport = video size, light UI, visible cursor, eased pointer travel |
| Frame | Warm paper `#f6f4ef`, fine card edge `#e3e0d8`, centered capture on a 1728 ? 972 (16:9) canvas; detail crops retain their proportions |
| Edit | trim setup and static waits; never speed up typing, drawing or streaming |
| Export | 25 fps animated WebP, below 5 MiB, no MP4 or GIF copy; encode from the capture or a lossless master |
| Raster | 1120 px wide, quality 85, effort 6; `annotate-and-ink` and `reference-links` 1040 / 75 / 4; `native-agentic` 960 / 65 / 6 |

## Setup

Use the existing frontend dependencies, Playwright Chromium, and the backend venv
with `imageio-ffmpeg`. From the repository root in PowerShell:

```powershell
# Only if dependencies/browser are missing:
npm --prefix frontend ci
npm --prefix frontend exec -- playwright install chromium
backend/venv/Scripts/python.exe -m pip install imageio-ffmpeg

# Prompts for the curated demo password, or accepts DEMO_PASSWORD.
backend/venv/Scripts/python.exe tools/readme-media/export-demo.py

# Avoid replacing a running developer frontend's build.
npm --prefix frontend run build -- --outDir ../artifacts/readme-media/dist
$env:GAMMA_E2E_DIST = (Resolve-Path artifacts/readme-media/dist).Path
```

On Unix use `backend/venv/bin/python` and
`export GAMMA_E2E_DIST="$PWD/artifacts/readme-media/dist"`.
Initialize fnm normally if Node is not on PATH. If the browser is installed in a
custom cache, set `PLAYWRIGHT_BROWSERS_PATH` for both installation and recording.
The extension recorder needs full Chromium, not just the headless shell.

## First demo: highlight, annotate and draw

```powershell
$env:DEMO_EXPORT = (Resolve-Path artifacts/readme-media/demo.zip).Path
$env:MEDIA_SCRATCH = Join-Path (Get-Location) 'artifacts/readme-media/annotate-and-ink'
node tools/readme-media/record-ink.mjs --annotate
backend/venv/Scripts/python.exe tools/readme-media/render-feature-demos.py annotate-and-ink
node tools/readme-media/check-media.mjs annotate-and-ink
```

The recorder starts an isolated backend through the e2e harness, imports the
curated export into a throwaway account, records, and stops the server. It
checks that the annotation and the four strokes survive a reload.

`DEMO_EXPORT` overrides the archive, `MEDIA_SCRATCH` the capture directory, and
`PAGE_ID` the paper. The stroke coordinates assume the curated atom-arrays paper
at 1440 x 900 with Notes open. `--inspect` saves setup screenshots and layout
measurements. `render-ink.py --scratch PATH --out PATH` renders the ink-only
capture (no annotation) to `demo-ink.webp`.

## Second demo: native agentic

Use the demo account's configured AI provider and a disposable workspace. Set
`DEMO_PASSWORD` in the environment without logging it. Then:

```powershell
$env:MEDIA_SCRATCH = Join-Path (Get-Location) 'artifacts/readme-media/revised'
node tools/readme-media/suite-workspace.mjs
node tools/readme-media/record-native-agentic.mjs
backend/venv/Scripts/python.exe tools/readme-media/render-feature-demos.py native-agentic
node tools/readme-media/check-media.mjs native-agentic
node tools/readme-media/suite-workspace.mjs --remove
Remove-Item Env:MEDIA_SCRATCH
```

The recorder verifies the exact citation match, both saved answers, the saved
figure image and the PDF context on both AI requests. `--inspect` captures the
layout without sending AI requests. `GAMMA_MEDIA_DIST` points at a private
frontend build; only its static files are served, PDFs and APIs still reach the
real server. The render cuts model waits and keeps fixed close-ups on the
questions, answer and citation. Model timing varies, so inspect the timestamps
and sample frames after each capture.

## Take notes: paste and resize a picture

After building the private frontend above, run:

```powershell
node tools/readme-media/run-case.mjs notes
backend/venv/Scripts/python.exe tools/readme-media/render-suite.py notes
node tools/readme-media/check-media.mjs notes
```

Notes uses an isolated server and imports `artifacts/readme-media/demo.zip`;
it needs no demo login or suite workspace. The recorder checks the pasted image
and its saved width after a reload.

## Record the published suite cases

The suite uses a disposable workspace on the curated demo account so AI shots
can use its configured provider. The extension uses an isolated server/account
because it targets the default workspace.

Set `DEMO_PASSWORD` in the shell without committing or logging it; `BASE_URL`
defaults to `http://127.0.0.1:9001`, and `DEMO_USER` to `demo`. Then:

```powershell
node tools/readme-media/suite-workspace.mjs
# Run sequentially: scenarios change the disposable library.
node tools/readme-media/run-case.mjs notes
node tools/readme-media/run-case.mjs library
node tools/readme-media/run-case.mjs metadata
node tools/readme-media/run-case.mjs reference-links
node tools/readme-media/run-case.mjs connector
backend/venv/Scripts/python.exe tools/readme-media/render-suite.py all
node tools/readme-media/check-media.mjs
node tools/readme-media/suite-workspace.mjs --remove
```

`run-case.mjs` prepares each case in that disposable workspace: it clears the
note page, removes a paper that must visibly be fetched, or resets tabs. Run
library before reference-links, which removes and fetches the QEC paper again.
A failed recording leaves the workspace available for inspection; remove it
after finishing. Never read account databases for credentials or commit
cookies, passwords, exports, or raw recordings.

## Delivery and review

`render-suite.py <name>` re-renders one published slot; `all` renders every
slot, including `annotate-and-ink` and `native-agentic`. The connector
animation is published but the README shows the connections SVG instead.

`media_output.py` checks the animation container, frame timing, loop flag and
size before publishing. `check-media.mjs` then decodes every encoded frame in
Chromium (FFmpeg builds can encode animated WebP without decoding it) and saves
contact sheets in `artifacts/readme-media/qa/`. Review the contact sheets and
loop playback before updating README links. Timing manifests and render reports
stay next to the raw recordings in scratch.

## Optional experiments

The retained `agent` and `download-and-chat` cases need the account's AI
provider. They are not part of README production: `render-suite.py` writes
their renders as `preview.webp` next to the capture, and no README slot uses
them. The ink-only renderer and the three `gen-*.py` GIF experiments are also
retained for reuse; the GIF experiments write to scratch and have no callers.

`runtime.mjs` resolves Playwright through the frontend dependency,
so no second Node project is needed, and holds the recorders' shared pieces:
`BASE`, `readSession`, the cursor dot, paced pointer travel and the curated
page ids.
