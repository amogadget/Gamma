# Gamma user guide

A quick tour of everything you can do. For install instructions see the [README](../README.md); for what the AI agent may touch, see [the agent tools guide](dev/ai_tools.md).

## Getting started

- **Add a paper**: click **+** in the topbar and paste any link (arXiv, DOI, or a publisher page — Gamma finds the PDF), or upload PDFs, or just **drag files or whole folders into the window** (subfolders become library folders). "New page" creates a page without a PDF; the paperclip on a page attaches (or later detaches) one.
- **Log in as guest** to try things out — guest data resets daily.
- On open, each paper's title/authors/venue are fetched automatically (arXiv → DOI → AI).

## Reading & highlighting

- **Highlight**: select text with the mouse → a small popup offers four colors. Pick one and the highlight becomes a note block, already focused so you can type a comment. The chain button in the same popup links the selection to another paper or URL instead.
- **Area highlight / screenshot**: **hold Ctrl and drag a rectangle** on the page. Two things happen at once:
  - the region is cropped as an image and attached to the AI chat, ready to ask about a figure or table;
  - the color popup appears — pick a color to also keep it as a rectangular highlight (its note card shows a thumbnail of the region).

  On a phone there's no Ctrl — use the text/rectangle mode toggle in the zoom column.
- **Click a highlight** to jump to its note (and quote it into the chat). **Right-click** it to recolor, link it to a paper, copy it as a reference point (also copies a deep link to the exact passage), or delete it.
- Highlights with a comment show a small **speech-bubble badge** — hover it to read the note in place.
- **Zoom**: Ctrl+wheel (anchored at the cursor), pinch on touch, or the +/−/fit buttons on the right edge. Zoom and reading position are remembered per paper and synced across devices.
- **Links in the PDF are clickable**: internal ones jump within the document; a citation to a paper already in your library opens it, otherwise you're offered *Fetch into Gamma* or *Open in browser*. **Alt+←** (or the Back button) unwinds jumps, across documents too.
- **Dark pages**: Settings → General → "Flip page colors" inverts the page for night reading (display only).

## Notes

Notes live in the **Notes panel** as a nested outline. Highlights and free notes are the same kind of block.

- **Click a note** to jump the PDF to its highlight; click a highlight to jump to its note. Ctrl+click a note's card adds its quote to the chat selection.
- **Editing**: Enter inserts a line break, **Shift+Enter starts a new note** (swap the two in Settings → Notes). **Tab / Shift+Tab** indent and outdent. Backspace in an empty note deletes it. Drag the **⋮⋮ handle** to reorder or re-nest.
- **`[[` links** between notes and pages, with autocomplete; inserted references are clickable chips, and a **Backlinks** section shows who links here.
- **Markdown + math**: `$…$` / `$$…$$` render with KaTeX, with a live preview and `\command` autocomplete while typing. Paste or drag images straight into a note.
- An existing note can be attached to a highlight later: the **⊕** on its row starts attach mode — then click the highlight.
- Copying rendered notes keeps the formatting: math comes out as LaTeX source, rich text pastes into Word/PowerPoint.

## AI chat

Open the chat from the **⋮ menu → AI Chat**. Configure providers in Settings → AI providers — Anthropic or OpenAI keys, any OpenAI-compatible gateway, or sign in with your **ChatGPT subscription** (no API key).

- **Enter sends**, Shift+Enter is a newline. The **model and effort switchers** are in the panel header.
- **Context**: in a paper the chat reads that paper's text automatically; the **PDF toggle** attaches the actual file (so the model sees figures and tables) — it turns itself off once the file has been sent in a conversation, to avoid re-billing it every message.
- **Add more**: paste images, Ctrl+drag a region of the page (see above), or use the **+ menu** to attach files or pick several papers from your library (optionally with your notes and highlights).
- **Quote passages**: click a highlight to set the chat's "Selection"; Ctrl+click more highlights to add up to six passages.
- **Library agent**: on the home page or in a folder, the chat can act on your library — list, read and search the papers in view, rename them, file them into folders (*"rename these to AuthorYear style"*, *"which of these measure T1?"*). Every tool call shows as a chip you can click to see exactly what it did; permissions are per-tool in Settings → Assistant. It can never delete anything or edit your notes. Details: [the agent tools guide](dev/ai_tools.md).
- Per message: **copy**, **edit & re-send** (pencil, discards the replies after it), and a **stop** button while streaming. **Ctrl+F inside the panel** finds text in the conversation. A mic button dictates into the input.
- Each paper and each folder keeps its own conversation; **New chat** starts over.

## Library & organization

The home page is a recents feed of all your pages, with a **Recently viewed** strip on top (its cards show a snapshot of where you left off — click × to remove one, everywhere).

