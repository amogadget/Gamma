# Obsidian: the vault format, and what an import/export must speak

Survey made in September 2026 from the official help site (`obsidian.md/help/…`),
the official Importer plugin's source (`obsidianmd/obsidian-importer`) and
migration write-ups (Logseq, Notion, Bear, Joplin → Obsidian), before the
Obsidian import/export was written. The mechanics Gamma ended up with are in
[docs/dev/import_export.md](../dev/import_export.md); this note keeps the
findings and the reasons behind the mapping.

## What a vault is

A vault is a plain folder. Every `.md` file is a note whose **title is its
filename** (no front-matter `title`, no H1 convention); directories are the
only hierarchy. Next to the notes sit attachments (images `.avif .bmp .gif
.jpeg .jpg .png .svg .webp`, audio, video, `.pdf`), `.canvas` files (JSON
Canvas), `.base` files, and a `.obsidian/` configuration folder (settings,
plugins, `workspace.json`) that carries no note content. There is no manifest
and no id: identity is the path.

Filenames may not contain `[ ] # ^ |` on any OS (they break link syntax),
plus the OS set (`* " \ / < > : ?` on Windows) and may not start with `.`.
The links page lists `# | ^ : %% [[ ]]` as characters that make a note name
unlinkable.

## Obsidian Flavored Markdown

CommonMark + GFM + LaTeX, plus:

- **Wikilinks** `[[Note]]`, `[[Note.md]]`, `[[Folder/Note]]` (vault-root
  path, forward slashes), `[[Note#Heading]]` (chains `#A#B` for nested
  headings), `[[Note#^blockid]]`, `[[#Heading]]` (same note),
  `[[Note|display text]]`, and any combination (`[[Note#Sec|label]]`).
  Non-note targets keep their extension: `[[Figure 1.png]]`. Inside a table
  cell the pipe is escaped: `[[Note\|label]]`.
- **Markdown links** are the alternative the "Use Markdown links" setting
  writes: `[Note](Note.md)`, `[Note](Projects/Note.md)`, `%20` for spaces (or
  `<a path with spaces.md>`), `[x](Note.md#Heading)`.
- **Embeds** are a `!` in front of either link form: `![[Note]]` (whole
  note), `![[Note#Heading]]` (the section), `![[Note#^id]]` (one block —
  a transclusion, kept live), `![[img.png]]`, `![[img.png|300]]` (width),
  `![[img.png|300x200]]`, `![[doc.pdf]]`, `![[doc.pdf#page=3]]`,
  `![[doc.pdf#height=400]]`, audio/video/canvas the same way. Markdown-style
  images take the size in the alt slot: `![alt|300](path)`, `![300](url)`.
  Whether non-numeric pipe text on a wikilink embed is an alt is not
  documented.
- **Block identifiers**: ` ^id` appended to a paragraph's last line, or on
  the bullet line of a list item; for whole lists, quotes, callouts, tables
  and fences the id goes on its own line after the block with blank lines
  around. Ids are Latin letters, digits and dashes (`^quote-of-the-day`;
  auto-generated ones are six hex chars). Parts of quotes, callouts and
  tables cannot be linked.
- **Callouts** `> [!type] Optional title` then `> ` body lines; `+` / `-`
  right after `]` make them foldable (open / collapsed). Types are
  case-insensitive; unknown types render as `note`. The names: `note`,
  `abstract` (`summary`, `tldr`), `info`, `todo`, `tip` (`hint`,
  `important`), `success` (`check`, `done`), `question` (`help`, `faq`),
  `warning` (`caution`, `attention`), `failure` (`fail`, `missing`),
  `danger` (`error`), `bug`, `example`, `quote` (`cite`).
- `==highlight==`, `~~strike~~`, `- [ ]` / `- [x]` tasks (any character in
  the box counts as done; `[/]` and `[-]` are conventions), footnotes
  `[^1]` and inline `^[…]`, `%%comments%%` (inline or a block between `%%`
  lines, hidden in reading view), `$…$` / `$$…$$` math, ` ```mermaid `,
  tables with `\|` escapes. Markdown inside raw HTML elements is not rendered.
- **Tags**: inline `#tag`, letters/digits/`_`/`-`/`/` (nested `#a/b`),
  Unicode allowed, must contain a non-digit, case-insensitive.

