# Shot recipes

Start with [README.md](README.md) for setup, recording and WebP delivery. These
recipes describe the real interactions; selectors and timing marks live in the
corresponding recorder. The source workspace must be the user-curated demo
library. Use its exported copy for recording, not synthetic replacement papers.

| Demo | Story | Recording details |
|---|---|---|
| Highlight, annotate & draw | Select a sentence, save a text annotation, circle a claim, draw an arrow, highlight with ink | `record-ink.mjs --annotate`; isolated server, note and four strokes checked after reload; `render-feature-demos.py annotate-and-ink` |
| Native agentic | One PDF Chat: ask a complex mechanism/evidence question, follow a passage citation, box-select Figure 1c,d and ask a follow-up | `record-native-agentic.mjs`; real model responses and Ctrl-drag; exact citation, PDF context, both saved answers and figure attachment verified; `render-feature-demos.py native-agentic` trims model waits |
| Notes | Type markdown, a page reference, nested display math with autocomplete, a callout, then paste and resize a picture | `run-case.mjs notes`; isolated copy of the curated export; real clipboard PNG paste and edge drag; image and width checked after reload |
| Library | Home search, title and PDF results, folder filter, open a highlighted match | `record-library.mjs`; prepare Quantum subfolders, populate recents by navigation; QEC paper must exist |
| Historical agent source | Ask to organize papers, show real tool calls and the resulting folders | `record-agent.mjs`; clear folders and home chat in the disposable workspace first; requires configured AI; scratch preview |
| Metadata | Fetch a paper, watch fields fill, copy BibTeX and slide citation | `record-metadata.mjs`; remove arXiv 2312.03982 before recording; never fill metadata by hand |
| Historical Q&A source | Paste Attention paper URL, select and highlight a sentence, ask for a short explanation | `record-download-and-chat.mjs`; remove the paper before recording; requires configured AI; scratch preview |
| Reference links | Click citation 36, jump to its reference, fetch the linked paper | `record-reference-links.mjs`; remove arXiv 0904.2557 so Fetch appears; fixed detail crop includes the citation and modal |
| Connector | arXiv page, real extension popup, choose folder, save, open in Gamma | `record-connector.mjs`; full Chromium with the unpacked extension; popup opened through its `?tab=` hook and composited over the actual arXiv frame; only the popup is enlarged |

## Details that matter

- Log in through `/api/login` and reuse its session cookie. Never mint sessions
  or inspect `users.db`. Source account credentials may be in project memory;
  otherwise ask for the demo login.
- AI configuration belongs to the account, not the exported workspace. AI cases
  use a disposable personal workspace on the existing demo account. Ink and
  connector use isolated accounts because they need no AI.
- Keep `recordVideo.size` equal to the CSS viewport. `deviceScaleFactor: 2` does
  not mean the recording dimensions should double.
- Move the pointer with timed samples. Playwright `steps` alone does not specify
  motion duration. `runtime.mjs` paces legacy recorder moves.
- Use real mouse drags for sentence highlights. PDF text spans provide start/end
  character coordinates; commit with `.plainTip .colorBtn` before clearing the
  selection. A tiny reference number can use an exact DOM Range when dragging
  would select surrounding text. Dismiss its color popup before clicking Fetch.
- Native citation overlays are `.pdfLinkBox`, with titles such as `Jump to
  reference` or the target URL. Scroll the citation and its destination into a
  consistent part of the frame before choosing a detail crop.
- PDF pages are virtualized. After fetching, check the new URL's `page` or `block`
  ID, then wait for text to paint. An old page-1 selector can remain absent when
  the reader restores a later page.
- Zoom the recorded frame if needed, not the app's PDF zoom: app zoom changes
  wrapping and click coordinates. The current exports use stable detail crops.
- Metadata must resolve on camera. Cached papers cannot reproduce the fetching
  state; prepare a fresh fetch in the disposable workspace.
- The notes editor uses actual keyboard input for autocomplete and argument hops.
  Backslashes must reach CodeMirror literally; Enter/Tab nesting and blur produce
  the rendered result.
- Timing JSON and source-path files are scratch artifacts. `render-suite.py`
  trims those marks and keeps a short hold at the end of each visible outcome.

## Stills and historical renderers

`shoot-stills.mjs` navigates the curated demo to capture the annotated PDF, home,
and library search for documentation. Read each image back and check that the
paper and highlights have painted, panels are useful, and no loading state remains.

`gen-conn.py`, `gen-meta.py`, and `gen-zoom.py` preserve the earlier GIF/camera
experiments. Their old frame rates and timing recipes are historical; use the
current WebP renderers for publication. They write to scratch so running a legacy
experiment does not recreate superseded assets in `docs/assets/demos/`.