- **Folders** are paths: drop a paper into `qc/neutral-atom` and the hierarchy builds itself. A paper can live in several folders at once — dragging onto a folder *adds* it there. Drop a paper on the **back row** inside a folder to take it out; drag a folder onto another folder to move its whole subtree.
- **Labels** are flat tags for cross-cutting facets (an author, a keyword). Edit both from the label row under a paper's title: type `name/` for a folder, anything else for a label.
- **Selection works like a file manager**: click selects, Ctrl+click toggles, Shift+click extends, **double-click opens**, Escape clears. Right-click for Open / Rename / Pin / Duplicate / **Move to folder** (a flyout with checkmarks) / Delete — acting on a multi-selection applies to all of it.
- **Sort** (modified / added / viewed / title) is remembered per folder; toggles switch grid/list and folders/files. Pin papers to keep them in a strip at the top.
- Card strips scroll sideways with a plain mouse wheel.

## Workspaces

A workspace is a separate library — its own pages, PDFs and chats. Your account starts with a personal one; the account menu (top right) lists every workspace you belong to and switches between them, and **Workspace settings…** opens Settings → Members & sharing.

- **Create** more for separate projects (papers vs. reading), or for a group: a lab workspace that several accounts share.
- **Invite** people by username as **owner** (manages members, can rename or delete), **can edit**, or **view only**. Members switch to the shared workspace from their own account menu; viewers see everything but change nothing.
- Links you copy carry the workspace, so a teammate opening one lands in the right library. Page share links still work for people outside the workspace.
- Uploads into a workspace count against the storage quota of whoever created it. Backups (Export / Import) are per workspace, in the same pane. Admins can additionally snapshot the whole server (every account and workspace) from Settings → Advanced → *Server backups* and download the snapshot as a zip.
- In the desktop app the toolbar's switcher lists your workspaces on the open server, then the servers themselves.

## Search

**Ctrl+F** searches everything at once: page titles, this paper's notes, this PDF's text, other notes, reference links, and the full text of every PDF in the library.

- **Filter chips**: type a label or folder name and press Tab — label chips match exactly, folder chips include everything beneath them.
- **Enter / Shift+Enter** step through matches; toggles for match-case and whole-word; the chevron collapses the result lists into a compact find bar.
- Matching is forgiving: "3000" finds "3,000-qubit", even across a line break. Opening a library hit loads the paper and scrolls to the highlighted match.

## Metadata, citations & sharing

- The **(i) button** in the Notes panel's title row opens the metadata popover: title, authors, venue, year, DOI, arXiv — all editable (Enter saves), with **↻ refetch**, an AI title-fill button, and a health check of the extracted PDF text (with a preview of what the AI actually reads).
- The **chain-link (share) button** in the topbar creates a read-only share link — anyone with the link sees the PDF, highlights and notes, no login. The same popover holds the **BibTeX** entry and a slide-ready **citation** that pastes into PowerPoint with real italics, each with a copy button.
- Settings → Library shows a per-paper metadata and search-index health table with batch retry.

## Import & export

Both live in the **⋮ menu**.

- **Import…**: annotations already embedded in the open PDF (SumatraPDF, Acrobat, Preview…), a **Zotero library** (File → Export Library as Zotero RDF with files & notes, zipped — collections become folders, tags become labels, reader annotations become highlights), or a Logseq `.pdf + .edn` pair. The **strip** switch rewrites the stored PDF without the embedded annotations so nothing renders twice.
- **Export…**: one paper as **PDF** (highlights become real annotations; notes can be drawn onto the page with leader lines — math, CJK and images included), **Markdown**, or a **Logseq graph** zip. Switches choose which layers to include.
- **Backup**: account menu → Backup & restore — a zip of your entire account (databases + uploads), restorable in the same menu.

## Panels, tabs & navigation

- The Notes and Chat windows are dockable: **drag the ⠿ grip** to dock them left, right, or bottom (drop position decides the order); **double-click the grip to collapse** a window to its header bar and back; **×** closes it (reopen from the ⋮ menu). Drag the dividers to resize. Each paper remembers its own layout.
- **Tabs** sync to your account across devices. Middle-click closes a tab; right-click pins it (pinned tabs can't be middle-closed and stay left); drag to reorder.
- **Back** (topbar, or **Alt+←**) unwinds link jumps with their exact scroll positions; right-click it to clear the stack.
- On a phone everything becomes full-screen views behind a bottom tab bar (Library/PDF · Notes · Chat).

## Shortcut cheat sheet

| Keys | Does |
|---|---|
| Ctrl+F | Search everything (find-in-chat when the chat is focused) |
| Enter / Shift+Enter | In search: next / previous match. In notes: line break / new note (swappable). In chat: send / newline |
| Tab | Accept a search filter chip · indent a note |
| Alt+← | Back through link jumps |
| Ctrl+wheel | Zoom the PDF at the cursor |
| Ctrl+drag on the page | Capture a region → chat image + optional area highlight |
| Ctrl+click a highlight | Add its quote to the chat selection |
| Double-click | Open a library card · collapse/expand a window (on its grip) |
| Middle-click a tab | Close it (pinned tabs are protected) |
| Escape | Close popovers, clear selections, cancel modes |
