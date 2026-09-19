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

## What limited the old Gamma recordings

The repository itself supplies the comparison: the skill's general recipe used
12 fps, and the reference-links/connector recipes used 10/11 fps. Several sped up
the whole recording by 1.35–1.7×. Cursor scripts split moves into many Playwright
steps but did not explicitly pace those steps in time. Some camera ramps were
linear. Machine-specific browser and ffmpeg paths also made iteration awkward.

Our inference: a modern-looking demo needs readable composition, consistent
motion, and a concise story before it needs more decoration. Enlarging a low-rate
GIF or converting it to 60 fps cannot recover missing interaction frames.

## Chosen direction and measured result

Keep Playwright because it can reproduce the real app, and borrow the editing
conventions above. Time-paced strokes and eased pointer travel preserve the
meaning of the drawing. Keep the paper, toolbar and note preview visible together.
Capture on an isolated copy of the curated workspace, and validate persistence
after the recorded segment. Do not mock the ink layer or paint a simulated app.

Deliver a single animated WebP per README slot. [Playwright's video documentation](https://playwright.dev/docs/videos)
explains that video dimensions must be configured explicitly and files finalize
when the context closes. Record at a matching 1440 x 900 viewport/video size, then
export at 25 fps and normally 1120 pixels wide (1040 for the combined hero and reference-link clips). The WebP encoder coalesces identical frames
without shortening holds. No frame interpolation is claimed.

[Google's WebP documentation](https://developers.google.com/speed/webp/faq)
documents animation support in modern Chrome, Edge, Firefox and Safari, and the
format's lossy/lossless choices. The ink export uses lossy quality 85: the shortened
9.6-second ink clip is **1.13 MiB**, versus **3.33 MiB** for its GIF and **3.53 MiB**
for lossless WebP at the same dimensions. These are measurements of this clip,
not general compression ratios. Encoded frames are checked in Chromium for text
legibility and animation integrity. A fixed camera keeps the toolbar, paper and
note preview in frame without adding motion to every text pixel.

The user requested image-only delivery, so MP4 and superseded GIF copies are
removed. All seven older cases were recorded again because their original raw
videos were unavailable. Keep the recordings and intermediate frames in ignored
scratch storage, and publish only the small images. The paper Q&A and agent
sequences now share one 28.8-second, 2.18 MiB hero, replacing two clips totaling
43.3 seconds and 5.23 MiB. The edit removes model waits and cuts from the paper
to Home for the separate library-wide request. The current inventory and
sizes live in [the asset directory](../assets/demos/README.md).

The implementation and repeatable commands live in
[tools/readme-media/README.md](../../tools/readme-media/README.md).
