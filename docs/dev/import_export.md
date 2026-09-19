# Import and export

The ⋮ menu's Import…/Export… dialogs and every pipeline behind them: embedded
PDF annotations, Logseq graphs, Zotero libraries, Markdown notes (Obsidian
vaults, Notion exports), Markdown and Obsidian vault export, the notes
typeset as their own PDF, and the annotated-PDF writer. Code: `gamma/routers/imports.py`, `gamma/zotero_import.py`,
`gamma/zotero_export.py`, `gamma/logseq_import.py`, `gamma/markdown_import.py`,
`gamma/markdown_zip_import.py`, `gamma/markdown_export.py`, `gamma/obsidian_export.py`, `gamma/pdf_export.py`,
`gamma/pdf_notes.py`, `gamma/pdf_document.py`, `gamma/pdf_typeset.py`,
`gamma/note_markup.py`, `gamma/vector_text.py`, `gamma/pdf_glyphs.py`,
`gamma/pdf_image.py`; frontend dialogs in
[ImportExport.jsx](../../frontend/src/transfers/ImportExport.jsx), imported directly by
[App.jsx](../../frontend/src/app/App.jsx).

## Importing annotations embedded in a PDF

`/api/import/pdf-annotations` converts annotations embedded in the PDF file
(SumatraPDF/Acrobat/Gamma-export highlights, notes, and /Square//Circle → area
highlights) into highlight blocks — idempotent via `properties.imported_annot`
keys; opacity honors the annotation's `/CA` so a Gamma export → re-import
round-trips exact colors; PyPDF2 dict access returns `IndirectObject`s, always
`.get_object()` them. `/Ink` (freehand drawings from any PDF app, or a Gamma
export) becomes a handwriting block: the strokes are stored as an `.ink`
upload (`gamma/ink.py`), the block gets `ink_url` / `pdf_page` /
`pdf_position`; a Gamma export's private `/GammaInk` key restores pressure
and time, foreign ink is polylines at the annotation's width
([handwriting.md](handwriting.md)).

Because imported annotations would otherwise render twice (pdf.js paints them
into the canvas AND the blocks draw as overlays), the Settings → Reading → PDF
viewer → "Annotations inside the file" preference either hides them viewer-side
(`annotationMode: DISABLE`, default) or sends `strip: true` so the import
rewrites the stored PDF without them (the ⋮ menu's "Import…" dialog can
override that for one run; the auto-import on open always follows the
preference); stripped blocks get `properties.annot_stripped`, which tells
`/export-pdf` to write them again (it skips `imported_annot` blocks only while
the original is still embedded).

## The Import dialog

The ⋮ menu's single "Import…" entry → `ImportDialog` in `transfers/ImportExport.jsx`, the
export dialog's counterpart. Step one is a source card: annotations embedded
in this PDF, a Logseq .pdf + .edn, a Zotero library .zip, Markdown notes (one
`.md` or a `.zip` such as a Notion export), or a Gamma export .zip. Double-click
or Next confirms. Only sources with an option get a review step. That option is
the strip switch, which applies to embedded annotations, including those
inside Zotero's exported PDFs. Markdown, Logseq and Gamma open the file picker
directly, with their preparation notes under the selected card.
`resolveImport` in `transfers/transferFormats.js` decides both.
Zotero is the default source (a numbered step guide reusing
settingsKit's `Step`); with a PDF open, that PDF's own annotations win. Nothing
is remembered: the switch starts from the Settings preference each time, so the
setting stays the standing policy.

## Plain Markdown uploads

The add menu's file picker, directory picker, and whole-window file drop all
accept `.md` / `.markdown` alongside PDFs, and the Import dialog's "Markdown
notes" source takes one `.md` too. `POST /api/import/markdown` decodes
UTF-8 (5 MB cap), reduces any browser-supplied relative upload path to its
filename leaf, uses a YAML-frontmatter `title` or that filename's stem as the
note-page title (a front-matter `folder:` files the page below the upload's
folder), and converts the document into nested Gamma blocks through
`gamma/markdown_import.py`. Headings and indented lists retain hierarchy;
paragraphs, fenced code, math and other Markdown stay as raw block content for
the normal editor renderer. Lines indented under a list item continue that
item, whether directly below it or after a blank line when aligned with the
item's text. That is how the Markdown export writes a multi-line block, and a
fence or `$$` opened that way swallows its lines, blank ones included. Text
indented deeper after a blank line becomes a child block, which is how Notion
exports a toggle's content. In mixed folder uploads, Markdown note pages and PDF pages
receive the same subfolder labels; unsupported files are skipped.

## Markdown zips: Obsidian vaults, Notion exports, Gamma exports, zipped notes

Mermaid fences stay as editable Markdown through import/export and render as
diagrams in the frontend. The diagram toolbar can download SVG separately;
backend PDF exports retain code-block output. See [mermaid.md](mermaid.md).

`POST /api/import/markdown-zip` (Import dialog → "Markdown notes", pick a
`.zip`; `gamma/markdown_zip_import.py`) turns a zip of `.md` files into one
page per file. One logic covers a zipped Obsidian vault, Notion's Export →
"Markdown & CSV" (with subpages), Gamma's own Markdown export and any zipped
folder of notes, because they only differ in naming and link conventions
(the survey behind the Obsidian mapping: [docs/research/obsidian.md](../research/obsidian.md)):

- **Title**: front-matter `title`, else the leading `# H1` (stripped from
  the body — Notion and Gamma both write one), else the filename with
  Notion's `Title <32-hex id>` suffix removed. In an Obsidian vault
  (recognised by its `.obsidian/` folder) the filename is the title, as in
  Obsidian itself, and the H1 stays in the body unless it repeats the title.
- **Folders**: directories become folder labels, ids stripped. Notion puts
  a page's subpages (and its images) in a folder named after the page, so
  the Notion page tree becomes the folder tree. A front-matter `folder:`
  wins over the directory; the dialog's target folder (the open library
  folder) prefixes everything. One common root directory (a zipped folder)
  and Notion's `Export-<uuid>/` wrappers are dropped; Notion's `Part-N.zip`
  members (big exports) are read in place; `.obsidian/`, `.trash/` and
  `.canvas` files are skipped (a canvas is a warning).
