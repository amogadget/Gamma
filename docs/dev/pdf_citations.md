# Clickable PDF citations

AI responses can link a passage using ordinary Markdown:

`[p. 3](/?page=GAMMA_PAGE_ID&pdf_page=3&quote=percent-encoded%20verbatim%20passage)`

The physical PDF page is 1-based. Context and `read_page` label physical pages,
including after empty pages and in continued extraction windows. Each context
section supplies its Gamma page ID. Citation guidance also applies with tools
off and custom prompts. Quotes should fit on one page and identify one passage.

The link persists with the response. Clicking opens the library page, waits for
the requested PDF and its text layer, then matches the quote locally. Direct
links work on initial load as well. Only the target PDF page is rendered for
resolution; no full-document scan or server coordinate mapping is required.

`pdfCitation.js` keeps source offsets through Unicode ligature folding,
dehyphenation and whitespace normalization. Fallback passes tolerate differing
spaces and compound-word hyphens that cross line wraps. PDF.js text items are
mapped directly to their rendered spans, preserving empty EOL items and font
geometry. Small, raised multi-digit reference numbers after prose and before
punctuation can be omitted when matching an otherwise exact quote. Baseline
numbers, mathematical signs and single-digit exponents are not discarded.
Missing or repeated passages show a message on the
cited page instead of selecting a guessed match. Scans without a text layer
therefore open the page but cannot highlight text.

`PdfCitationOverlay` uses DOM Range rectangles from the actual PDF.js text
nodes, including partial runs, rather than estimating glyph widths or trusting
PDFium offsets. Percentage rectangles track page size, and completed text-layer
renders trigger recalculation after zoom. Stale document/render work is cancelled.
The overlay ignores pointer input and never enters the annotation or note store.
Escape or the clear-reference button removes it.

Coverage: `frontend/tests/pdfCitation.test.mjs`, the citation scenario in
`frontend/tests/e2e/scenarios/pdf.mjs`, and `backend/tests/test_pdf_citations.py`.
The frontend fixture includes the actual failing PDF.js runs from physical
pages 20–22 of Krantz et al., *A quantum engineer's guide to superconducting
qubits*. `node tests/e2e/pdfCitationPaper.mjs /path/to/1904.06560.pdf` runs the
saved citations against that complete PDF in an isolated browser test.
