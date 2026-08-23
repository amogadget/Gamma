# The Gamma folder agent

When you open the AI chat from the **home page or a folder view** (not inside a
paper), it is more than a chatbot: it can act on the folder you are looking at,
using tools the server executes on its behalf. This document describes exactly
what it can see and do.

## What the AI can do

| Tool | Permission | What it does |
|---|---|---|
| `list_pages` | Read | List the folder's pages: id, title, kind (pdf/note), folder paths, labels, cached metadata (first author, year, venue), last-update date |
| `read_page` | Read | Read one page: an excerpt of the paper's extracted PDF text (up to 20 000 characters) plus your highlighted passages and notes |
| `search_pdfs` | Read | Full-text search over the folder's PDF contents (the same index behind Ctrl+F), returning snippets with page numbers |
| `rename_page` | Organize | Change a page's title |
| `move_page` | Organize | File a page into a (sub)folder — a new path creates the folder; memberships outside the current folder are kept |

Typical uses: *"rename these to AuthorYear style"*, *"file the readout papers
into a subfolder"*, *"which of these papers measure T1? summarize the
approaches"* — the last one works by searching, then reading the relevant
papers and your notes.

## What it can never do

- Delete anything — pages, notes, folders, files.
- Edit your notes, highlights, or flat labels.
- Touch any page outside the folder you are viewing (enforced by the server on
  every call, not just by instructions).
- Reach uploads, share links, settings, or other users' data.

Every change it makes is reversible with another rename/move, and each one is
shown in the reply as a ✎/📁 line, so there is always a visible record.

## Permissions

Settings → Assistant → **Folder agent**:

- **Read papers & notes** — arms `list_pages`, `read_page`, `search_pdfs`.
- **Organize files** — arms `rename_page`, `move_page`.
- **Tool rounds** — how many AI ↔ tool round-trips one message may use
  (a runaway guard; work is separately capped at 200 changes per message).

Turning both off makes the home/folder chat a plain conversation. Disarmed
tools are not offered to the model, and the server additionally refuses to
execute them if called.

## How it works

1. Each message you send from a home/folder chat carries the current folder
   path; the server scopes every tool to it, per message — switching folders
   re-scopes the next message (and each folder keeps its own conversation).
2. The model runs a loop: call tools → the Gamma server executes them → the
   results go back to the model → repeat, until it answers. Text streams
   normally; applied changes stream as action lines.
3. When the loop finishes with changes applied, the library view refreshes.

Folder conversations follow folder renames and moves, and are deleted with
their folder.

## Privacy

Whatever the tools return — page titles, metadata, PDF text excerpts, your
highlights and notes, search snippets — becomes part of the conversation sent
to **your configured AI provider** (Settings → AI providers). Nothing is sent
anywhere else, and nothing is sent at all in a paper view or with both
permissions off beyond the normal chat context.