- **Links**: a link to another note in the zip becomes a `[[page]]` mention
  of the page it produced — Markdown links (Notion's percent-encoded
  `[Sub](Parent%20<id>/Sub%20<id>.md)`, Gamma's `[label](Page-id.md)` and
  `*(from [title](file.md))*`) and Obsidian wikilinks (`[[Note]]`,
  `[[Note|alias]]`, `[[folder/Note]]`) alike. A target is resolved relative
  to the note, then as an exact vault path, then by basename anywhere in the
  zip (nearest directory wins), case-insensitively — Obsidian's own rule.
  `[[Note#Heading]]` and `[[Note#^id]]` point at that heading block or
  anchored block (`^id` markers are indexed per note and removed from the
  text; an anchor on its own line belongs to the block before it),
  `![[Note#^id]]` becomes a Gamma synced block `![[id]]`, while `![[Note]]`
  and `![[Note#Heading]]` degrade to mentions (a Gamma embed shows one
  block). A link or image pointing at a bundled file uploads it
  (`store_file`, content-hash dedup, storage limits per file — an over-limit
  file is a warning and the link stays as typed) and points at
  `/api/uploads/…`; `![[img.png|300]]` / `|300x200` becomes the editor's
  `![|300](url)` size form, other pipe text the alt. Links that resolve to
  nothing stay as typed (so a Gamma `[[id]]` is never touched).
- **Obsidian specifics**: front-matter `tags` (list, flow list or comma
  string; `tag` too) become labels in `properties.category`, `aliases`
  are kept in `properties.aliases`; `> [!type]+`/`-` fold markers are
  dropped (in `md_to_blocks`, so pasted text loses them too);
  `%%comments%%` are removed in a vault (inline or block, never inside
  fences). Inline `#tags`, footnotes and task states pass through as text.
- **Notion specifics**: a database `Name <id>.csv` becomes a page holding
  the table (`_all.csv` preferred when both exist — it has every row; capped
  at 500 rows × 40 columns) and its row pages `Name <id>/Row <id>.md` land in
  the folder of that name; `<aside>` callouts become `> [!info]` callouts;
  the row pages' `Property: value` lines stay as text.
