# Paper metadata and PDF resolution

How a page block learns what paper it holds, and how a link or DOI becomes a
stored PDF. Code: `gamma/routers/metadata.py`, `gamma/pdf.py`.

## Metadata fetch / edit / cite

`/api/metadata/fetch` resolves a page's paper and caches result + BibTeX +
the slide citation on the page block (`properties.meta` / `properties.bibtex`
/ `properties.ppt_cite`). The lookup chain, in order:

1. **arXiv API** — id from the source URL or the PDF text (new- and old-style
   ids).
2. **DOI content negotiation** (doi.org) — every DOI in the source URL and
   scan window, each with a glued-suffix trimmed variant. A CSL `type` of
   `book`/`monograph` keeps `kind: book` + publisher/ISBN.
3. **ISBN lookup** (books) — checksum-valid ISBNs *labelled* "ISBN" in the
   scan window or on the last page (copyright page, back cover), resolved via
   Open Library's books API, then Google Books. Both keyless.
4. **Crossref bibliographic search** — queried with the page title first
   (≥3 words; users title pages with the paper name), then the normalized
   text head. Deterministic; keeps most publisher PDFs off the AI fallback.
5. **AI extraction** — last resort, and its output is verified (below).

The registry helpers (`_fetch_arxiv` / `_arxiv_search` — both parse Atom
entries through `_arxiv_entry_meta` — `_fetch_doi`, `_crossref_search`) also
back the chat agent's `search_papers` tool ([ai_tools.md](ai_tools.md)).

**What the steps read.** Identifier scans and title matching use a
`SCAN_CHARS` (20k) head window, deliberately decoupled from the AI-context
pref, **plus the last page** — an issue-clipped Science PDF opens with the
*previous* article's tail (title 7k+ chars in) and prints its own DOI only in
the end-of-article trailer. Only the AI call is capped at the pref
(`context_char_limit`).

**Trust rules** (the first DOI on page 1 can belong to a *cited* paper, and
AI output can be a plausible hallucination):

- Identifiers with **URL-level trust** are accepted outright: the stored
  `source_url`, the `web_url` the extension clipped from, and
  detector-supplied `doi`/`arxiv_id` hints (`fetch_page_metadata` kwargs —
  `/api/clip` forwards what `detect.js` read off the publisher page's own
  meta tags).
- A record found via the *text* counts as **confirmed** only when the
  registry's title appears in the PDF text (`_title_in_text` — normalized
  for case, ligatures, line-break hyphens). Unconfirmed resolutions are kept
  only as a fallback when nothing confirms; a Crossref search hit is accepted
  solely on title-in-text evidence.
- An ISBN record is confirmed by `_record_in_text`: the paper rule, or —
  book titles are short ("Lasers") — the whole title *and* one author
  surname in the text head. Unconfirmed → fallback, like a DOI.
- AI output goes through `_verify_ai_meta`: an identifier it produced is
  resolved and, on success, replaced by the registry record; one that
  resolves nowhere and doesn't occur in the PDF is dropped as fabricated; the
  AI title is cross-checked against Crossref (≥0.92 title similarity +
  compatible year upgrades it).
- **Book search.** When the AI classified the document as a `book` (or
  `other`) and Crossref has nothing, the AI title + first author go to
  `_book_search` (Open Library `search.json`, then Google Books
  `intitle:/inauthor:`). `_pick_book_match` accepts a hit only when the
  titles are alike (≥0.9, or one is the other plus a subtitle) *and* an
  author surname agrees: both were read off the title page, and the
  registry confirms they name a real book. The registry supplies the
  canonical title, authors and publisher. The AI-read year stays, since it
  names the edition in hand while the registry's is the first publication.
  An ISBN is adopted only if the PDF text prints it, so books published
  before ISBNs resolve through this path too.

