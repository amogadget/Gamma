# README media tooling

Record real Gamma interactions; publish small, looping **animated WebP** images.
The production research is in [demo-production.md](../../docs/research/demo-production.md).

| Location | Contents |
|---|---|
| This directory | Recorders, renderers, shared helpers and [shot recipes](WORKFLOW.md) |
| `docs/assets/demos/` | Published WebP animations, one per README slot |
| `docs/assets/screenshots/` | Documentation stills |
| `artifacts/readme-media/` | Ignored workspace export, private build, WebM recordings, timing files and QA frames |
| `.claude/skills/readme-media/SKILL.md` | Agent entry point pointing here |

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

The recorder starts an isolated backend, imports the curated export into a
throwaway account, records, and stops the server using the existing e2e harness.
It selects text, saves a linked annotation, then circles a claim, draws a curved
arrow, and highlights with ink. Slightly uneven paths and paced mouse input give
the marks a handwritten shape. The annotation and four strokes (three pen, one
highlighter) must persist and survive reload. The current edit is 19 seconds.
This demonstrates mouse ink, not hardware pen pressure.

`DEMO_EXPORT` overrides the archive, `MEDIA_SCRATCH` the capture directory, and
`PAGE_ID` the paper ID. The default shot uses the curated atom-arrays paper
`fy0-h_BqOHcH` at 1440 x 900 with Notes open. A different paper or layout needs new
stroke coordinates. `--inspect` saves setup screenshots and layout measurements.
`render-ink.py --scratch PATH --out PATH` overrides render locations.

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

The recorder starts one conversation at Home, zooms in before typing `@`, selects
a real library paper, and asks the agent to search/read a related paper and
compare them. Tool steps stay collapsed. It clicks the answer's actual `p. 1`
link and shows the cited passage highlighted in the PDF, with a final close-up.
It verifies persisted search/read actions, a single question, no expanded tool
steps, and an exact citation match on PDF page 1.
`--inspect` captures the layout without sending AI requests. `GAMMA_MEDIA_DIST`
can point to a private frontend build; only static files are served from that
build, while PDFs and APIs still reach the real Gamma server.

The edit cuts model waits and preserves the recorded interaction speed. The
picker zoom finishes before `@` is typed; the response close-up includes the
citation click, then returns to the whole workspace to establish the opened PDF.
Inspect the timestamps and sample frames after each capture; model timing varies.

## Record the seven suite cases

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
node tools/readme-media/run-case.mjs agent
node tools/readme-media/run-case.mjs metadata
node tools/readme-media/run-case.mjs download-and-chat
node tools/readme-media/run-case.mjs reference-links
node tools/readme-media/run-case.mjs connector
backend/venv/Scripts/python.exe tools/readme-media/render-suite.py all
node tools/readme-media/check-media.mjs
node tools/readme-media/suite-workspace.mjs --remove
```

`run-case.mjs` prepares each case only in that disposable workspace: it clears the
note page, removes a paper that must visibly be fetched, resets tabs, or clears
folders/home chat before the agent shot. Library preparation finds the QEC paper
by arXiv ID; the recorder visits papers to populate real recents/covers. Run
library before reference-links, which removes and fetches that paper again.
A failed recording leaves the workspace available for inspection; remove it after
finishing. Never read account databases for credentials or commit cookies,
passwords, exports, or raw recordings.

## Delivery and review

The first two README slots are `annotate-and-ink` and `native-agentic`.
Re-render either with `render-suite.py <name>`; `all` includes both.
`render-annotate-and-ask.py` is the historical combined edit. Individual `agent`
and `download-and-chat` renders remain scratch previews only. The connector
animation is retained as an asset; the README currently uses the connections SVG.

- Matching 1440 x 900 viewport and video dimensions; light UI and visible cursor.
- Pointer travel is explicitly paced with easing. Ink is sampled along irregular
  freehand paths. Keep typing, drawing and streaming at their recorded speed.
- Trim setup and excess static waits. Use fixed detail crops when helpful; keep
  controls and the result in view. A small neutral frame unifies the clips.
- Export at 25 fps, normally 1120 pixels wide, WebP quality 85 / compression level 6.
  The first two feature clips and reference-link clip use 1040 pixels, quality 75 /
  compression level 4 to fit their size budgets.
  The encoder merges identical frames while preserving their duration.
- Publish only WebP: no MP4 or duplicate GIF. Encode from the source capture or
  lossless intermediate, never from an old GIF. Each image must be below 5 MiB.
- `media_output.py` checks the animation container, frame timing, loop flag and
  size before publishing. `check-media.mjs` then decodes **every encoded frame**
  in Chromium and saves contact sheets in `artifacts/readme-media/qa/` for inspection.

Review the contact sheets and loop playback before updating README links. FFmpeg
builds can encode animated WebP without decoding it, hence the Chromium check.
Timing manifests and render reports stay next to the raw recordings in scratch.

The three `gen-*.py` files are **legacy GIF experiments** with scratch outputs.
Use `render-suite.py` for README assets. `runtime.mjs` resolves Playwright through
the frontend dependency, so no second Node project is needed.
The lower-level recorders expect `session.txt` in
their working directory; the suite runner handles that automatically.