- **Gamma specifics**: the front matter's `source:` restores the PDF when it
  is bundled (`assets/<sha>.pdf`, or the vault export's quoted
  `"[[Paper.pdf]]"` → `doc_id`/`source_url`, the page becomes a paper
  again) or the remote URL when it isn't; `doi`/`authors`/`year` →
  `properties.meta` (`source: manual`; `authors` as a YAML list or a comma
  string), the ```` ```bibtex ```` block → `properties.bibtex`. Highlights come back as their quote blocks, not as
  positioned highlights — the Gamma format (`?mode=gamma`) is the lossless
  route; Markdown is for notes and for other apps.
- **Idempotent**: a `.md` already imported (same bytes — `markdown_import`
  digest — or the same `notion_id`) is skipped, and links to it resolve to
  the existing page, so re-importing an export adds nothing.

The report's counts (`pages_created`, `pages_skipped`, `assets_stored`,
`links_resolved`, `notion`) feed the status line, `warnings` go to the
browser console, and `pages` lists up to 200 created pages (`id`, `title`,
`folder`) for API callers. To make the round trip work the
Markdown export writes the page's folder label into the front matter
(`folder:`), relative to the exported folder — a folder export's root pages
carry none — so importing the zip into a folder rebuilds the same tree there.

## Zotero library import

`POST /api/import/zotero` (⋮ → Import… → Zotero library): a zip of Zotero's
File → Export Library → "Zotero RDF" (with Export Files/Notes).
`gamma/zotero_import.py` parses the RDF (items, journal records carrying the
DOI, collections, tags, HTML notes) and tolerant zip-name lookup
(cp437-mojibake, NFC/NFD, backslashes); the endpoint in `routers/imports.py`
uploads PDFs (dedup + quota per file, over-quota items are skipped not fatal),
upserts pages keyed by file hash then `properties.zotero_key` (re-exports
change bytes — Zotero re-embeds annotations at export time), maps
collections→folder labels (optional `folder` prefix form field),
tags→`category`, notes→child blocks (`properties.zotero_note`), then runs the
shared `import_embedded_annotations` (reader annotations arrive inside the
exported PDFs; `strip` follows the client's embedded-annotations preference).
Merging only fills gaps: existing meta/bibtex/files are kept, labels union.

## Zotero RDF export

The import's exact inverse (`gamma/zotero_export.py`, endpoint branches in
`routers/export.py`): `?mode=zotero-rdf` on `/pages/{id}/export` and
`/folders/export` builds a `<slug>/<slug>.rdf` + `<slug>/files/<n>/<name>.pdf`
zip that Zotero's File → Import reads (unzipped) and Gamma's own
`/api/import/zotero` accepts as-is. Element shapes mirror what Zotero itself
writes and `parse_zotero_rdf` reads: venue/volume/DOI on a standalone
`bib:Journal` referenced by `dcterms:isPartOf`, notes as `bib:Memo` HTML
(top-level non-highlight subtrees, one note each — the inverse of the import's
notes→child-blocks mapping), folder labels as the `z:Collection` tree (a folder
export confines them to paths under the exported folder), tags as `dc:subject`,
`properties.zotero_key` reused as `rdf:about` so keys survive a round trip.
Attachment paths live in `z:path` like Zotero's own export — never an
`rdf:resource` *element*, an RDF/XML syntax term that Zotero tolerates but
strict parsers (rdflib) reject. The pipeline is verified against a live Zotero
via its connector server's `/connector/import` (same translator code path as
the wizard). Zotero cannot read the .zip itself — its wizard reports
"unsupported format" for one, so the zip ships a README.txt telling people to
extract and pick the .rdf, and the export dialog shows a numbered step guide
for the format. Pasted note images: embedded in the Memo HTML as data URIs
(Zotero's note import keeps them — verified live; `_EMBED_IMAGE_CAP` guards
size), attached to the item as image `z:Attachment`s when bundling, and
replaced by a plain `(image: … — see item notes)` placeholder in annotation
comments (`strip_image_md`) — comments come from the PDF's `/Contents` and can
never render a picture, so a highlight whose notes carry images ALSO becomes
its own Memo with a page+quote header (`highlight_memo_html`). `/api/folders/export` (all modes) reports per-page
progress through `/api/folders/export-progress`, which the frontend polls into
the status pill during folder exports. Highlights are not in the RDF
— like Zotero's "Include Annotations" they're burned into the exported PDF
copies with `pdf_export.annotate_pdf` (`highlights=0` skips that, `pdf=0`
omits the files entirely, `notes=0` the Memos).

## The export framework

`/pages/{id}/export` and `/folders/export` share one driver (`_run_export` in
`routers/export.py`): it walks the selected pages exactly once (subtree fetch
→ `build_tree` → progress bookkeeping) and feeds each page to a per-format
`_Builder` (`_MarkdownBuilder`, `_NotesPdfBuilder`, `_LogseqBuilder`,
`_ZoteroBuilder`, `_GammaBuilder` — keyed by `?mode=`), which accumulates zip
parts and names the download. `begin(conn, root_ids)` shows a builder the
whole export set before the walk — the DB connection is closed by the time
`response()` runs. Adding an export format = adding a builder; the
endpoints, progress plumbing and `_zip_response` stay untouched. A builder
whose download isn't a zip overrides `response()` instead (`_NotesPdfBuilder`
returns one PDF).

## Gamma-to-Gamma export

`?mode=gamma` (`_GammaBuilder`): a *scoped account backup* in the same
`gamma-backup-1` layout as `/api/export` (`gamma/ws_backup.py`) — a `pages.db` holding just the
selected page subtrees verbatim (same block ids), a `data.db` with their AI
chats (plus the folder view's own `home:<path>` chat buckets on a folder
export), `uploads/` with just the referenced files (doc_id PDFs + anything
matching `UPLOAD_RE` in content/properties — the orphan-cleanup reference
rule; `UPLOAD_RE` matches `/api/assets/<name>` as well as `/api/uploads/<name>`,
so a native iPad annotation's `.pkdrawing` / `.png` / `.m4a` / `.inkjson` assets
travel too, and the readable Markdown bundle writes them under `assets/`), and a
`manifest.json`. **There is no new import code**: any Gamma
imports it through the existing `/api/import-data?mode=merge` — additive,
deduped by block id / doc id / content hash, so re-importing adds nothing. The
⋮ Import dialog's "Gamma export (.zip)" source feeds the zip to that endpoint
via the same upload/progress path as Settings → Restore backup (guests can't
import). A Gamma export is a complete copy, so the Export dialog has no
switches for it.

### Importing a shared page by link

The same pipeline, without the zip ever touching disk: `importSharedPage` in
`app/App.jsx` takes a share URL (`https://other/?share=<token>`), resolves the
token against that origin's `/api/share/{token}`, fetches the page as
`/api/pages/{id}/export?mode=gamma&share=<token>`, and hands the blob to
`runBackupImport(…, "merge")` with `after.openPage` set — block ids survive
the export, so the reload lands on `?page=<id>` in the importer's own
library. The fetch is browser-side on purpose: the browser reaches a Gamma on
the LAN or at `localhost` that the server's SSRF guard (`net_guard.py`)
refuses. That works because share GETs answer
`Access-Control-Allow-Origin: *` ([api.md](api.md)); with `*` the browser
sends no cookies cross-origin, so only links open to `anyone` import from
another Gamma, while a same-origin link also carries the session and
invite-only ones work too. Two entry points:

