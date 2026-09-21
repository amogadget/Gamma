<picture>
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/branding/gamma-hero-light.svg">
  <img alt="Gamma PDF — read papers, keep what you learn: a highlighted paper next to its outliner notes with a live-rendered equation" src="./docs/assets/branding/gamma-hero-light.svg" width="100%">
</picture>

# Gamma PDF Annotator

**Organize papers and knowledge, in one place.** Self-hosted, multi-user, Logseq-inspired: read and annotate PDFs in your browser, keep the notes as a nested outliner, and link everything together.

[![Release](https://img.shields.io/github/v/release/tim4431/Gamma?filter=v%2A&style=flat&label=release&color=2563eb)](https://github.com/tim4431/Gamma/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/tim4431/Gamma?style=flat&logo=github&color=eab308)](https://github.com/tim4431/Gamma/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/tim4431/Gamma?style=flat&logo=github&color=8b5cf6)](https://github.com/tim4431/Gamma/forks)

<a href="https://apps.microsoft.com/detail/9N8WGWR2J2MV">
  <img src="https://get.microsoft.com/images/en-us%20dark.svg" alt="Download Gamma from the Microsoft Store" width="240">
</a>

**[Install](#install)** · **[User guide](./docs/user_guide.md)** · [Website](https://gammapdf.com) · [Releases](https://github.com/tim4431/Gamma/releases)

Every picture below is clickable and opens the matching part of the [user guide](./docs/user_guide.md).

## Read from any place

<a href="./docs/user_guide.md#offline-copies"><picture>
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/branding/gamma-anywhere-light.svg">
  <img alt="One library on the lab server, open on a desktop, an iPad and a phone; a note typed from the iPad appears on every other device as the sync between them runs" src="./docs/assets/branding/gamma-anywhere-light.svg" width="100%">
</picture></a>

Your library lives on your server and opens from any browser: the office desktop, the iPad (with the Pencil), your phone. Reading position, open tabs and zoom follow your account from device to device.

- **Offline copy** — keep a full copy of a workspace on your laptop with the desktop app (one click on the workspace's *clone* chip) or on any second Gamma. Read and write it on the train; it syncs itself when the connection returns — edits merge block by block, and the rare conflict is shown on its block with both versions rather than lost.
- **Install it** — Safari → *Add to Home Screen* on the iPad, *Install Gamma* in Chrome or Edge, or the desktop app for Windows, macOS and Linux.

→ Guide: [Offline copies](./docs/user_guide.md#offline-copies) · [Install as an app](./docs/user_guide.md#install-as-an-app)

## Highlight, annotate and draw

<a href="./docs/user_guide.md#reading-and-highlighting"><img alt="Highlight a sentence, add a linked annotation, then circle a claim, draw an arrow, and highlight with ink" src="./docs/assets/demos/demo-annotate-and-ink.webp" width="100%"></a>

Open a paper by pasting any link — arXiv, DOI, or a publisher page; Gamma finds the PDF and falls back to a legal open-access copy when the DOI is paywalled — or drag the file in. Then:

- **Highlight** — select text or drag a box around a figure, pick a color, add a comment. Each highlight becomes a block in your notes. Highlights already saved in the file by Acrobat, Preview or SumatraPDF come in as blocks too.
- **Draw** — with a stylus or the mouse: circle a claim, sketch an arrow, highlight freely. Lasso strokes to move, resize, rotate or recolor them; erase whole strokes or part of one. Ink is a note block linked to its place on the page.
- **Follow citations** — references in the PDF are clickable; a global **← Back** unwinds jumps across documents, and a cited arXiv/DOI paper is one click from your library.

→ Guide: [Reading and highlighting](./docs/user_guide.md#reading-and-highlighting) · [Draw with a pen](./docs/user_guide.md#draw-with-a-pen) · [Links inside the PDF](./docs/user_guide.md#links-inside-the-pdf)

## Take notes

<a href="./docs/user_guide.md#notes"><img alt="Type markdown and a live LaTeX equation, add a callout, then paste a picture and drag to resize it" src="./docs/assets/demos/demo-notes.webp" width="100%"></a>

Highlights and free notes are the same kind of block, so a paper's notes and a plain page are edited the same way:

- **Outliner** — Enter for a new block, Tab / Shift+Tab to nest, drag to reorder, one undo history for the whole page.
- **Live preview, Obsidian-style** — markdown, `$…$` / `$$…$$` math, code fences, callouts and tables render in place while the block you're on stays raw. Math gets bracket-pair coloring, `\command` autocomplete, and Tab hops between `{}` arguments.
- **Pictures and tables** — paste a screenshot and drag its edge to size it; tables are edited cell by cell, never as raw markdown.
- **Link and embed** — `[[page]]` mentions, `![[block]]` embeds that edit the source in place, backlinks, and a "/" menu for everything else.

→ Guide: [Notes](./docs/user_guide.md#notes)

## Ask an AI about your papers

<a href="./docs/user_guide.md#ai-chat"><img alt="Ask a complex question in PDF Chat, follow a citation to the source passage, then box-select a figure and ask a follow-up question" src="./docs/assets/demos/demo-native-agentic.webp" width="100%"></a>

- **Chat with the open paper** — ask about it, paste figures, dictate by voice, or attach the whole PDF so the model sees tables and plots. Answers cite pages; a click jumps the PDF to the passage. Use Anthropic or OpenAI models, or sign in with your ChatGPT subscription — no API key.
- **Mention a paper** — type `@` to attach a library page; its text stays in context for follow-ups.
- **Put the agent to work** — ask it to search your library, read papers, compare findings, rename pages or file them into folders. Expand each tool step to inspect what it did; it can never delete anything.

→ Guide: [AI chat](./docs/user_guide.md#ai-chat) · [The library agent](./docs/user_guide.md#the-library-agent)

## Link and organize

<a href="./docs/user_guide.md#library-and-organization"><picture>
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/branding/gamma-library-light.svg">
  <img alt="Gamma fills metadata when a paper is downloaded, organizes papers with folders and labels, searches titles, notes and PDF text, and follows references to other papers with Back returning to the previous reading position" src="./docs/assets/branding/gamma-library-light.svg" width="100%">
</picture></a>

- **Folders** build themselves from the paths you use: drop a paper into `qc/neutral-atom` and you get **qc › neutral-atom**; storage stays flat, so one paper can live in several folders.
- **Labels** are flat tags for facets like an author or a keyword — one click to filter by.
- **Metadata** fills itself on open (arXiv → DOI → AI) and is editable; one click copies BibTeX or a slide-ready citation with real italics.

<a href="./docs/user_guide.md#search"><img alt="Search titles and PDF text from home, narrow with a folder chip, and open a highlighted match" src="./docs/assets/demos/demo-library.webp" width="100%"></a>

- **Search everything** — `Ctrl+F` searches notes, highlights and the full text of every PDF at once; narrow with label and folder chips. Matching is forgiving: "3000" finds "3,000-qubit" across a line break.

→ Guide: [Library and organization](./docs/user_guide.md#library-and-organization) · [Search](./docs/user_guide.md#search) · [Metadata and citations](./docs/user_guide.md#metadata-and-citations)

## Share and work together

<a href="./docs/user_guide.md#workspaces"><picture>
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/branding/gamma-workspaces-light.svg">
  <img alt="Personal workspaces next to a shared research library where an owner and an editor type into two blocks of the same page at the same time and a viewer reads along" src="./docs/assets/branding/gamma-workspaces-light.svg" width="100%">
</picture></a>

- **Workspaces** — keep separate personal libraries, or collaborate in a shared library created by a server administrator: owners manage members, editors change pages, viewers read.
- **Share a page** — send a link to an annotated paper; invite people with view or edit rights, or open it to anyone with the link.
- **Edit together** — changes and cursors appear live; edits to different blocks coexist, same-block edits merge.

→ Guide: [Sharing a page](./docs/user_guide.md#sharing-a-page) · [Workspaces](./docs/user_guide.md#workspaces)

## Connect your research

<a href="./docs/user_guide.md#assistants-codex-and-claude-code"><picture>
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/branding/gamma-connections-light.svg">
  <img alt="Gamma in the middle of an assistant prompt that mentions @Gamma and a paper, the Obsidian, Notion and Zotero import and export arrows, and the Gamma Connector saving a paper with the publisher sign-in kept per journal" src="./docs/assets/branding/gamma-connections-light.svg" width="100%">
</picture></a>

- **Assistants** — the [Gamma plugin for Codex and Claude Code](./plugins/gamma/) lets either assistant search and read your papers, notes and highlights, read-only, for a workspace you approve in the browser: *"@Gamma, in the Rydberg arrays paper, how is the blockade radius measured?"* Setup is one command copied from **Settings → AI → Integrations**; any other MCP client connects with the same URL.
- **Gamma Connector** — the browser extension ([extension/](./extension/)) saves the paper you're reading in one click — PDF, metadata, folder, labels — from the arXiv / DOI / publisher tab, and clips links or selections into your notes. Its cookie button saves your **publisher sign-in per journal**, so the server can fetch that journal's PDFs on its own from then on.
- **Import** — Zotero libraries and Logseq exports with their annotations; Obsidian vaults, Notion exports and Markdown folders as notes. **Export** — annotated PDF, Markdown, an Obsidian vault, a Logseq graph, a Zotero library, or a Gamma zip another Gamma can merge.

→ Guide: [Assistants: Codex and Claude Code](./docs/user_guide.md#assistants-codex-and-claude-code) · [Gamma Connector](./docs/user_guide.md#gamma-connector) · [Import and export](./docs/user_guide.md#import-and-export) · [Backups](./docs/user_guide.md#backups)

---

## Install

### Downloads

Get the Windows app from the [**Microsoft Store**](https://apps.microsoft.com/detail/9N8WGWR2J2MV), or download standalone installers from [**GitHub Releases**](https://github.com/tim4431/Gamma/releases/latest).

- **Desktop app** (Windows installer, macOS dmg, Debian/Ubuntu deb) — a self-contained Gamma with local libraries on your disk, no Docker, Python or Node. It also opens any Gamma server you host (the NAS, a VPS) and keeps [offline copies](./docs/user_guide.md#offline-copies) of its workspaces. Details: [desktop/](./desktop/). Builds are not notarized: Windows SmartScreen → *More info → Run anyway*; macOS says *Apple could not verify Gamma* on first launch → *System Settings → Privacy & Security → Open Anyway* (once); Linux: `sudo apt install ./Gamma-<version>-linux-amd64.deb`. Windows and Linux apps update themselves.
- **iPad, phone, any browser** — open your server and install it from the browser; see [Install as an app](./docs/user_guide.md#install-as-an-app).
- **Gamma Connector** browser extension (`gamma-connector-<version>.zip`, in its own `extension-v<version>` release) — unzip, then `chrome://extensions` → *Developer mode* → *Load unpacked*.
- **Server** — the Docker image below, built from `main` on every merge.

### Quickstart

```bash
docker run -d --name gamma -p 9001:9001 -v gamma-data:/data ghcr.io/tim4431/gamma:latest
```

Open <http://localhost:9001> and log in as `admin` — a fresh instance seeds the account itself and prints its password once to the log (`docker logs gamma`). No environment variables needed.

### Docker Compose (recommended)

Copy the template (the real file is gitignored, so local tweaks never land in commits) and start:

```bash
cp docker-compose.yml.example docker-compose.yml
docker compose up -d
```

Open <http://localhost:9001> and log in with the seeded `admin` password from `docker logs gamma` (printed once on first start). Accounts, notes and uploaded PDFs live under the container's `/data` volume and survive upgrades.

Backups: a workspace exports as one zip from Settings → Workspaces, snapshots live in Settings → Backups, and administrators snapshot the whole instance from Settings → Server (restore those with the server stopped: `manage.py backups --restore`) — see [Backups](./docs/user_guide.md#backups) and the [backup internals](./docs/dev/workspaces.md#export-and-backups). If you bind-mount `/data` to a host folder, set `PUID`/`PGID` to your user's ids (`id -u` / `id -g`) so the files belong to you instead of root.

Users are managed in the app: sign in with an admin account → Settings → Users (create/delete accounts, reset passwords, grant or revoke the admin privilege — admin is a flag, not a special name). The CLI equivalent still works:

```bash
docker exec gamma python manage.py create-user alice her-password
docker exec gamma python manage.py set-admin alice on
docker exec gamma python manage.py list-users
```

For assistants (Codex, Claude Code) signing in to a remotely hosted Gamma, an administrator confirms the **Public server URL** once in Settings → Server; it applies immediately, without environment variables or a restart.

<details>
<summary><b>Run from source (development)</b></summary>

Requires Python 3.11+ and Node 18+.

**Backend**

```bash
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python manage.py create-user admin yourpassword
python manage.py set-admin admin on                 # admin privilege → GUI user management
python manage.py setup                              # seeds the guest account
uvicorn app:app --host 127.0.0.1 --port 9001
```

**Frontend**

```bash
cd frontend
npm install
npm run dev        # :5173, proxies /api → :9001
```

Frontend source is grouped by function (`editor/`, `pdf/`, `settings/`, and
others), with startup/session code in `app/` and reused code in `shared/`.
See the [frontend source map](./frontend/src/README.md) for file locations and
naming conventions.

**Tests**

For local changes, run tests for the affected modules and their direct consumers;
see the [test selection policy](docs/dev/debugging.md#local-changes-test-the-affected-modules)
for targeted backend, frontend, and browser commands. The commands below run
full suites, which also run in PR CI.

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest tests -q
```

In-process API tests against a throwaway data dir — auth, the block tree, metadata/BibTeX, PDF-annotation import, full-text search, sync, and export.

Frontend checks, from `frontend/`: `npm test` for module tests, `npm run build`
for the production bundle, and `npm run e2e` for the browser suite against an
isolated backend (requires backend dependencies and Playwright Chromium).

**Production without Docker** — build the frontend and let the backend serve it:

```bash
cd frontend && npm run build
cd ../backend
GAMMA_STATIC_DIR=../frontend/dist uvicorn app:app --host 127.0.0.1 --port 9001
```

Put a TLS-terminating reverse proxy (Caddy, nginx) in front of 9001 for a domain. If you use HTTP/3, consider limiting Caddy to `protocols h1 h2` — a Chrome QUIC bug can make large PDFs crawl.

</details>

<details>
<summary><b>Environment variables</b></summary>

| Variable | Required | Default | Description |
|---|---|---|---|
| `GAMMA_DATA_DIR` | No | `data/` at the repo root (`/data` in Docker) | Where `users.db` and the per-workspace data live |
| `GAMMA_STATIC_DIR` | No | unset (`/app/static` in Docker) | Built frontend to serve as SPA; unset = API only |
| `GAMMA_PORT` | No | `9001` | Listen port (Docker entrypoint only) |
| `GAMMA_ADMIN_USER` / `GAMMA_ADMIN_PASSWORD` | No | `admin` / random, printed to the log once | Overrides the account a **fresh** instance seeds itself at startup (only while no real accounts exist; never touched afterwards). Admins manage users from the GUI (Settings → Users) |
| `GAMMA_AI_ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Default Anthropic-protocol endpoint, e.g. `https://api.deepseek.com/anthropic` |
| `GAMMA_AI_OPENAI_BASE_URL` | No | `https://api.openai.com` | Default OpenAI-compatible endpoint |

AI is configured in the app, not the environment: each user adds provider entries under Settings → AI → Connections (pick the API format — Anthropic Messages or OpenAI Chat Completions — then a key, plus optional label, base URL, and model list), or connects a ChatGPT Plus/Pro subscription with *Sign in with ChatGPT* — OAuth, no key at all. Keys are stored server-side per user and never sent back to the browser. The base-URL variables above only change the per-protocol defaults shown in that dialog.

</details>

<details>
<summary><b>Docker image</b></summary>

Published to GitHub Container Registry on every push to `main` (`latest`) and on version tags (`v1.2.3` → `1.2.3`, `1.2`), for `linux/amd64` and `linux/arm64`:

```
ghcr.io/tim4431/gamma
```

Multi-stage build: a Node stage compiles the frontend, the final Python image runs FastAPI serving both the API and the SPA on port 9001. See [Dockerfile](./Dockerfile) and [.github/workflows/docker.yml](./.github/workflows/docker.yml).

</details>

## License

Gamma is licensed under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). Third-party components and assets retain their respective licenses.
