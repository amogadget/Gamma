---
name: readme-media
description: Regenerate the README screenshots and demo GIFs — login as the curated demo account, drive the UI with Playwright, convert recordings to GIF with a pip-installed static ffmpeg (Playwright's bundled one can't encode GIFs).
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
  - **GIFs / anything that clicks, types, or drags** — the demo account is a
    disposable showcase, so recording straight against `:9001` is usually fine
    (the new highlight/paper/chat just enriches it) **and** keeps the live AI
    keys working, which the chat GIF needs. That's what was used for
    `demo-download-and-chat.gif`. Only clone into an isolated instance (Step 2) when you
    must guarantee zero mutation to the demo workspace — and note the clone
    preserves AI providers, since they live in the exported `data.db`.

## Step 1 — login (how automation gets a session)

Log in through the **API** with the demo password — the session cookie it sets
is what Playwright reuses. Do **not** try to mint a session token (or read
users.db) by opening the SQLite file directly: the safety classifier blocks
sqlite writes/reads to `users.db` as credential tampering, and it can't tell a
demo shortcut from the real thing. So you need the password (memory / ask).

```bash
JAR=<scratch>/cookies.txt
curl -s -c $JAR -X POST http://127.0.0.1:9001/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"<pw>"}'          # sets `session` cookie
SESSION=$(awk '$6=="session"{print $7}' $JAR)         # 43-char token, col 7 of the jar
curl -s -b $JAR :9001/api/ai/models                   # confirm AI is configured (chat GIFs need it)
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
| `docs/demo-download-and-chat.gif` | open paper by URL (pasted) → drag-select the abstract sentence → ask the AI briefly, watch the answer stream (the README **hero** GIF, first image) | `:9001` |
| `docs/demo-reference-links.gif` | atom-arrays paper, page 3: click the tiny "36" citation once → jumps to the reference → select just the "36." number → click its arXiv link → **Fetch into Gamma**. Recorded at normal scale; a smooth **camera zoom** (post-process, `gen-zoom.py`) magnifies the citation+reference — the page itself never zooms (README "Link and organize" section) | `:9001` |
| `docs/demo-library.gif` | drag a paper into a folder, then Ctrl+F lighting up matches | isolated |

GIF slots exist as HTML comments in README.md — when adding one, replace the
comment with `![…](./docs/demo-*.gif)`. Each GIF has its own checked-in
recorder next to this file: [record-download-and-chat.mjs](./record-download-and-chat.mjs),
[record-reference-links.mjs](./record-reference-links.mjs) (paired with
[gen-zoom.py](./gen-zoom.py), which applies its camera zoom).

## Driving the UI (selectors that work)

Verified against the current build — the checked-in recorders (above) are the
starting point; copy one to a scratch dir (each expects `session.txt` next to
it and writes the webm path to `video_*.txt`) and adapt.

  Make it look human: **paste** long inputs (`page.fill`, one shot) rather
  than `type`-ing char by char, and use a **real mouse drag** for selection
  (below), not an instant programmatic one.
- **Open a paper by URL**: click `[aria-label="Add"]`, click then
  `page.fill('.addPopover input.searchInput', URL)` — a paste, not per-key
  typing (scope to `.searchInput`; the popover also has a hidden file
  `<input>`), press Enter. Wait for `[data-page="1"] .textLayer span` (up to
  60 s — real download + render), then ~3.5 s more for paint.
- **Highlight a specific sentence**: a **real click-drag works** and looks
  natural — find the start/end `.textLayer span`s by their text, get the
  client rects of the first/last chars, then `mouse.move`(start) → `mouse.down`
  → `mouse.move` through a waypoint → `mouse.move`(end) → `mouse.up`. Native
  selection follows text order so start→end spans exactly the sentence across
  lines. The viewer's own `mouseup` handler then shows the color popup
  `.plainTip`; click `.plainTip .colorBtn` (first swatch = yellow) — it commits
  on `mousedown`. Keep a **fallback**: after `mouse.up`, if
  `getSelection().toString()` doesn't contain the expected words, set an exact
  `Range` and `document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))`.
  (Don't mousedown anywhere outside `.plainTip` before picking a color — that
  handler clears the selection.)
- **Ask the AI**: the NOTES + CHAT docks are open by default (right column).
  Type into `.chatInput`, press Enter (Shift+Enter = newline). Wait for
  `.chatBubbleRow.ai` and poll its `innerText.length` until it stops growing
  (streamed answer). User bubbles are `.chatBubbleRow.user`.
- **Native PDF links (citations / DOIs / arXiv)**: rendered as `.pdfLinkBox`
  overlays, one per link, each carrying a `title` — internal citation links
  read `"Jump to reference"`, external links read their URL (e.g.
  `https://arxiv.org/abs/0904.2557`). That title is how you pick the right one.
  To click a specific citation number, find the `.textLayer span` containing it
  (e.g. `"36,37"`), then the `Jump to reference` box overlapping its left edge
  (leftmost = the first number). `page.mouse.click(centerX, centerY)` fires the
  jump — `goToDest` scrolls to the reference (a global **← Back** `.navBackBtn`
  appears if you want to return). Clicking an external `.pdfLinkBox` (a URL not
  already in the library) opens the **External link** modal `.confirmModal` →
  click `button:has-text("Fetch into Gamma")` to resolve+open it as a new paper.
  Scroll a citation into view with `span.scrollIntoView({block:'center'})`
  first — page 3's text sits well below the fold after `[data-page="3"]`
  scrollIntoView. To click an external link reliably, fire its DOM `el.click()`
  (React onClick) rather than `mouse.click(coords)`.