- The topbar's "+" box: a pasted `<origin>/?share=<token>` is recognised by
  shape (`parseGammaShareLink`: the SPA root with a `share` query), shows a
  hint, and Enter imports instead of fetching a PDF. Everything else typed
  there is still a paper.
- The share view's topbar: a signed-in non-guest viewer gets "Add to my
  library" (the same function on `window.location.href`). The page's owner
  gets "Open in my library" instead, a plain jump to `?page=<id>`, since the
  page is already theirs.

The remote must be recent enough to serve `mode=gamma` and the CORS
header; an older one surfaces as "couldn't reach …" / "too old" in the
status line and the transfer row.

## The Export dialog

The ⋮ menu's single "Export…" entry → `ExportDialog` in `transfers/ImportExport.jsx`.
Step one is a format card. The PDF row holds Annotated PDF, the Notes row PDF
and Markdown, the ZIP row Obsidian, Logseq, Zotero and Gamma. Double-click or
Next confirms. Formats with editable options get a review step: the
Highlights, Notes and Bundle-the-files switches beside an illustrative page
(`illustrations/TransferPreview.jsx`, an example of the options, not a render
of the document). Gamma has fixed contents, and a PDF without a stored copy
can only be the original file, so both export straight from step one. Logseq
shows only the bundle switch. The breadcrumb returns to the cards without
losing edits. Both dialogs are a `SubDialog` (focus trap, Escape, backdrop)
with its close-button header; the footer holds only Next or the final action.
Zotero's post-export steps expand under "Open this export in Zotero".
`transfers/transferFormats.js` owns the format table (label, category, hint,
editable and fixed options, `EXPORT_SWITCH_TEXT`, the row order `CATEGORIES`)
and `resolveExport`. The resolver turns the saved options into the controls,
decides whether a review step is needed, and builds the one payload the
preview and the download share. Zotero highlights
live inside bundled PDFs, so turning bundling off disables Highlights without
changing the saved preference. The chosen format and options are remembered
in `localStorage` (`gamma-export-opts`). The switches are query flags on two
endpoints:
`/pages/{id}/export?mode=readable&highlights=&notes=&pdf=` (Markdown,
`render_readable` in `markdown_export.py`; dropping highlights keeps a
highlight block's own text as a plain bullet; the front matter carries the
page's folder label relative to the exported folder so the zip re-imports
into the same tree; image sizes export in the
Obsidian dialect — `obsidian_image_sizes` rewrites any legacy `{:width N}`
to `![alt|N](url)`. Block links resolve against the export set
(`resolve_block_links` + `_MarkdownBuilder.begin`'s page-id → filename map):
a `[[ref]]` or PDF link region whose target page is in the same export
becomes a relative link to that page's .md — so a folder zip is
self-contained — and reads as plain text otherwise; a `![[embed]]`
materializes the synced block's content with a *(from …)* attribution,
nested embeds degrading to mentions; ids the resolver doesn't know stay as
typed) and
`/pages/{id}/export-pdf?highlights=&notes=`. "Annotated PDF" is the paper itself and is
hidden when there is none (a note page or a folder). An unsaved proxy PDF can
export only its original file, so it skips the options page and exports directly.
"PDF" in the Notes row (`?mode=notes-pdf`) takes over as the fallback format, and its
Bundle switch is hidden because a document always embeds its images. Two
combinations are special: a
Logseq graph is defined by carrying both layers, so highlights and notes are
always included and only file bundling gets a switch; a PDF with both off is the stored file itself, which the frontend
downloads from the viewer's own URL (so it also works for a PDF that only
exists behind the proxy).

