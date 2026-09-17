# README demos

Published as looping animated WebP images. Recordings, timing manifests and QA
frames live in ignored `artifacts/readme-media/`; scripts and regeneration instructions
live in [tools/readme-media](../../../tools/readme-media/README.md).

All clips are exported at 25 fps; identical frames can be merged with their
duration preserved. Every encoded frame was decoded in Chromium, and sampled
frames were inspected. Ink persistence was also checked after reloading the app.

| Demo | Duration | Dimensions | Size |
|---|---:|---:|---:|
| [annotate-and-ink](demo-annotate-and-ink.webp) | 19.0 s | 1040 x 662 | 2.92 MiB |
| [native-agentic](demo-native-agentic.webp) | 37.6 s | 960 x 612 | 4.52 MiB |
| [connector](demo-connector.webp) | 10.3 s | 1120 x 714 | 2.74 MiB |
| [library](demo-library.webp) | 17.2 s | 1120 x 714 | 4.43 MiB |
| [metadata](demo-metadata.webp) | 13.2 s | 1120 x 714 | 1.10 MiB |
| [notes](demo-notes.webp) | 31.3 s | 1120 x 654 | 1.60 MiB |
| [reference-links](demo-reference-links.webp) | 15.2 s | 1040 x 662 | 4.58 MiB |

All seven animations total **21.89 MiB**. Each animation is below 5 MiB.

The notes animation includes a clipboard image paste and a drag to resize the
picture. The uploaded image and its saved width were checked after reloading.

The README opens with highlighting, a saved annotation, and ink drawing. Its
second animation stays in PDF Chat: a complex question about mechanisms and
evidence, a citation click highlighting its source, and a figure box-selection
followed by another question. Tool steps remain collapsed. Both use real
captured UI; annotation/ink persistence, the exact citation, and both saved PDF
answers with the figure attachment were checked.

The connector animation is retained here but is not displayed in the README,
which uses the connections SVG instead. No MP4 or duplicate GIF versions are published.
