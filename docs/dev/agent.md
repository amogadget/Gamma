# The Gamma library agent

The AI chat is more than a chatbot: it can act on your library through tools
the server executes on its behalf. What it can reach depends on where the chat
is opened — every chat has a **scope**:

- **Folder chat** (home page or a folder view): the tools reach the pages in
  the folder you are viewing (library root = everything).
- **Paper chat** (inside an open paper): the tools reach only that paper, and
  only the reading tools exist there.

This document describes exactly what it can see and do.

## What the AI can do

| Tool | Permission | Scope | What it does |
|---|---|---|---|
| `list_pages` | List pages | folder | List the folder's pages: id, title, kind (pdf/note), folder paths, labels, cached metadata (first author, year, venue), last-update date. Can filter by label, subfolder, or title, or list just the label/folder vocabulary with counts |
| `read_page` | Read papers & notes | folder + paper | Read one page: an excerpt of the paper's extracted PDF text (up to the Settings "Read window" size per call, 20 000 characters by default; a page argument jumps straight to a search hit's PDF page and an offset argument continues where the last call stopped, so long papers are read in successive windows) plus your highlighted passages and notes |
| `search_pdfs` | Search PDF text | folder + paper | Full-text search over the reachable PDFs (the same index behind Ctrl+F), returning snippets with page numbers; when nothing matches every word, the closest hits for the most meaningful words are returned, marked as approximate |
| `rename_page` | Rename pages | folder | Change a page's title |
| `move_page` | Move pages | folder | File a page into a (sub)folder — a new path creates the folder; memberships outside the current folder are kept |

Typical uses: *"rename these to AuthorYear style"*, *"file the readout papers
into a subfolder"*, *"which of these papers measure T1? summarize the
approaches"* — and in a paper chat, *"where does this paper define the
protocol?"* (it searches inside the PDF and quotes page numbers).

## What it can never do

- Delete anything — pages, notes, folders, files.
- Edit your notes, highlights, or flat labels.
- Reach anything outside the chat's scope (enforced by the server on every
  call, not just by instructions).
- Reach uploads, share links, settings, or other users' data.

**Every tool call is shown in the reply** — reads included: listing, reading
and searching render as ☰/📖/🔍 lines, renames and moves as ✎/📁 lines — so
there is always a visible record of what the agent looked at and changed, and
every change is reversible with another rename/move.

## Permissions

Settings → Assistant → **Folder agent** — one toggle per tool (they apply to
both scopes):

- **List pages**, **Read papers & notes**, **Search PDF text**,
  **Rename pages**, **Move pages**
- **Tool rounds** — how many AI ↔ tool round-trips one message may use
  (a runaway guard; work is separately capped at 200 changes per message).
- **Read window** — the most document text one `read_page` call may return
  (default 20 000 characters). The agent reads long papers in windows of this
  size; a larger window means fewer calls but more tokens per message.

Turning everything off makes every chat a plain conversation. Disarmed tools
are not offered to the model, and the server additionally refuses to execute
them if called.

The agent's base instructions are editable too: Settings → Prompts →
**Library agent**. The scope and permission lines are always appended
mechanically, so a custom prompt can change the agent's style but not widen
its reach.

## How it works

1. Each message carries its chat's scope (the current folder path, or the open
   paper's page id); the server scopes every tool to it, per message —
   switching folders re-scopes the next message, and each folder keeps its own
   conversation.
2. The model runs a loop: call tools → the Gamma server executes them → the
   results go back to the model → repeat, until it answers. Text streams
   normally; every tool call — reads, changes, and failures alike — appears in
   the chat as a chip you can click to see the exact arguments and the output
   the model got back.
3. Within one conversation the agent remembers its earlier tool calls and
   their results (recent results in full, older ones trimmed), so it doesn't
   re-list or re-read what it already saw.
4. When the loop finishes with changes applied, the library view refreshes.

Folder conversations follow folder renames and moves, and are deleted with
their folder.

## Privacy

Whatever the tools return — page titles, metadata, PDF text excerpts, your
highlights and notes, search snippets — becomes part of the conversation sent
to **your configured AI provider** (Settings → AI providers). Nothing is sent
anywhere else, and with every permission off nothing is sent beyond the normal
chat context.