The dialog can also target a whole folder: opened from home with a folder open
(the ⋮ Export… entry) or from a folder card's context menu (`exportFolder`
state in App.jsx), it drops the single-PDF format and sends the same
format/switch flags to `/folders/export?name=` (readable, `obsidian`,
`logseq-graph` or `zotero-rdf`).

## Obsidian vault export

`?mode=obsidian` on both export endpoints (`_ObsidianBuilder` →
`gamma/obsidian_export.py`) writes a zip that IS a vault: unzip it into an
existing vault or open the folder as one. The readable Markdown export is
for reading anywhere; this one speaks Obsidian's dialect so links, embeds and
attachments work inside the app (what Obsidian expects and why:
[docs/research/obsidian.md](../research/obsidian.md)). Always a zip, even for
one page.

- **Files**: `<dir>/<Title>.md`, the directory tree = the page's first folder
  label relative to the exported folder (a single page keeps its whole
  label). `vault_name` strips what Obsidian refuses in a name
  (`* " \ / < > : | ? # ^ [ ]`, leading dots); same-named pages in one
  directory get ` 2`, ` 3` suffixes. No `# Title` H1 — the filename is the
  title, and a `title:` property is written only when the name had to be
  sanitised. `.obsidian/app.json` (attachment folder = `attachments/`) marks
  the zip as a vault, which is also how the importer recognises it.
- **Front matter**: `tags` (the `category` labels), `aliases`, `source`
  (the bundled PDF as a quoted wikilink `"[[Paper.pdf]]"`, else the URL),
  `doi`, `authors` (list), `year`; then the BibTeX fence as in the readable
  export.
