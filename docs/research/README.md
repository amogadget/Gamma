# Research notes

Findings, not tasks: how other products solve a problem, what was learned
from Gamma's own code before a redesign, and the reasoning behind the
design that was picked. Read these when a similar decision comes up again;
the current mechanics live in [docs/dev/](../dev/), which these notes never
duplicate.

| Note | Question it answers |
|---|---|
| [collaboration.md](collaboration.md) | How real-time collaborative editing is built elsewhere (OT, record-level last-writer-wins, CRDTs), why a snapshot autosave cannot collaborate, and why Gamma took the Notion / Linear / Figma shape. |
| [workspaces.md](workspaces.md) | What happens when identity and data location are one string, what a workspace model needs, and how to version a data directory so upgrades stay safe and steps do not pile up. |
| [handwriting.md](handwriting.md) | Which ink formats exist (InkML, Xournal++, PDF `/Ink`, tldraw, Excalidraw, reMarkable, PencilKit) and which are worth speaking, what stylus input the browser gives on each platform, what the upstream fork's native-iPad handwriting taught, and how Notability's pen, highlighter, eraser and lasso are set up. |
| [obsidian.md](obsidian.md) | What an Obsidian vault is (files, wikilinks, embeds, block ids, callouts, properties, tags), how the official Importer maps Notion and Logseq into it, what an export from another app is expected to look like, and the mapping Gamma's vault import/export chose. |
| [pdf_loading.md](pdf_loading.md) | Where a cold PDF open spends its time, the five moves the upstream fork made (range transport, server page sizes, server previews, keeping parsed documents, MRC flattening) with their measurements, which of them fit Gamma's workspace and derived-data model, the path chosen, and what measuring found that the survey had not (the worker script re-downloaded on every open). |

Conventions: one file per topic, dated where the survey has a shelf life,
written after the fact from what was actually found. Add a row here for
every new note.
