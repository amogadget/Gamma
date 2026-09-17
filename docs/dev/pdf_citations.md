# Clickable PDF citations

AI responses can link a passage using ordinary Markdown:

`[p. 3](/?page=GAMMA_PAGE_ID&pdf_page=3&quote=percent-encoded%20verbatim%20passage)`

The PDF page is physical and 1-based. Context and `read_page` label pages
`[PDF page N]` (blank pages counted, a mid-page continuation labelled
`; continued`) and each context section carries its Gamma page ID
([ai_context.md](ai_context.md)); `routers/ai.py` appends the citation
instruction whenever a document is in context, with tools off and under a
custom prompt too. A quote should fit on one page and identify one passage.

The link is plain Markdown, so it persists with the reply. Clicking it
(`ChatMarkdown` → `onOpenPage(id, citation)`) opens the library page, waits for
that PDF and the cited page's text layer, then matches the quote in the
browser; a pasted link on a cold load works the same way
(`parsePdfCitation` on the initial URL). Only the cited page is force-rendered.
No document scan and no server-side coordinates.

`pdf/pdfCitation.js` keeps source offsets through Unicode ligature folding,
dehyphenation and whitespace normalization. Fallback passes tolerate differing
spaces and compound-word hyphens that cross line wraps. PDF.js text items are
mapped directly to their rendered spans, preserving empty EOL items and font
geometry. Small, raised multi-digit reference numbers after prose and before
punctuation can be omitted when matching an otherwise exact quote. Baseline
numbers, mathematical signs and single-digit exponents are not discarded.
Missing or repeated passages show a message on the
cited page instead of selecting a guessed match. Scans without a text layer
therefore open the page but cannot highlight text.

`PdfCitationOverlay` draws DOM `Range` rectangles from the real pdf.js text
nodes (partial runs included) instead of estimating glyph widths or trusting
PDFium offsets. The rectangles are percentages of the page, and a finished
text-layer render recomputes them after a zoom; stale document/render work is
cancelled. The marks (`.pdfCitationMark`, the translation shimmer) ignore
pointer input and never touch the annotation or note store. A click outside
the passage or Escape removes them; there is no close button.

Coverage: `frontend/tests/pdfCitation.test.mjs`, the citation scenario in
`frontend/tests/e2e/scenarios/pdf.mjs`, and `backend/tests/test_pdf_citations.py`.
The frontend fixture includes the actual failing PDF.js runs from physical
pages 20–22 of Krantz et al., *A quantum engineer's guide to superconducting
qubits*. `node tests/e2e/pdfCitationPaper.mjs /path/to/1904.06560.pdf` runs the
saved citations against that complete PDF in an isolated browser test.