- **Outline → document** (the Logseq importer's flattening): a top-level
  heading block is a heading and its children follow as document content;
  a top-level leaf block is a paragraph; a top-level block with children is
  a list item with its subtree as a nested list (2-space indents,
  multi-line content indented under the bullet). Re-importing therefore
  nests everything after a heading under it — the one lossy step; the Gamma
  format stays the lossless route.
- **Links**: `[[id]]` / `![[id]]` whose target is in the export become
  `[[Title]]` for a page (`[[dir/Title]]` when two exported pages share a
  name — Obsidian's rule), `[[Title#^id]]` / `![[Title#^id]]` for a block
  (`[[#^id]]` on the same page), and the target block gets ` ^id` written:
  on its bullet line in a list, at the end of a paragraph, on its own line
  after a fence / table / quote / callout. `anchor_marker` makes the id
  Obsidian-legal (letters, digits, dashes). Only linked blocks carry
  anchors; `begin` scans the workspace's link-bearing blocks up front so a
  target renders with its anchor even when the linking page comes later.
  Targets outside the export degrade like the readable export (text /
  materialised embed). PDF link regions become `[[Title|label]]` or
  `[label](url)`.
- **Highlights**: a `> [!quote]` callout whose title links the bundled PDF's
  page — `[[Paper.pdf#page=3|p. 3]]` (`p. 3` without the bundle) — then the
  highlight's own note as a paragraph and its children as a list; inside a
  list, `- > quote` with the page link on the next line. The Highlights /
  Notes switches mean what they do in the Markdown export.
- **Attachments**: images as `![alt|300](attachments/<sha>.<ext>)` (the
  form Gamma stores, which Obsidian reads too), the PDF as
  `attachments/<Title>.pdf` (shared by pages of one document); the Bundle
  switch off leaves server links instead.

The vault importer above reads all of this back (titles from filenames,
`^id` anchors and wikilinks into mentions and synced blocks, `tags` into
labels, the quoted `source` into the paper) — `test_obsidian.py` has the
round trip.

## Notes as a PDF document

`?mode=notes-pdf` on both export endpoints (`_NotesPdfBuilder` →
`gamma/pdf_document.py`) typesets the *notes themselves* as a new PDF — the
inverse of the annotated export below, and the only PDF a page without a paper
can produce, so the Export dialog offers it everywhere (a folder export puts
every page in one document, each starting on a fresh sheet).

Each block's markdown is parsed twice: into chunks (headings, paragraphs,
`>` quotes and `> [!type]` callouts, list items, `- [ ]` todos, fenced code,
`---` rules, GFM tables, images — honoring the editor's size, Obsidian
`![alt|300]` or legacy Logseq `{:width N}`, capped at the column —
`![[embed]]` synced blocks, `$$…$$` math) and each
chunk's text into styled inline spans (bold, italic, `code`, strike,
`==mark==`, `[[refs]]`, links, `$…$` math). Highlights become quoted passages
with a bar in the highlight's own colour and a `p. N` marker, and the
Highlights/Notes switches mean exactly what they do in the Markdown export
(drop highlights and a highlight block keeps its own writing as a plain
bullet). Links become real `/Link` annotations, page titles and headings
become PDF bookmarks. Layout constants (A4, margins, sizes) live at the top of
the module.

