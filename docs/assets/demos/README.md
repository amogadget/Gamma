# README demos

Published as looping animated WebP images. Recordings, timing manifests and QA
frames live in ignored `tmp/readme-media/`; scripts and regeneration instructions
live in [tools/readme-media](../../../tools/readme-media/README.md).

All clips are exported at 25 fps; identical frames can be merged with their
duration preserved. Every encoded frame was decoded in Chromium, and sampled
frames were inspected. Ink persistence was also checked after reloading the app.

| Demo | Duration | Dimensions | Size |
|---|---:|---:|---:|
| [annotate-and-ask](demo-annotate-and-ask.webp) | 28.8 s | 1040 x 662 | 2.18 MiB |
| [connector](demo-connector.webp) | 10.3 s | 1120 x 714 | 2.74 MiB |
| [ink](demo-ink.webp) | 9.6 s | 1120 x 714 | 1.13 MiB |
| [library](demo-library.webp) | 17.2 s | 1120 x 714 | 4.43 MiB |
| [metadata](demo-metadata.webp) | 13.2 s | 1120 x 714 | 1.10 MiB |
| [notes](demo-notes.webp) | 26.5 s | 1120 x 488 | 1.03 MiB |
| [reference-links](demo-reference-links.webp) | 15.2 s | 1040 x 662 | 4.58 MiB |

All seven animations total **17.18 MiB**. The seven previous GIFs
totaled **34.02 MiB**; the refreshed set includes the new ink demo.

The combined Annotate & ask clip replaces the separate Q&A and agent demos.
No MP4 or duplicate GIF versions are published.