## Properties (front matter)

YAML between `---` lines. Types: text, list, number, checkbox, date,
date-time, tags; a name's type is fixed vault-wide once assigned. The
built-ins are `tags`, `aliases`, `cssclasses` (older `tag`, `alias`,
`cssclass` still occur), plus Publish keys (`publish`, `permalink`,
`description`, `image`, `cover`). Lists are written as `- item` lines (flow
`[a, b]` works); tags carry no `#`. A wikilink in a property must be quoted:
`source: "[[paper.pdf]]"`. Nothing else is special: any key is just data.

## Link resolution (partly community knowledge)

A bare `[[Name]]` resolves to the note with that basename anywhere in the
vault, case-insensitively; the "New link format" setting decides what the
app writes (shortest path when possible / relative / absolute) but any of
the three is read. When two notes share a basename the app writes the folder
path; the official Notion importer follows the same rule (`[[Title]]` when
unique, `[[path/Title|Title]]` otherwise). Attachments resolve the same way
by filename, whatever the attachment-folder setting (`attachmentFolderPath`:
vault root, a fixed folder, the note's folder, or a subfolder next to it).

## How the official Importer plugin maps other apps

- **Notion**: strips the 32-hex id from names (`/[ -]?[a-z0-9]{32}(\.|$)/`),
  writes `[[Title]]` (path form when ambiguous), attachments as
  `![[file|file]]`, `<aside>` callouts as `[!important]`, toggles as
  headings, property tables as YAML, tags with spaces → hyphens.
- **Logseq** ("flatten outlines"): `id:: uuid` lines become ` ^shortid`
  suffixes on the previous line, `((uuid))` → `[[Page#^id]]`,
  `{{embed ((uuid))}}` → `![[Page#^id]]`, `{{embed [[Page]]}}` → `![[Page]]`,
  all skipped inside fences; `alias::`/`title::` → `aliases`, `tags::` →
  `tags`, `hl-*` / `ls-*` / `logseq.*` properties dropped; task keywords →
  `[ ]` / `[x]` / `[/]` / `[-]`; bullets that are headings become headings,
  runs of leaf bullets become real lists, lone bullets become paragraphs,
  `#[[Long tag]]` → `#Long-tag`. Bullet-per-line vaults are considered
  awkward in Obsidian, which is why flattening exists.

## What an export from another app is expected to look like

Folder = directory, one `.md` per note named by its title, attachments in one
`attachments/` folder referenced by filename, `[[Title]]` links (path form
when ambiguous), `^id` anchors only on blocks that are actually linked,
metadata as `tags` / `aliases` plus free properties, outlines flattened to
headings, paragraphs and genuine lists, no `.obsidian/` folder.

## What this meant for Gamma

- **Import** is the existing Markdown-zip importer with the vault dialect
  added, not a separate path: wikilinks and embeds (notes, headings, block
  ids, images with sizes, PDFs) resolve vault-wide by basename after the
  relative path, `^id` anchors and heading texts become the block targets of
  `[[Note#…]]` links, `![[Note#^id]]` becomes a Gamma synced block, whole-note
  and section embeds degrade to mentions (a Gamma embed shows one block),
  `tags` become labels, `aliases` are kept, fold markers are dropped from
  callouts, `%%comments%%` are removed in a vault, `.obsidian/`, `.trash/`
  and `.canvas` are skipped. A vault note's title is its filename.
- **Export** writes a vault, not the readable Markdown: the tree is
  flattened the way the Logseq importer does (top-level headings and
  paragraphs, deeper blocks as nested lists), pages link by title
  (`[[Title]]`, `[[Folder/Title]]` when ambiguous), block mentions and synced
  blocks become `[[Title#^id]]` / `![[Title#^id]]` with ` ^id` written on the
  target, a heading target links as `[[Title#Heading]]`, highlights are
  `[!quote]` callouts whose title links the bundled PDF's page
  (`[[paper.pdf#page=3|p. 3]]`), the PDF sits in `attachments/` and is the
  quoted `source: "[[paper.pdf]]"` property, labels become `tags`. The Gamma
  format stays the lossless route; the vault is for reading and writing in
  Obsidian and imports back through the vault importer.