- **Zoom = a post-process CAMERA zoom, NOT the app's zoom.** Do **not** zoom
  Gamma itself (wheel/`[aria-label="Zoom in"]`) — at high app zoom the 2-column
  reference page reflows and horizontal-scrolls, which is jumpy and moves your
  click targets. Instead record at **normal scale** (stable) and animate a
  smooth zoom on the GIF afterwards with ffmpeg `zoompan`. The recorder
  (`record-reference-links.mjs`) captures the ROI screen-centers (citation
  `R1`, reference `R2`) and time marks to `links_zoom.json`; `gen-zoom.py`
  turns that into a zoom that ramps in → holds → ramps out, over a window
  centred on the midpoint of R1/R2 and sized to contain both (so one fixed
  camera covers citation, reference, and the centred fetch modal). Both ROIs
  must be scrolled to the same vertical center so they share the window.
  - **recordVideo size MUST equal the CSS viewport** (`{1440,900}`), not 2×.
    `deviceScaleFactor:2` already renders sharp; a 2× recordVideo size
    mis-maps the frame (content ends up in a sub-rectangle) and every crop
    coordinate is wrong. CSS px then equal video px 1:1.
  - zoompan zooms a crop of the frame, so it upscales ~1.15× at the GIF width —
    slightly softer than the app's own re-render, but avoids all the reflow.
- **Selecting a tiny target** (e.g. just the "36." reference number to make the
  reference obvious): a real mouse drag over a few-px span anchors unreliably
  and can select the whole page — set an exact programmatic `Range` on that
  span's text node (`removeAllRanges()`, `addRange`, dispatch `mouseup`); it
  paints the blue selection fine. Selecting also drops a "Selection" chip into
  the chat input (harmless).
- **Trim the loading pre-roll**: the GIF should start on the action. The
  recorder stamps the video-time of the first meaningful step (`m0` in
  `links_zoom.json`); `gen-zoom.py` trims to `m0 - 0.5` via the `trim` filter.
- **Gotcha — "Fetch into Gamma" only shows if the paper isn't already in the
  library**: `handleDocLink` opens an existing paper directly (no modal). Every
  successful fetch adds the target, so **before each links run** delete the
  stray fetched page (`DELETE /api/blocks/{id}` for the one whose `source_url`
  contains the arXiv id) and reset `open-tabs` (`PUT /api/prefs/open-tabs`,
  value is a list of `{id,title}`) — otherwise the modal never appears and the
  arXiv click times out. Clean up the same way *after* recording so the demo
  stays pristine.
- **Gotcha — load detection after a fetch**: pages are virtualized, so
  `[data-page="1"]` may be unmounted; don't detect the fetched paper by diffing
  page-1 text (false negative). Poll `location.search`'s `block` param instead —
  it changes to the new paper's id when `openPdf` runs.
- **House style used**: `colorScheme:'light'`, viewport `1440×900`,
  `deviceScaleFactor:2`, `slowMo:60`, ~0.5–1 s beats between steps.

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
3. Convert with a **real ffmpeg**. Playwright *does* bundle an ffmpeg
   (`%LOCALAPPDATA%/ms-playwright/ffmpeg-*/ffmpeg-win64.exe`) but it is a
   stripped screencast build — only the `webm` and `image2` muxers, **no gif
   encoder, and image2 can only write a single frame** (`-vframes 1`), not a
   `%04d` sequence. Don't try to make a GIF with it. There's no system ffmpeg
   / ImageMagick / gifski here either, so pull a full static ffmpeg via pip
   into the backend venv (isolated, one-time):

```bash
cd backend && venv/Scripts/python.exe -m pip install -q imageio-ffmpeg
FF=$(venv/Scripts/python.exe -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())")
"$FF" -y -i in.webm \
  -vf "setpts=PTS/1.35,fps=12,scale=1040:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 out.gif
```

   `setpts=PTS/N` speeds the clip up by N× — essential because real PDF
   download + AI latency make the raw capture long (a raw ~34 s clip → ~25 s
   at 1.35×, still readable). Keep each GIF under 10 MB (GitHub's render cap):
   at 1040px/12fps/160-colors a ~25 s clip lands ~6.5 MB. If over, raise the
   speed-up, drop to `scale=960`, `fps=10`, or `max_colors=128`. The Windows
   ffmpeg accepts Git-Bash `/c/...` and `/d/...` output paths.
   To sanity-check a frame, extract one PNG (`"$FF" -ss <t> -i out.gif
   -vframes 1 frame.png`) and Read it.

## Full sequence checklist

1. Confirm demo creds (memory/ask); real instance running on :9001; API login
   works and `/api/ai/models` shows `enabled:true`.
2. Stills: curl login → Playwright script (cookie inject, light, 1680×1000) →
   shoot 01/02 → Read each PNG to verify → overwrite `docs/screenshots/`.
3. GIFs: record against :9001 with the fake cursor (or clone to :9002 first if
   zero-mutation is required) → get `.webm` → pip-install `imageio-ffmpeg` →
   convert with speed-up + palette → Read a sampled frame → check size < 10 MB
   → drop in `docs/`, swap the README comment slot for a real `![…]` reference.
4. If a :9002 clone was used, kill its uvicorn. Delete the scratch dir.
5. `git add docs/ README.md` and show the user the results before committing.

Gotchas (shared with the verify skill): fnm-managed node needs
`export PATH="$HOME/AppData/Roaming/fnm/aliases/default:$PATH"`; the Ctrl+F
input keeps its previous query (Ctrl+A first); Playwright chromium is cached
in `%LOCALAPPDATA%/ms-playwright`.