Tables draw as a real grid: column widths measured from the cells (squeezed
proportionally into the column when too wide), wrapped cells, `:---:`
alignment honored, the header bold on a tint and repeated when a page break
falls inside the table. Fenced code is a bordered tinted card, one card
segment per page it spans. `[[refs]]` and `![[embeds]]` resolve through a
`resolve_ref` callback (`_block_ref_resolver` in `routers/export.py` — its own
sqlite connection, since the request's closes before `response()` runs): a ref
reads as its target's first line in link colour, an embed renders the synced
block's content as a card with a soft bar and a muted `from <page>` source
line (nested embeds degrade to refs so transclusion can't recurse).

Native (iPad) blocks read as themselves rather than as an asset URL. A
`type: "pdf_ink"` annotation shows its picture in the flow — the per-stroke
replay derivative first (the higher-resolution rendering the web's Notes pane
prefers, trimmed to the strokes' own bounds), the block's whole-block PNG
preview as the fallback — under a `handwriting, p. N` caption (`· K strokes`
when the derivative supplied it). A block whose picture is missing from this
server says `no preview available` instead of vanishing, and the PKDrawing
itself is never converted: Apple's format cannot be opened here, so the
editable source stays on iPad. A `type: "audio"` recording becomes text —
`audio recording · 2 segments · 1:23 total · audio not embedded`, then one
linked line per finalized segment (`Segment 1 · 0:42`) — because a PDF has no
player, and embedding the audio would only imply one that is not there.
The switches keep their meaning: native handwriting rides the Highlights
switch (it is a region of the paper, like `ink_url`), a recording the Notes
switch (it is writing). Both render at any depth — real libraries hold them
below the page's own children (a migrated or edited tree) — and their caption
lines take the outliner bullet the rest of the renderer draws
(`bullet="" if depth else None`; a bool there is not a marker and used to abort
the whole export).

Those segment links are the document's only *local* references, so the export
writes them as URLs a downloaded file can actually follow: absolute, and naming
the workspace the export was made in (`…/api/assets/<hash>.m4a?ws=<workspace>`).
A bare `/api/assets/…` resolves against whatever base a PDF reader assumes, and
the same path fetched without `?ws=` answers from the reader's OWN default
workspace — the wrong library whenever the export came from a non-default one.
The origin is `GAMMA_PUBLIC_URL` when the deployment pins one (the knob the MCP
endpoints advertise by; a configured path prefix is kept), else the request's
own base, which carries a mounted root path. Nothing else is added: **no
session, no credentials, and never a share token** — an export is not a
capability, so a reader still needs their own Gamma login and access to that
workspace, and a view share does not become durable access to the workspace's
assets because someone exported the notes. `render_document(asset_link=…)` is
what applies this (`absolute_asset_link`); with no resolver the stored
references are written verbatim, which is what a standalone document wants.

Pagination is per line, not per block: the canvas breaks a page between lines
so nothing is ever clipped, and code lines carry their leading whitespace as an
x offset because wrapping drops spaces at the start of a line.

## The shared typesetting engine

`gamma/pdf_typeset.py` is what both PDF writers draw with — font choice per
character (Helvetica in four styles, Courier, Symbol, the non-embedded
STSong-Light CID font), AFM widths, span resolution through `vector_text`,
tokenizing, wrapping and the content-stream operators. Spans are
`(kind, payload, level, style)`; `style` is a `Style(bits, href)`, so the note
boxes pass `PLAIN` and the document passes emphasis and link targets through
the same layout code. Everything is laid out in the y-down display frame and
flipped into user space by one `cm`. `pdf_image.XObjectStore` is the shared
upload → image-XObject registry.

## Annotated-PDF export

`/api/pages/{id}/export-pdf`: highlights become standard `/Highlight` (or
`/Square` for area notes) annotations with the note text in the popup
(`gamma/pdf_export.py`) — `?highlights=0` skips that layer entirely. Every
`/Square` carries an `/NM` id (`Zotero-<key>`, deterministic from the block
id): Zotero's pdf-worker maps `/Square`→image annotation but silently DROPS
one without an id, while `/Highlight` imports id-less — without `/NM`, area
notes vanish in Zotero.

Handwriting blocks (`ink_url`) become `/Ink` annotations: one per look
bucket (colour × tool × size × opacity) of the group, `/InkList` polylines
mapped through the same rect → user-space conversion, `/BS /W` the mean
drawn width, the caption on the first, an `/NM`, and a private `/GammaInk`
string holding the bucket's `gamma-ink` strokes for a lossless re-import.
Same skip rule as highlights for ink still embedded in the file.

Native (iPad) `pdf_ink` blocks take the other route, because the honest one is
different: their editable source is Apple's private PKDrawing, which nothing
here can draw or turn into strokes, so the export places the annotation's
readable PICTURE as page content — its PNG `preview_asset` (the whole-block
rendering the viewer shows), or the per-stroke `.inkjson` derivative when the
preview is not readable — and claims nothing about vector editing. The picture
is drawn in the unrotated crop-local frame the native client records in
(`pdf-crop-top-left-v1`, the frame `frontend/src/native/inkBlock.js` maps from:
the declared frame is scaled onto the page's crop box and y flipped), so
/Rotate is deliberately NOT applied — the recording is already unrotated and the
viewer turns the page, picture included, exactly as it turns the handwriting on
screen. A block claiming a coordinate space this writer does not know, whose
geometry is self-contradictory, or whose assets are unreadable is left out and
logged rather than placed by guesswork; the response counts these pictures
apart from the annotations (`X-Native-Ink-Drawn`, page content not /Annots),
and `highlights=0` — "a clean PDF" — drops them with the rest of the annotation
layer. The pictures draw under a **Multiply** ExtGState (the file is stamped
`%PDF-1.4`, the version blend modes need): both renderings come from PencilKit
on a transparent background and `pdf_image` bakes that onto white, so a normal
draw would paste an opaque white rectangle over the very text the annotation
was written on — multiplied, the white parts let the paper through and dark ink
darkens it, like ink on paper (a light-coloured pen therefore darkens rather
than covers what is under it). Two limits worth knowing: the annotation's own
caption and child notes are not painted onto the page (they travel in the notes
document, the Markdown and Gamma exports), and the Zotero export's bundled PDF
copies still burn in highlights only.

### Notes drawn on the page

`?notes=1` adds a second layer from `gamma/pdf_notes.py` — every non-empty note
is *drawn on the page*, in the nearest patch of empty space, with a leader line
back to its highlight. Free space comes from pdfium page-object bounds
rasterized into an occupancy grid (display space, top-left origin, /Rotate
applied — same frame the viewer stores rects in) with a summed-area table
behind the candidate search; already-placed boxes are marked occupied so notes
never collide.

Notes are markdown, so `gamma/note_markup.py` splits each one into text spans
(`(TEXT, str, level)`, level ±1 = real super/subscript), inline-math spans,
display-math items and image items first; markdown emphasis/links/code are
stripped.

### Vector text (math and CJK) → Type 3 fonts

`gamma/vector_text.py` lays out what the base-14 fonts can't: `math()`
typesets LaTeX with ziamath, `glyphs()` shapes CJK per character with ziafont
(a *plain .ttf* — ziafont can't open the .ttc collections most CJK font
packages ship, hence `fonts-droid-fallback` in the Dockerfile; without it CJK
falls back to the non-embedded CID font, which pdf.js renders as latin
gibberish). Both return a `Drawing`: the **glyph placements** (which ziafont
glyph, standing for which character, at which baseline point and size) and,
separately, path ops for the non-glyph shapes (fraction bars, radical
vincula, `\boxed{}` frames). ziamath is never asked for SVG — a flattened
`<path>` has lost the glyph's identity — but for its layout tree, which
`_walk` traverses exactly as ziamath's own `draw()` would (`nodexy` offsets,
phantoms skipped, stretched delimiters split into the MATH-assembly parts
they are built from); only the bar/box/strike leaves draw into a scratch SVG
that becomes path ops. `_paint` honours each shape's `fill`/`stroke`/`fill-rule`:
`\boxed{}` is a *stroked, unfilled* rect, and painting it solid turns the whole
equation into a black slab. SVG's y-down axis matches the display frame, so
positions drop in with a translate/scale; inline math and CJK sit on the text
baseline, `$$…$$` gets a centred row, and a box that had to shrink an
equation or picture loses to a wider candidate.

`gamma/pdf_glyphs.py` turns the placements into text. One `GlyphFonts` per
document builds **Type 3 fonts** — fonts whose glyph programs are PDF path
operators — from the same outlines: each distinct glyph is one `CharProc`
stored once per document (in the source font's own units, `FontMatrix` =
1/unitsPerEm, so one program serves every size), `Widths` come from the font's
advances, and a `/ToUnicode` CMap maps each code back to the character the
layout said it drew (the font's cmap as fallback), so the equation is
selectable, searchable and copies out as `α`, `∑`, `x`. `draw()` emits the
glyphs of a drawing as `Tf`/`TJ` runs — consecutive glyphs on one baseline
become a single `TJ` whose adjustments carry the exact layout positions — and
allocates codes as it meets new glyphs; a font takes 255 codes (single-byte),
then a second resource (`GmT30`, `GmT31`, …) opens. Font dictionaries are
allocated as indirect objects up front so pages (including the overlays
`pdf_notes` merges mid-way) can reference them, and `finalize()` fills them
in before the writer serialises — both writers call it last. Glyph programs
use `d1` (shape-only), so they take the fill colour in force where they are
shown. Nothing is rasterised and no font file is shipped; compared with
drawing every occurrence as filled paths the file shrinks (a repeated glyph
costs two bytes) and the text layer appears; every writer that draws MATH
spans owns a `GlyphFonts`, there is no path-only fallback.

Known upstream limit: ziamath 0.13 stretches `\left(…\right)` around a
`\sum`/`\int` with a runaway MATH-assembly (hundreds of extender parts, a
parenthesis ~2000 pt tall); `_pieces` refuses an assembly of more than
`MAX_ASSEMBLY_PARTS`, so such an expression takes the text fallback instead
of a page-tall bracket. When ziamath is missing or chokes,
`note_markup.latex_spans` falls back to a unicode approximation
(`\frac{a}{b}` → `a/b`, unknown commands keep their name so `\sin` works) —
tests cover both fallbacks.

### Images

`gamma/pdf_image.py` embeds `![](/api/uploads/…)` refs as image XObjects — JPEG
verbatim, 8-bit gray/RGB/palette PNG verbatim too (PDF's `/Predictor 15` IS PNG
row filtering), alpha/16-bit PNG unfiltered in Python onto white (hence
`MAX_PIXELS`). A palette's `/Indexed` lookup must be a `ByteStringObject`: as a
text string PyPDF2 re-encodes it to UTF-16 and the picture comes out one flat
colour.

### Fonts and content streams

Text is a hand-built content stream merged with `merge_page` using three fonts
every viewer has: Helvetica (WinAnsi), Symbol (Greek/math —
`pdf_typeset.SYMBOL` holds codes AND advance widths measured from the font
itself; every `note_markup.SYMBOLS` value must be drawable by one of the three,
which a test enforces), and a non-embedded STSong-Light CID font for CJK —
plus the per-document Type 3 fonts above for typeset math and CJK outlines.
Deliberately no reportlab/Pillow dependency. PyPDF2 leaves merged content
inline in the page dict; it must be re-added as an indirect object or the file
is unreadable. The document writer's page streams and every glyph program are
Flate-compressed (`flate_encode`); the overlay streams `merge_page` produces
stay as PyPDF2 leaves them.
