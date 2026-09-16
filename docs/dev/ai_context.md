# AI context for long papers

How the AI chat gets a page's content, why that used to fail on long papers,
and the measurements behind the current design. Code: `gamma/ai_context.py`
(context assembly), `gamma/ai_tools.py` (agent tools), `gamma/pdf_text.py`
(extraction), `gamma/pdf_index.py` + `gamma/block_index.py` (FTS indexes;
`gamma/routers/search.py` extracts PDFs into the former).

## What a page contributes

Context is framed as *pages from the user's knowledge base*
(`ai_context.CONTEXT_INTRO` precedes it in the user turn). Each page section
(`page_report_section`) is: `### title`, a properties line (folders, labels,
cached metadata, web source, attachment), and the user's notes tree with
highlights; a page that carries a PDF adds the document's text — for the
chat, the labelled head excerpt / selection windows below; for `read_page`,
a `pdf_chars` window. A page without an attachment is its notes, always
included; `include_notes` only decides whether PDF pages also show theirs.
Everything below is about the PDF part of a page and applies unchanged.

## The problem

A page chat injects the first `context_char_limit` chars of the PDF's
extracted text (default 60,000 since 2026-08-28 — Settings → Assistant →
"Single paper"; the eval below ran at the old 8,000). A 50-page paper is
~280,000 chars, so at 8k the model saw under 3% of it — and nothing used to
tell it that. Asked for a detail deeper in
the paper, it answered from its memory of similar papers: confident, specific,
and wrong (a camera model that isn't in the paper, n=70 where the paper says
n=53, fidelities off by tenths of a percent). The page-scope agent tools
(`read_page`, `search_library` — then `search_pdfs`) mostly fix this, but
four things still lost facts:
the model didn't know the excerpt was an excerpt, it guessed page numbers, an
over-specific search query returned zero hits (read as "the paper is silent"),
and every page past 400 was silently invisible.

## Measurements

Ground-truth detail questions (string-graded facts, each buried well past the
8k head) against the real `/api/ai/chat` on an isolated copy of live data,
model `gpt-5.6-terra`, page-scope agent with read+search. "Traps" ask for
plausible facts the paper does *not* contain; the right answer is "not in this
paper".

| config | paper 164k/28pp | review 282k/51pp | book 855k/484pp | normal questions |
|---|---|---|---|---|
| tools off, 8k head | 46% | 48% | — | 100% |
| agent, before fixes | 94% (3.9 calls/q) | 90% (4.1) | 88% (6.0) | 100% |
| + grounding prompt | 100% (3.8) | 94% (4.9) | — | 100% |
| + excerpt label, doc map, search fallback | 100% (3.5) | 97% (4.1) | 92% (9.9) | — |
| + page cap lifted | — | — | 96% (3.3) | — |
| **all shipped (re-run)** | **100%** (3.8) | **94%** (4.6) | **96%** (3.3) | **100%** |

Also tried: 5× larger head context (40k). +3 points for 5× the tokens on every
message, and it doesn't stop fabrication — the tools are the better lever.

## What shipped, and why

- **Grounding prompt** (`_SYSTEM_PROMPT` in `routers/ai.py`, plus the
  mechanical tool-guidance lines `agent_system()` appends in `ai_tools.py`):
  anything stated as being *in these pages or their documents* must come from
  text actually read; look it up first, say "not in their pages" otherwise —
  and say whether a fact comes from a PDF (with its page number) or from the
  user's notes. Scoped to claims about the pages — general background stays
  answerable, which is what keeps the "normal questions" column at 100% (an
  unscoped version refused to explain what a transversal gate is). With tools
  off, this converts fabricated answers into honest "the excerpt doesn't say"
  (recall drops to 17% — those were memory, not reading).
- **Excerpt label** (`head_context` / `extract_pdf_context`): the injected
  head is prefixed with `[EXCERPT — the first 8,000 characters of this
  51-page PDF …]` whenever the document didn't fit; `CONTEXT_INTRO` likewise
  says a page's document text "is often an excerpt (see its label)".
  Unlabelled, "here is the text" reads as the whole paper.
- **Page labels** (`extract_text(..., label_pages=True)` in `pdf_text.py`):
  every non-empty physical page is prefixed `[PDF page N]`, counted from
  `start_page` with blank pages included; a `read_page` continuation that
  starts mid-page repeats it as `[PDF page N; continued]` outside the offset
  window (`pdf_excerpt`), and each context section carries
  `Gamma page ID: <id>`. Both feed the clickable citations
  ([pdf_citations.md](pdf_citations.md)).
- **Document map** (`document_map`): for page-scope agent chats, a ~2.4k-char
  outline — one line per PDF page (sampled for big documents), taken from the
  FTS index so it costs a query, not a re-parse. The model jumps to the right
  page instead of guessing; on one question this cut 6 tool calls to 1.
- **Search relaxation** (`_run_search_library`): the FTS query ANDs every
  term, and agents write 6–9-word natural queries — one word the page doesn't
  use meant zero hits and a wrong "the paper doesn't discuss this". A miss now
  retries with only the longest words and labels the result as approximate; a
  true miss says explicitly "do not answer from your own knowledge". (The
  same relaxation covers the notes index the tool searches since Stage 2.)
- **Page cap raised** (`pdf_text.MAX_PAGES`, 400 → 5000): the old cap made a
  484-page book end at page 400 *everywhere* — not in the search index, not
  reachable by `read_page`, indistinguishable from the document ending. Worst
  case was a search hit on p.410 the agent then couldn't read: 32 tool calls of
  thrashing. The cap survives only as a runaway guard and logs when it bites.
  (`textnorm.INDEX_VERSION` bumped so old indexes rebuild lazily.)
- **Extraction lock** (`pdf_text._lock`): pdfium is not thread-safe — two
  overlapping extractions both die with "Failed to load page", even on
  different files. Sync endpoints run in FastAPI's threadpool and the search
  indexer runs in a background thread, so a chat could collide with its own
  indexing, get the failure sentinel as context, and answer blind. All
  extraction is now serialized behind one lock.

## Known limits

- A leading question about a fact that is *not* in the paper ("what fidelity
  does this review report for X?") can still elicit the remembered number,
  now hedged rather than asserted — the model searches, finds nothing, and
  names the value while admitting it didn't find it in the text.
- The map and index only exist once the paper is indexed. Every single-page
  chat request on a page with a PDF (`gather_inputs` → `ensure_indexed`)
  kicks background indexing for an un-indexed or stale paper, so the first
  message on a fresh paper works without map/search and the next one has
  both. (Before, only a search call kicked it — a chat that only ever used
  `read_page`, or ran with tools off, never got its paper indexed.)
- With tools off the model sees only the labelled head excerpt; nothing else
  in a plain chat can reach the rest of the paper (native PDF attachment is
  refused by the ChatGPT-OAuth backend and falls back to that same excerpt).
  Paper chats default to tools off, so the head budget is what most paper
  chats live on — hence the 60,000 default (a typical ~20-page paper fits
  whole; the multi-paper total is 120,000, split evenly across papers). The
  truncation is also shown to the user: `head_context` returns the coverage
  (`pages_shown` from `pdf_text.extract_text_pages`, total from
  `page_count`) that the chat streams back as its `context` line and renders
  as a "Model saw pages 1–9 of 22" chip on the reply ([ai.md](ai.md)).
- Grading is substring matching on de-markdowned/de-LaTeXed answers; the
  harness lives outside the repo (session scratchpad, `eval/`).
