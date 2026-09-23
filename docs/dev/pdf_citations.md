# Clickable PDF citations

AI responses can link a passage using ordinary Markdown:

`[p. 3](/?page=GAMMA_PAGE_ID&pdf_page=3&quote=percent-encoded%20verbatim%20passage)`

The PDF page is physical and 1-based. Context and `read_page` label pages
`[PDF page N]` (blank pages counted, a mid-page continuation labelled
`; continued`) and each context section carries its Gamma page ID
([ai_context.md](ai_context.md)); `routers/ai.py` appends the citation
instruction whenever a document is in context, with tools off and under a
custom prompt too. A quote should fit on one page and identify one passage.
Copy it verbatim, including parenthetical references. A shorter distinctive
substring is also valid; do not add a period where the source continues.

The link is plain Markdown, so it persists with the reply — and renders the
same wherever it appears. `shared/model/gammaLinks.js` classifies one link
into this library (`parseGammaLink` → `block` / `page` / `citation`), and
`GammaLinkCard` (`shared/ui/Widgets.jsx`) draws it as a card in the chat and
in a note's rendered markdown alike. Clicking it calls `openPage(id,
citation)` from `GammaNavContext`, which App provides once: the library page
opens in place, waits for that PDF and the cited page's text layer, then
matches the quote in the browser. A pasted link on a cold load works the same
way (the same classifier on the initial URL). Only the cited page is
force-rendered. No document scan and no server-side coordinates.

The quote is optional: `?page=…&pdf_page=N` alone opens the paper at that
page with nothing highlighted.

**The origin is not part of the test.** A server moves — a desktop sidecar on
`127.0.0.1`, the NAS URL, a workspace mirrored onto another server — and
links written before the move still name this library's pages. A link whose
host differs from the tab's (`foreign`) is claimed only when its id resolves
locally, which the note renderer checks through the same `[[ref]]` batch
lookup it uses for the card's title; an id that doesn't resolve stays an
ordinary external link, which is what a link to somebody else's Gamma should
be. Pasting normalises the other way: the "Paste as" chooser offers
**Citation** / **Page link** for a recognised link and stores it host- and
workspace-free (`relativeGammaLink`), so new notes never learn a host.

`pdf/pdfCitation.js` keeps source offsets through Unicode ligature folding,
dehyphenation and whitespace normalization. Fallback passes tolerate differing
spaces and compound-word hyphens that cross line wraps. PDF.js text items are
mapped directly to their rendered spans, preserving empty EOL items and font
geometry. Small, raised multi-digit reference numbers after prose and before
punctuation can be omitted when matching an otherwise exact quote. Baseline
numbers, mathematical signs and single-digit exponents are not discarded.
A typography fallback permits omitted standalone section pointers: `(Methods)`,
`(Online Methods)`, and `(Supplementary Information/Methods/Material)` (one
of those three names). Wrapped pointers such as `(Meth-\nods)` work too.
Other parentheticals must still match in this pass. Omitted pointers are
excluded from the highlight, even when they share a text run with the quote;
exact matches take priority.

If those passes fail, `pdf/fuzzyCitation.js` aligns the quote's words against
the cited page with bounded edit distance. It tolerates punctuation changes,
minor spelling/OCR errors, and a few inserted, omitted or substituted words,
including arbitrary parenthetical prose. This requires at least eight words
and 40 non-space characters. The budget is one word edit per eight words,
capped at eight edits; one or two character typos in longer words cost a
quarter or half of a word edit. Numbers, mathematical symbols, Greek letters,
single-letter variables and negations cannot be inserted, deleted or changed
by this pass (the existing case folding still applies). A second qualifying
passage is ambiguous. Exact matches always win over approximate ones.

Fuzzy matches highlight the source passage, including internal words
omitted by the quote, and show “Highlighted an approximate text match.” The
matcher preserves source offsets and stops after at most one million word
comparison cells; unusually dense pages fall back to the unresolved notice
when exact matching fails. Missing or ambiguous passages show a message on the
cited page without a highlight. Scans without a text layer
therefore open the page but cannot highlight text.

`PdfCitationOverlay` draws DOM `Range` rectangles from the real pdf.js text
nodes (partial runs included) instead of estimating glyph widths or trusting
PDFium offsets. The rectangles are percentages of the page, and a finished
text-layer render recomputes them after a zoom; stale document/render work is
cancelled. The marks (`.pdfCitationMark`, the translation shimmer) ignore
pointer input and never touch the annotation or note store. A click outside
the passage or Escape removes them; there is no close button.

Coverage: `frontend/tests/gammaLinks.test.mjs` (the classifier),
`frontend/tests/pdfCitation.test.mjs`, the citation scenario in
`frontend/tests/e2e/scenarios/pdf.mjs`, and `backend/tests/test_pdf_citations.py`.
The frontend fixture includes the failing PDF.js runs from physical
pages 20–22 of Krantz et al., *A quantum engineer's guide to superconducting
qubits*. `node tests/e2e/pdfCitationPaper.mjs /path/to/1904.06560.pdf` runs the
saved citations against that complete PDF in an isolated browser test.
`pdfCitationTransduction.json` captures the page 4 regression from
*Quantum-enabled millimetre wave to optical transduction using neutral atoms*:
the quote omitted `(Methods)` before the period. To check another complete PDF,
pass its fixture file after the screenshot directory:
`node tests/e2e/pdfCitationPaper.mjs /path/to/transduction.pdf /tmp/citation-shots tests/fixtures/pdfCitationTransduction.json`.
