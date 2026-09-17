# Local artifacts

This directory is ignored except for this guide. Keep executable source in
`tools/`, published media in `docs/assets/`, and disposable test output in `tmp/`.

- `readme-media/`: original WebM recordings, edit/timing JSON, required composite
  backgrounds and the private `demo.zip` workspace export. Regenerate published
  animations with [the media tooling](../tools/readme-media/README.md).
- `readme-media/browsers/`: local Playwright browser installation; set
  `PLAYWRIGHT_BROWSERS_PATH` to this absolute directory when using it.
- `branding/`: generated PNGs for inspecting the SVG illustrations.
- `theme-preview/`: screenshots of the proposed Gamma palette.
- `debug/citation-regression/`: original PDF and extracted text for the citation
  regression already represented in `frontend/tests/fixtures/`.

The previously tracked paper-mentions patch is preserved separately in
[`docs/archive/`](../docs/archive/README.md), so it remains versioned.

Recordings and exports can contain private workspace content. Do not commit
them. Builds, browser profiles, logs, sessions, QA frames and lossless render
intermediates are reproducible and can be discarded after verification.