**Source and the unverified flag.** `meta.source` is `arxiv` / `doi` /
`isbn` / `crossref` (search hit whose doi.org fetch failed) / `openlibrary`
/ `googlebooks` / `ai` / `manual`. Every fetched record also stores
`meta.unverified`: true when nothing tied it to *this* document — an AI
record claiming to be a paper, or a DOI/ISBN fallback whose registry title
isn't in the text (it may belong to a work the document cites). Unverified
records get a red "!" badge on the metadata button, a red Source row in the
popover, a red "!" + source tag beside the slide citation in the share
popover, and a red cell in the Settings → Library table. The wording lives
in one place, `metaSourceInfo` in `frontend/src/utils.js`; the predicate
`isUnverifiedPaperMeta(source, kind, unverified)` falls back to the old
"AI-extracted paper" rule for records stored before the flag existed. The
AI extractor also classifies the document (`meta.kind`: `paper` / `notes` /
`slides` / `thesis` / `book` / `report` / `other`, unknown → `paper`); the
warning only fires for kind `paper` — course notes and the like have no
registry record to verify against, so they get a quiet "AI-extracted (notes)"
instead. Registry-sourced records carry no kind except books; a book record
(`kind: book`, or a publisher without a venue) renders as BibTeX `@book`
with `publisher`/`isbn`, and the metadata popover swaps the journal rows
for Publisher/ISBN. A hand edit keeps the kind and clears the flag (the user
vouched for the record).

The fetch also kicks background search indexing for the paper
(`ai_context.ensure_indexed`) — the paper is being set up, so search, the AI
document map and library-wide Ctrl+F shouldn't wait for the first search to
discover it. `/api/metadata/update` saves hand-edited fields from the
metadata popover (rebuilds BibTeX, source `manual`, invalidates the cached
citation). In the popover, the DOI and arXiv rows carry an open-on-registry
link and a copy button for that URL beside the field.

**Slide citation.** The PPT-style markdown citation is generated *in the
same fetch* as the metadata (`_make_ppt_cite`, one AI call over the BibTeX;
the client passes its `cite_prompt`/`cite_model` prefs, `/api/clip` uses the
defaults) and returned as `ppt_cite`, so it is ready the moment the record
is. A citation failure
never fails the fetch. `/api/metadata/cite` is the regenerate path (↻ in the
share popover) and the fallback the client's citation effect uses on open
for pages whose record predates this, whose citation call failed, or whose
metadata was just edited — one attempt per page per session, only when AI
is configured.

`GET /api/metadata/status` reports library-wide health (per paper: metadata
present/failed + source/kind, extracted-text chars and index state from the
FTS tables) — it feeds the Settings → Library pane's status table and its
adaptive batch retry (selected, else missing + unverified-AI; plus "Refetch
all"/"Refetch shown" → sequential `metadata/fetch` with `force`).

No Google Scholar — it has no API and blocks scraping. The book registries
(Open Library, Google Books' anonymous quota) are keyless public APIs;
neither needs configuration.

PDF uploads use the browser-provided original filename as their initial page
title and enter a lazy sequential metadata queue after the upload UI completes.
The page stores an `auto_title` compare-and-swap marker: a successful lookup may
replace that filename with the paper title only while the page title still
matches the marker. Any explicit rename clears it, so a slow lookup cannot
overwrite the user's edit. The fetch response always carries `page_title`,
the page's title as it stands after the write (`title_updated` says whether
*this* call did the rename): two lookups can race — the extension's
background lookup after a clip and the one the app starts when the page is
opened — and the loser still has to show the winner's rename, so the client
(`mergeMetaResult` in App.jsx) takes the server's title over its own copy and
drops the marker once the title has moved off it. The AI fallback model is selected in Settings →
Providers; arXiv and DOI resolutions do not call that model.

## PDF resolution

`/api/resolve-pdf`: arXiv abs→pdf rewrite → direct fetch → HTML pages inspected
for the `citation_pdf_url` meta tag → Unpaywall open-access fallback for DOIs
(prefers published > accepted > submitted version; disabled when the request
sends `allow_oa: false`; identifies itself with a fixed project email in
`pdf.py` — no config). Non-published substitutions return a `note` the frontend
surfaces.

Resolution only picks a candidate URL — the download behind it can still fail
(paywall, blocked server-side fetch, HTML behind the link). So `openPdf` in
`App.jsx` preflights the resolved URL with `probePdfUrl` (`utils.js`): it opens
`/api/pdf` without `save=1`, keeps the headers and cancels the body, and only
then creates the page. `/api/pdf` is the single arbiter of "is this a PDF" —
its 400 `detail` becomes the failure status, and no page is left behind. A URL
whose paper is already in the library skips the preflight, so an existing page
stays openable even after its source goes away.
