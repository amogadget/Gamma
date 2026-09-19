# README demos

Published as looping animated WebP images. Recordings, timing manifests and QA
frames live in ignored `tmp/readme-media/`; scripts and regeneration instructions
live in [tools/readme-media](../../../tools/readme-media/README.md).

All clips are exported at 25 fps; identical frames can be merged with their
duration preserved. Every encoded frame was decoded in Chromium, and sampled
frames were inspected. Ink persistence was also checked after reloading the app.

| Demo | Duration | Dimensions | Size |
|---|---:|---:|---:|
| [annotate-and-ink](demo-annotate-and-ink.webp) | 19.0 s | 1040 x 662 | 2.92 MiB |
| [native-agentic](demo-native-agentic.webp) | 35.8 s | 1040 x 662 | 4.06 MiB |
| [connector](demo-connector.webp) | 10.3 s | 1120 x 714 | 2.74 MiB |
| [library](demo-library.webp) | 17.2 s | 1120 x 714 | 4.43 MiB |
| [metadata](demo-metadata.webp) | 13.2 s | 1120 x 714 | 1.10 MiB |
| [notes](demo-notes.webp) | 26.5 s | 1120 x 488 | 1.03 MiB |
| [reference-links](demo-reference-links.webp) | 15.2 s | 1040 x 662 | 4.58 MiB |

All seven animations total **20.86 MiB**. Each animation is below 5 MiB.

The README opens with highlighting, a saved annotation, and ink drawing. Its
second animation shows PDF chat, `@` paper context, library search/read actions,
and camera close-ups of expanded tool outputs. Both use real captured UI;
annotation/ink persistence and saved agent actions were checked.

The connector animation is retained here but is not displayed in the README,
which uses the connections SVG instead. No MP4 or duplicate GIF versions are published.
