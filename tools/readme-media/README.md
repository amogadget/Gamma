# README media tooling

Record real Gamma interactions; publish small, looping **animated WebP** images.
The production research is in [demo-production.md](../../docs/research/demo-production.md).

| Location | Contents |
|---|---|
| This directory | Recorders, renderers, shared helpers and [shot recipes](WORKFLOW.md) |
| `docs/assets/demos/` | Published WebP animations, one per README slot |
| `docs/assets/screenshots/` | Documentation stills |
| `tmp/readme-media/` | Ignored workspace export, private build, WebM recordings, timing files and QA frames |
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
npm --prefix frontend run build -- --outDir ../tmp/readme-media/dist
$env:GAMMA_E2E_DIST = (Resolve-Path tmp/readme-media/dist).Path
```

On Unix use `backend/venv/bin/python` and
`export GAMMA_E2E_DIST="$PWD/tmp/readme-media/dist"`.
Initialize fnm normally if Node is not on PATH. If the browser is installed in a
custom cache, set `PLAYWRIGHT_BROWSERS_PATH` for both installation and recording.
The extension recorder needs full Chromium, not just the headless shell.

## Ink demo

```powershell
node tools/readme-media/record-ink.mjs
backend/venv/Scripts/python.exe tools/readme-media/render-ink.py
node tools/readme-media/check-media.mjs ink
```

The recorder starts an isolated backend, imports the curated export into a
throwaway account, records, and stops the server using the existing e2e harness.
It circles a claim, draws a curved arrow, and highlights a sentence in about ten
seconds. Slightly uneven paths and paced mouse input give the marks a handwritten
shape. Four strokes (three pen, one highlighter) must persist and survive reload.
This demonstrates mouse ink, not hardware pen pressure.

`DEMO_EXPORT` overrides the archive, `MEDIA_SCRATCH` the capture directory, and
`PAGE_ID` the paper ID. The default shot uses the curated atom-arrays paper
`fy0-h_BqOHcH` at 1440 x 900 with Notes open. A different paper or layout needs new
stroke coordinates. `--inspect` saves setup screenshots and layout measurements.
`render-ink.py --scratch PATH --out PATH` overrides render locations.

## Re-record the seven earlier cases

The original raw recordings are unavailable; the current deliverables were
captured again from the real app. The suite uses a disposable workspace on the
curated demo account so AI shots can use its configured provider. The extension
uses an isolated server/account because it targets the default workspace.

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

The "Annotate & ask" hero combines the paper Q&A and library-agent recordings.
`render-annotate-and-ask.py` trims their original WebMs into a single sequence:
highlight a passage, show the explanation, then cut to Home for the agent's
request, tool calls and resulting folders. The current edit is 28.8 seconds.
Re-render it alone with `render-suite.py annotate-and-ask`; `all` includes it.
Individual `agent` and `download-and-chat` renders are scratch previews only.
Review the relative edit points if new recordings change the model's timing.

- Matching 1440 x 900 viewport and video dimensions; light UI and visible cursor.
- Pointer travel is explicitly paced with easing. Ink is sampled along irregular
  freehand paths. Keep typing, drawing and streaming at their recorded speed.
- Trim setup and excess static waits. Use fixed detail crops when helpful; keep
  controls and the result in view. A small neutral frame unifies the clips.
- Export at 25 fps, normally 1120 pixels wide, WebP quality 85 / compression level 6.
  The combined hero and reference-link clips use 1040 pixels, quality 75 /
  compression level 4 to fit their size budgets.
  The encoder merges identical frames while preserving their duration.
- Publish only WebP: no MP4 or duplicate GIF. Encode from the source capture or
  lossless intermediate, never from an old GIF. Each image must be below 5 MiB.
- `media_output.py` checks the animation container, frame timing, loop flag and
  size before publishing. `check-media.mjs` then decodes **every encoded frame**
  in Chromium and saves contact sheets in `tmp/readme-media/qa/` for inspection.

Review the contact sheets and loop playback before updating README links. FFmpeg
builds can encode animated WebP without decoding it, hence the Chromium check.
Timing manifests and render reports stay next to the raw recordings in scratch.

All eleven original scripts were moved out of the skill folder. The three
`gen-*.py` files are retained as **legacy GIF experiments**, with scratch outputs;
they are not the current publishing pipeline. Use `render-suite.py` for README
assets. `runtime.mjs` resolves Playwright through the frontend dependency, so no
second Node project is needed. The lower-level recorders expect `session.txt` in
their working directory; the suite runner handles that automatically.
