---
name: readme-media
description: Regenerate the README screenshots and demo GIFs — login as the curated demo account, drive the UI with Playwright, convert recordings to GIF with Playwright's bundled ffmpeg.
---

# Regenerating README screenshots & demo GIFs

The README's media comes from a **user-curated `demo` account** — real papers,
hand-made highlights, folders, an answered AI chat. Never fabricate content
with synthetic API seeds; it looks fake. The pipeline only *navigates and
records* that account.

## Step 0 — credentials & mode

- Demo credentials: check auto-memory (`gamma-demo-account.md`); if absent,
  ask the user to create the account (`manage.py create-user demo <pw>` or
  admin GUI → Manage users…) and curate it, then save the creds to memory.
- Two modes — pick per artifact:
  - **Stills** → shoot the *real* instance at `:9001`, logged in as demo.
    Screenshots are read-only navigation; safe.
  - **GIFs / anything that clicks, types, or drags** → clone the demo account
    into an isolated instance first (Step 2). Never record mutations against
    the real data.

## Step 1 — login (how automation gets a session)

```bash
JAR=<scratch>/cookies.txt
curl -s -c $JAR -X POST http://127.0.0.1:9001/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"<pw>"}'          # sets `session` cookie
SESSION=$(awk '$6=="session"{print $7}' $JAR)
```

Inject into Playwright: `context.addCookies([{name:'session', value:SESSION,
url:'http://127.0.0.1:9001'}])`. Same flow works on `:9002`.

## Step 2 — isolated clone (GIF mode only)

Launch an isolated stack on **:9002** exactly as in
[.claude/skills/verify/SKILL.md](../verify/SKILL.md) (built frontend, scratch
`GAMMA_DATA_DIR`, `manage.py setup`). Then clone demo into it:

```bash
curl -s -b $JAR http://127.0.0.1:9001/api/export -o $SCRATCH/demo.zip   # from real instance
GAMMA_DATA_DIR=<scratch>/data venv/Scripts/python.exe manage.py create-user demo demopw
curl -s -c $JAR2 -X POST :9002/api/login -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demopw"}'
curl -s -b $JAR2 -X POST :9002/api/import-data -F "file=@$SCRATCH/demo.zip"
```

Now :9002 is a pixel-identical, disposable copy of the showcase workspace.

## House style (match the existing shots)

- **Light theme**: `newContext({colorScheme: 'light', viewport: {width: 1680, height: 1000}})`.
- Several tabs open; Notes panel docked right, Chat below it for annotate shots.
- Wait ~5 s after opening a paper before shooting — pdf.js render + highlight
  overlay placement.
- After every screenshot, **Read the PNG back** and eyeball it: no empty
  panels, no "Loading…", no scrollbar mid-flight, highlights actually visible.

## Shot list (maps 1:1 to README slots)

| File | Content | Route |
|---|---|---|
| `docs/screenshots/01-annotated-pdf.png` | paper with visible highlights + note tree + AI chat showing an answered question | `/?page=<id>` |
| `docs/screenshots/02-home-carousels.png` | home: recently-viewed row, folders, recents feed | `/` |
| `docs/demo-annotate.gif` | select text → color picker → highlight appears as a note → click note jumps PDF back | isolated |
| `docs/demo-chat.gif` | typing a question about the open paper, streamed answer | isolated |
| `docs/demo-library.gif` | drag a paper into a folder, then Ctrl+F lighting up matches | isolated |

GIF slots exist as HTML comments in README.md — when adding one, replace the
comment with `![…](./docs/demo-*.gif)`.

## Recording GIFs

1. Record as video: `browser.newContext({recordVideo: {dir, size: {width: 1280, height: 800}}, ...})`,
   launch chromium with `{slowMo: 150}` so actions are watchable; add
   ~800 ms `waitForTimeout` beats between logical steps. Close the context,
   then `await page.video().path()` → `.webm`.
2. Playwright videos have **no mouse cursor** — inject a fake one before
   navigating:

```js
await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;z-index:99999;width:14px;height:14px;'
    + 'border-radius:50%;background:rgba(0,0,0,.45);border:2px solid #fff;'
    + 'pointer-events:none;margin:-8px 0 0 -8px;transition:transform .05s';
  document.body.appendChild(c);
  addEventListener('mousemove', e => c.style.transform =
    `translate(${e.clientX}px,${e.clientY}px)`, true);
}));
```

   Then drive the pointer with `page.mouse.move(..., {steps: 30})` so the dot
   glides instead of teleporting.
3. Convert with Playwright's **bundled ffmpeg** (nothing to install):

```bash
FF=$(ls "$LOCALAPPDATA"/ms-playwright/ffmpeg-*/ffmpeg-win64.exe | head -1)
"$FF" -y -i in.webm \
  -vf "fps=10,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  -loop 0 docs/demo-annotate.gif
```

   Trim dead air with `-ss <start> -t <len>` before `-i`. Keep each GIF under
   ~8 MB (GitHub caps rendering at 10) — if over, drop to `fps=8` or
   `scale=1000:-1`.

## Full sequence checklist

1. Confirm demo creds; real instance running on :9001.
2. Stills: curl login → Playwright script (cookie inject, light, 1680×1000) →
   shoot 01/02 → Read each PNG to verify → overwrite `docs/screenshots/`.
3. GIFs: export demo → isolated :9002 → import → record with fake cursor →
   ffmpeg convert → check file size → drop in `docs/`, swap the README
   comment slots for real `![…]` references.
4. Kill the :9002 uvicorn, delete the scratch dir.
5. `git add docs/ README.md` and show the user the results before committing.

Gotchas (shared with the verify skill): fnm-managed node needs
`export PATH="$HOME/AppData/Roaming/fnm/aliases/default:$PATH"`; the Ctrl+F
input keeps its previous query (Ctrl+A first); Playwright chromium is cached
in `%LOCALAPPDATA%/ms-playwright`.
