# Polished repository demos

Surveyed 2026-09-15. Question: why do polished project demos feel smoother than
Gamma's existing README GIFs, and what can we reproduce locally?

## What the sources actually show

| Example | Documented technique | Relevance to Gamma |
|---|---|---|
| [Charm's VHS](https://github.com/charmbracelet/vhs) and its [example tapes](https://github.com/charmbracelet/vhs/tree/main/examples) | The README explicitly links its demo's source. Text scripts describe actions, pauses, dimensions and output; examples include Gum, Glow and GitHub CLI. | Keep the storyboard as source. It is easy to rerun a short deliberate sequence when the UI changes. VHS itself records terminals, so Gamma needs browser automation. |
| [Screen Studio](https://screen.studio/) | Documents cursor smoothing, click-focused automatic/manual zoom, framing/shadows, cutting idle time, cursor loop positioning, and video/GIF exports. | The polished appearance comes from motion direction and editing as well as capture quality. These techniques can be reproduced without changing Gamma's UI. Screen Studio itself targets macOS. |
| [Cap](https://github.com/CapSoftware/Cap) and [its documentation](https://cap.so/docs) | The open source project separates quick sharing from Studio Mode with local capture, backgrounds, zooms, trimming and export controls; the desktop app supports Windows/macOS. | A GUI editing option for this Windows workspace. Its published source also separates recording, rendering, and export concerns. |

These are documented production approaches, not evidence that an arbitrary
repository used a particular editor. A finished GIF rarely identifies the tool
that made it; vendor customer logos do not establish how those teams made their
GitHub README assets.

## What made the earlier GIFs look jerky

Low frame rates (10 to 12 fps), blanket 1.35 to 1.7× speed-ups of the whole
recording, and pointer moves split into Playwright steps without a time budget.
A modern-looking demo needs readable composition, consistent motion and a
concise story before decoration. Enlarging a low-rate GIF or converting it to
60 fps cannot recover missing interaction frames.

## Chosen direction and measured result

Keep Playwright because it can reproduce the real app, and borrow the editing
conventions above. Time-paced strokes and eased pointer travel preserve the
meaning of the drawing. Keep the paper, toolbar and note preview visible together.
Capture on an isolated copy of the curated workspace, and validate persistence
after the recorded segment. Do not mock the ink layer or paint a simulated app.

Deliver a single animated WebP per README slot. [Playwright's video documentation](https://playwright.dev/docs/videos)
explains that video dimensions must be configured explicitly and files finalize
when the context closes. The WebP encoder coalesces identical frames without
shortening holds; no frame interpolation is used.

[Google's WebP documentation](https://developers.google.com/speed/webp/faq)
documents animation support in modern Chrome, Edge, Firefox and Safari, and the
format's lossy/lossless choices. Measured on one 9.6-second ink clip at the same
dimensions (2026-09): lossy WebP at quality 85 **1.13 MiB**, GIF **3.33 MiB**,
lossless WebP **3.53 MiB**. A fixed camera keeps the toolbar, paper and note
preview in frame without adding motion to every text pixel.

The delivery rules, the recipe per slot and the published inventory live in
[tools/readme-media/README.md](../../tools/readme-media/README.md) and
[the asset directory](../assets/demos/README.md).

## Abstract SVG scenes next to the recordings (2026-09)

Tried: the same three interactions (annotate + ink, notes with live math,
library search) as animated SVG illustrations in the branding style
(`tools/branding/build-demos.py`), to see whether "showing the idea" can
stand in for a recording.

What works: a scene is ~10 KB against 1–5 MiB per WebP, renders crisp at
any size, needs no server, no demo workspace and no re-recording when the
UI's pixels change — only when the interaction itself changes. SMIL keeps
it a plain `<img>` (GitHub strips scripts and ignores CSS animation inside
an embedded SVG; SMIL plays). Typing is one `<tspan>` per character switched
on in turn (`branding.typewriter()`, a wipe looked like a curtain, not a
keyboard); drawing is `stroke-dashoffset`; a cursor is an `animateTransform`.

What it cannot do: prove the feature exists. A recording shows the real
toolbar, the real latency, the real result; the abstraction shows a claim.
It also cannot show density — a real notes panel is busier than the scene.
Rules from the attempt: every `keyTimes` must end at 1 (a list ending early
silently disables that animation); glyph widths are unknowable (the viewer's
system font draws the text), so the caret hops along estimated advances and
`textLength` squeezes the line to the same estimate; and the less a scene
shows, the better it reads — the annotate scene ended up as one highlighted
line, one note and one stroke.

Decision: keep the recordings in the README, where a visitor decides
whether the product is real, and use the abstract scenes, light only, in
the user guide, where the reader already has the app and wants the idea.
