# AI: providers, chat, and the library agent

The AI stack in one place — provider storage and protocols, the `/api/ai/chat`
request/stream shape, and the library agent: what it can reach, how the tool
loop runs, and what the user controls. The tools themselves are catalogued in
[ai_tools.md](ai_tools.md); how long papers reach the model is
[ai_context.md](ai_context.md). Code: `gamma/ai_settings.py`,
`gamma/ai_client.py`, `gamma/ai_context.py`, `gamma/ai_tools.py`,
`gamma/chatgpt_oauth.py`, `gamma/routers/ai.py` + the chat-history router.

## Provider and models

There are NO env API keys; providers are per-user GUI entries (Settings →
Provider and models) stored under the reserved `ai-settings` prefs key in the user's
`data.db` — a LIST of `{id, name, protocol, api_key, base_url, models}` managed
via `POST/PUT/DELETE /api/ai/providers[/{id}]`. The generic prefs endpoints
refuse the key; the only read path is the masked `GET /api/ai/settings` (last-4
hint, never the key), guests can't write. `POST /api/ai/providers/{id}/test`
probes an entry with a tiny live completion for the settings list's Test button
— result in-body, never an HTTP error, and it clears the OAuth refresh backoff
so an expired ChatGPT grant is re-tried immediately. The probe's model:
the entry's optional `test_model` (editable in the form's Models step), else
the `model` sent with the request (the client passes its effective metadata
model — the cheap utility model), else the entry's first model. A failed probe
carries an `auth` flag on 401/403 so the row renders
"sign-in expired — reconnect" instead of the upstream body. Upstream error
details are summarized before display everywhere (`upstream_detail` in
`ai_client.py`): JSON bodies reduce to their message field, HTML error pages
(a proxy's 502 page) to their `<title>`.

`POST /api/ai/health` ({provider_id, mode}; "" = first entry) is the login
connection check (Settings → Provider and models → "Check at login",
localStorage `gamma-ai-login-check`, default on): mode `"ping"` verifies the
credential for free — OAuth entries hit the usage endpoint, API keys list
`/v1/models`, both 401 on a dead credential (404/405 = gateway without a
listing → ok-but-unverified, no false alarm) — and `"test"` runs the same tiny
completion as the Test button. The answer is always in-body
(`{configured, ok, auth?, error?}`); a failure renders as a warning strip in
the chat window ("authentication is broken — sign in again"), dismissed or
cleared by a passing Test / provider edit.

`ai_runtime(user)` in `gamma/ai_settings.py` builds the per-request config and
model registry (ids are `<entryId>:<model>`; the wire format comes from the
entry's `protocol`, never from the provider id) — AI endpoints must use it, not
module-level config constants for credentials or model routing. Env vars set
each protocol's administrator-controlled default base URL, including
`GAMMA_AI_CHATGPT_BASE_URL`.

The Provider and models pane also exposes `POST /api/ai/providers/{id}/usage`. For a
ChatGPT OAuth entry it reads normalized subscription rate-limit windows
(`used_percent`, `remaining_percent`, and reset time) without exposing the
bearer token. Opening the pane queries OAuth usage automatically (the Usage
button remains available for a manual refresh). Each window is one compact
summary line above the same progress meter used for storage quota, filled by
the percentage used. Each provider row also opens its model configuration,
where models can be fetched, added, or removed.
API-key protocols return an explicit unavailable result because OpenAI-
compatible and Anthropic-style providers do not share a portable quota API.
An expired ChatGPT sign-in answers in-body (`{available: false, auth: true}`
with a "sign in again" reason) rather than dumping the upstream 401.
The account request deliberately uses the administrator-controlled ChatGPT
protocol URL, not an entry field, and OAuth entries cannot edit their API key
or base URL; this prevents a settings request from redirecting a bearer token.
The ChatGPT account endpoint is provider-specific and may require maintenance
if its upstream contract changes.

### The chatgpt protocol (OAuth)

A third protocol, `chatgpt`, holds OAuth tokens instead of a key (Codex CLI's
PKCE flow in `gamma/chatgpt_oauth.py`; entries created only via
`POST /api/ai/oauth/chatgpt/start`+`complete` — the user pastes the
localhost:1455 callback URL since nothing listens there; access tokens refresh
lazily in `ai_runtime`). Its wire is the Responses API on
`chatgpt.com/backend-api/codex` (stream-only SSE; non-stream callers join
deltas), and PDF attachments go as native `input_file` parts with an automatic
retry as extracted text if the backend rejects them.

## Chat endpoint

`/api/ai/chat` speaks both the Anthropic Messages API and the OpenAI Chat
Completions API. Requests carry a model-registry id, optional `effort`
(→ Anthropic `output_config.effort` / OpenAI `reasoning_effort`; omitted unless
set — some models reject it), optional `system` override, pasted `images`
(data URLs → native image content parts), and the context PAGES: `pages`
(several — a report across pages) or, when empty, the one page of `page_id`
(the open page). A page's PDF attachment is derived server-side
(`blocks_store.page_attachment`) — `doc_id` is still accepted as a
compatibility input: it resolves to the page carrying that PDF
(`blocks_store.page_for_doc`) and does nothing when no page does; send
`page_id`, nothing new may depend on `doc_id`. `stream: true` (the chat UI's
mode) returns NDJSON lines of
`{"delta"}`/`{"error"}` parsed from the provider's SSE; upstream failures
before the first byte still return normal HTTP errors. The client turns a
failure with no reply text into an AI message carrying `error: true` — shown
as an error bubble, saved with the chat so it survives a reload, but left out
of the `history` it sends on later turns, and `build_messages` skips such
items too should an older client send them.

Context is *pages from the user's knowledge base* (`ai_context.gather_inputs`
→ `page_report_section`): each page contributes its title, a properties line
(folders, labels, cached metadata, web source, attachment) and its notes
tree; a page that carries a PDF adds the document's extracted text (a head
excerpt labelled as such when the document doesn't fit — see
[ai_context.md](ai_context.md)), or the PDF itself as a native document/file
content part when the request sets `attach_pdf`, and shows its notes only
with `include_notes`. A page without an attachment IS its notes, so they
always go — `include_notes` only means "also add my notes/highlights for PDF
pages". The built-in chat system prompt frames the model as working inside
that knowledge base and grounds claims about the pages in text actually read
(look details up or say they're absent, never fill gaps from memory; cite a
PDF by page number, say when something comes from the user's notes). With a
document in context, custom prompt or not, the citation instruction is
appended: link a passage as `[p. N](/?page=<id>&pdf_page=N&quote=…)` using
the `[PDF page N]` labels and the `Gamma page ID` each context section
carries ([pdf_citations.md](pdf_citations.md)).

Whatever went to the model is reported back: the stream's first line is
`{"context": [...]}` (non-stream: a `context` field) with one entry per
page — `title`, `doc_id` (`""` for a page without a PDF), `native` (the file
itself was sent), `native_requested`, `partial`, `chars`, `pages`,
`pages_shown` (uploaded `files` are reported the same way, and get the
single-page budget when they fall back to text). The chat saves it on the
reply and shows a chip only when
it matters: "Model saw pages 1–9 of 22" for a truncated paper, "PDF file not
accepted — sent as text" when the file was requested but the provider took
text instead. `/api/ai/models` marks each model `native_pdf` (false for
ChatGPT sign-in entries: their wire is the Codex backend, which refuses
`input_file` parts). The chat's PDF button doesn't default on for such a
model; switching it on by hand shows a warning pill, and pending uploaded
PDFs get the same warning on their chips.

PDF extraction (`gamma/pdf_text.py`) is serialized behind a lock — pdfium is
not thread-safe and overlapping extractions fail both — and reads up to
`MAX_PAGES` (5000, a runaway guard that logs when it bites; pages past it are
invisible to search AND read_page, so keep it far above real documents).

When the request carries a `selection` (quoted PDF passages), the single-paper
text context is selection-centered instead of head-of-document:
`selection_context` (`ai_context.py`) locates each passage's PDF page by
normalized-text match (`_locate_passage`, page-seam aware) and spends the
budget on a small head slice plus windows starting at those pages, labeled with
their page numbers; unlocatable selections fall back to the plain head excerpt.

### Mentioning library papers

Type `@` in the chat composer to search library titles with the same ranking,
typo tolerance, and separator matching as library search (`librarySearch.js`).
Arrow keys choose a result; Enter or Tab attaches it, Escape dismisses the
query, and clicking or tapping a result also works. Results include author,
year, venue, and folder details. A completed mention inserts the title and
adds a removable context chip; the chip controls which page IDs are sent.
The `+` menu offers the same library search. Up to six references can be
attached, plus the open page, with duplicates removed.

References persist for follow-up questions and are saved as `contextPages`
on each user message. Loading a conversation restores its last references;
editing an earlier message reuses that message's references. Each contributes
its title, metadata, summary, and PDF excerpt (or native PDF), with optional
notes/highlights. The multi-paper text budget is shared by valid pages; a
selection still centers the open paper's excerpt. Tool-enabled chats also
receive document maps labelled with page IDs.

Explicit references expand `read_page`, `read_block`, and `search_library`
access within the current workspace, even outside the original page/folder.
They never expand the editing scope. PDF search hits identify their Gamma
page IDs so the assistant can read further or cite the matching paper,
including when titles are identical. References are resolved server-side;
missing pages and non-page blocks are ignored.

### Pointing the chat at notes

Three optional request fields say what the message is about inside the
notes. The server resolves all three against the request's context pages.

- `focus_block_id` — the block row the cursor is on (`focusedId` in
  `App.jsx` → `focusedNote`). The chat shows it as a "Cursor" chip, like a
  PDF selection, and sends it with every message; the chip's × leaves it out
  until the cursor moves to another block. Its text and sub-blocks enter the
  context as an id-labelled outline ("The user's cursor is on this note
  block …"), and the agent prompt says "this block" / "here" mean that id.
  So *"expand this"* edits the right block without a `read_block` first.
- `context_blocks` — ids of blocks attached as chips: Ctrl+click a block
  row, or the ⋮⋮ handle menu's **Add to chat** (`onAddToChat` → `chatNotes`
  in App). Each is served as `[id] text` with its subtree indented
  (`ai_context.notes_focus_section`, the same form `read_block` uses), and
  the agent prompt lists the ids, so *"rewrite these"* means them. Capped at
  12 chips / 12k chars (`MAX_CONTEXT_BLOCKS`, `MAX_BLOCK_SECTION_CHARS`).
  Ids outside the context pages, and page ids, are dropped silently.
- `note_passages` — text selected in the rendered notes with Ctrl held (the
  mouseup handler in App.jsx). Plain selection is left alone so copying stays
  quiet; selections inside an open editor are ignored. Appended to the
  prompt like PDF passages ("selected the following text in their own
  notes"), 6 × 4000 chars.

Chips render in the composer's chip strip next to PDF passages ("Block" /
"Note" labels). They clear on send and on a page switch, since the ids
belong to the page. Ctrl+click on a highlight card sends the quote as a PDF
passage, not a block chip.

Reasoning models burn invisible tokens — keep `max_tokens` generous (empty
responses raise with the finish reason). `/api/ai/models` feeds the chat
panel's switchers and the prompt editor (four editable prompts: chat system,
metadata extraction, PPT citation — defaults in `ai.py` — and the library-agent
base prompt, default in `ai_tools.py`).

## The library agent

The chat is more than a chatbot: it can act on the library through tools the
server executes on its behalf ([ai_tools.md](ai_tools.md) describes each one).
What it can reach depends on where the chat is opened — every chat declares an
`agent_scope`:

- `"folder"` — the home/folder chat (`folder` = current path, `""` = root):
  tools reach the pages in that folder.
- `"page"` — the page chat (`page_id` = the focused page, with or without a
  PDF): tools reach only that page — the reading tools plus the note-block
  editors; the page-level organizers (list/rename/move) don't exist there.

The request also carries `permissions` (the tool map of the chat's KIND —
see below; missing key = allowed, so new tools default on) and
optional `agent_system` (custom base
prompt; the Prompts pane's "Library agent" entry, default
`ai_tools.AGENT_PROMPT` via `/api/ai/models`). The scope and permission lines
are always appended mechanically to the base prompt, so a custom prompt can
change the agent's style but not widen its reach. Everything off (or no/invalid
scope) = plain chat. Among those mechanical lines: with a reading tool armed,
the model is asked to link the pages it refers to as `[title](/?page=<id>)`,
which the chat opens in place (details in [ai_tools.md](ai_tools.md)).

### Permissions and knobs (Settings → Assistant)

The single **Enable tools** switch (`gamma-ai-agent-enabled`, default on)
governs tool use in every chat; every chat starts with tools on. The Tools
button (sliders icon) in each folder/PDF chat header toggles the configured tool set for that
chat only. New chat resets the switch back to on.

Which tools a chat may use is configured per chat KIND — there are three
(`CHAT_KINDS` in `prefs.js`, `CHAT_KIND_ROWS` in `settings.jsx`):

- **Folder chat** — the home/folder view (`agent_scope: "folder"`).
- **PDF chat** — a page with a PDF attached (`agent_scope: "page"`).
- **Notes chat** — a page without one (`agent_scope: "page"`).

Settings → Assistant → Tool configuration shows one row per kind whose
control is a `ToggleGroup` of icon + short-name chips (List, Read, Blocks,
Search, Rename, Move, Edit — folder scope offers all, page scope the reading
tools and the note-block editors); clicking a chip allows or forbids that
tool for every chat of the kind. The stored map is localStorage JSON
`gamma-ai-agent-perms` = `{folder, pdf, notes}` → `{list, read, block_read,
search, rename, move, block_edit}` (a pre-kind flat map is applied to every
kind on read). The chat header's ⚙ popover carries the same picker for the
kind of the chat it is opened in (`AgentToolPicker` in `settings.jsx`,
bound to the same map), so a change in either place is the same change.
`ChatDock` derives its kind from its props (`organizeFolder` set → folder;
else `pageAttach` → pdf; else notes) and sends that kind's map as the
request's `permissions`.

One permission per capability: List pages, Read pages, Read note blocks,
Search library (`search_library` — notes and PDF text; the stored key is
still `search`), Search papers online (`web_search` → `search_papers`), Fetch
documents (`web_read` → `fetch_paper`; both web tools are read-only and
described in [ai_tools.md](ai_tools.md)), Rename pages, Move pages, and Edit
note blocks (one chip arming `edit_block`/`create_block`/`move_block`
together). The "Read & search" preset (`chatSettings.js` `READ_TOOLS`)
includes the two web tools. Plus:

- **Tool rounds** (`gamma-ai-tool-rounds` → request `tool_rounds`, default 32,
  user-tunable 1–100) — provider round-trips one message may use.
- **Read window** (`gamma-ai-read-chars` → request `read_char_limit`, default
  20 000) — the most document text one `read_page` call may return; long
  papers are read in windows of this size.

Rounds and the ≤200-mutation ceiling are runaway guards, not workload caps.

### The tool loop

The router runs a loop (`agent_events`) over `ai_client.sse_events`, which
parses tool calls from all three protocols' SSE (tool defs +
`tool_calls`/`role:"tool"` message extensions are translated per wire in the
request builders; the Responses builders enable `parallel_tool_calls` when
tools ride along, so bulk renames batch per round): the model calls tools →
the server executes them → results go back → repeat until it answers.

Every tool call streams back as an
`{"action": {kind, summary, tool, args, result}}` NDJSON line (kinds
list/read/search/rename/move/edit/create, plus `error` with `error: true` for
failed/blocked calls) that the chat renders as a chip and saves in the message
— clicking a chip expands the arguments and the (truncated, `_DETAIL_CAP`)
output the model got; only applied mutations count against
`MAX_TOOL_ACTIONS` and trigger the home-feed refresh (`onLibraryChange`), and
the note-block tools' actions carry `page_id`/`src_page_id` so the frontend
reloads the open page's block tree when the AI touched it (`onNotesChange`;
with the page's live socket up the tools' ops already arrived through it and
the reload is skipped — [collab.md](collab.md)).

### Watching the agent work (live footprint)

The chat forwards every stream event to the app as it arrives
(`onAgentEvent` in `chatDock.jsx` → `handleAgentEvent` in `App.jsx`), so the
notes panel shows where the agent is, not just what it did.

- Actions of `read_block`/`edit_block`/`create_block`/`move_block` carry the
  `block_id` they touched. On the open page a read block pulses an accent
  ring for a moment. An edited/created/moved block gets an accent tint that
  fades over a few seconds and is scrolled into view. A whole-page read
  (`read_page`, or `read_block` on the page id) sweeps the outline: every
  row rings once, staggered top to bottom (`aiScan` → inline
  `animation-delay` per row), and the list's left edge pulses. An applied
  edit reloads the tree immediately (same guards as `onNotesChange`, plus
  never while the user has a block editor open), so the change is visible
  while the agent carries on.
- `{"progress": {tool, id, block_id (+ mode) | parent_id (+ after_id), content}}`
  lines preview an `edit_block`/`create_block` call the model is still
  writing. `ai_client.sse_events` yields `tool_delta` events with the raw
  argument JSON so far, on all three wires (Anthropic `input_json_delta`,
  chat-completions `tool_calls[].function.arguments`, Responses
  `response.function_call_arguments.delta`). The loop reads the target id
  and the `content` string out of the partial JSON
  (`ai_client.partial_json_object`: complete string values plus the one
  being written, decoded as far as it goes). The block types the new
  markdown in behind a caret in place of its stored text; an `append` /
  `prepend` edit keeps the stored text and types the addition at its end /
  start. For a create, a ghost row appears under the named parent after the
  named sibling. When the action lands, the reload swaps in the real block.
  Only armed edit/create tools are previewed; other tools' arguments are
  never streamed. Non-stream callers never see progress lines.

Everything is display-only: marks and previews live in App state
(`aiMarks`, `aiLive`, `aiScan` → `rowProps` → `BlockRow`/`BlockTree`),
clear on page switch and when the reply ends, and never enter the block
tree, the undo history or the op queue.

### Replay across turns

On agent requests, `build_messages(..., with_tools=True)` (`ai_context.py`)
replays each saved reply's recorded actions as assistant `tool_calls` +
`role:"tool"` turns, so the model keeps prior tool results across turns
instead of re-listing. Every replayed result is prefixed with a note
(`_REPLAYED_NOTE`): it is from an earlier turn, the notes may have changed,
call again before quoting or editing. The base prompt says the same, so a
request to read, show or check something is answered from a fresh call, not
last turn's outline (the agent's own edits change what `read_block`
returns). Results share `TOOL_REPLAY_BUDGET` chars newest-first
(older ones elided), and `_anthropic_messages` folds a plain user turn into a
preceding tool_result turn to keep roles alternating. Plain chats never replay
(providers reject tool blocks without tool defs). Renamed tools replay under
their current name (`ai_context.DEPRECATED_TOOLS`, e.g. the saved
`search_pdfs` chips of old chats become `search_library` calls), and a model
that copies the old name out of that history is still served: the agent loop
and `run_agent_tool` canonicalize the name before the permission check and
dispatch, and the resulting action chip carries the current name. Old names
are never offered as tools.

OpenAI-protocol calls that carry tools are rerouted to the platform
`/v1/responses` (`wire_protocol`) — gpt-5.x rejects function tools on chat
completions — but only against the official api.openai.com base URL; custom
gateways keep chat-completions tools.


## PDF translation

`POST /api/ai/translate` backs the viewer's translated view. ONE 文A button
in the PDF zoom column does everything by state: click translates the
current page when nothing is translated yet, toggles show/hide for ALL pages
once translations exist under the current language+model (switching either
in Settings makes the button translate afresh; hidden = slashed icon;
holding Alt peeks), and
halts a running job; right-click (long-press on touch) opens the option
menu — Translate this page / Translate whole document / Show
original·translation (Stop translating while running). A whole-document job
queues pages nearest the current page first (forward before backward at
equal distance), so the page being read paints immediately. The queue lives
in `pdfViewer.jsx` (`translateCtl`), producer/consumer style: the producer
segments queued pages in order and feeds one flat list of ~6-paragraph /
1200-char chunks, while N workers (Settings → Reading → parallel requests,
typed, 1–32) stream through it across page boundaries — the first request is
in flight while later pages are still segmenting, chunks paint as they land,
char-weighted progress shows under the button and as a background-tasks row.
Halting aborts the in-flight requests (each job carries an AbortController)
and keeps finished chunks; re-running skips done pages and re-fills partial
ones from the server cache. Reliability: each chunk gets one client-side
retry, and the server salvages a miscounted model reply ("expected 5, got
4") by re-translating that batch paragraph by paragraph, concurrently — a
paragraph that still fails comes back verbatim (shown as original, uncached)
instead of failing the request.

The viewer requests `stream: true`. The reply is then NDJSON: `{"i":
[request indices], "text": partial}` lines as the model writes each
paragraph, then the same final `{translations, model, cached}` object a
plain call returns. `ai_client.partial_json_strings` reads the complete
elements of the half-written JSON array plus the one in progress. Lines are
throttled to ~20/s (`_TRANSLATE_STREAM_INTERVAL`), and an element maps to
every request index that shares its source text. `stream: false` (the
default) still answers in one JSON body. The salvage path never streams. An
upstream failure mid-stream is an in-band `{"error"}` line.

On the page, a paragraph whose translation is queued gets a faint accent
wash over its original lines, an in-flight one shimmers, streamed text
types onto the page behind a caret (masking the original as soon as there
is something to show), and a landed paragraph fades in. That is
`TransPending`/`TransPara` in `pdfViewer.jsx`, driven by the entry's
`queued`/`busy`/`partial` fields, which the job clears when it ends, halts
or fails.

Geometry never leaves the client: `frontend/src/pdfTranslate.js` segments
pdf.js text runs into paragraph blocks (columns via whitespace-river
detection, paragraphs via indents/font changes, figure-wrap via sustained
width changes; math-heavy/numeric blocks are skipped), each carrying
PER-LINE rects. The overlay masks exactly those original lines (plus the
leading between them) and lays the translation over them with an inline
cloned background — so figures a paragraph brushes against are never painted
over, and the layout never moves. Translated text is selectable/copyable;
while shown, the invisible original text layer stands down.

Targets are the allowlisted `TRANSLATE_LANGS` codes (mirrored in
`frontend/src/prefs.js`); model and reasoning `effort` come from Settings →
Reading (model follows the chat model by default; effort omitted unless
picked — Low/Minimal is the speed lever for reasoning models); the whole
Translation section can be switched off there too. The server keeps an
**in-memory only** LRU (~5k entries, lock-guarded — requests run in the
threadpool) per (user, language, bare model name, source text) —
deliberately nothing on disk; it makes halts/retries/re-shows free until a
restart. Duplicate paragraphs within a request go upstream once. Caps: 200
texts / 60k chars per request.

## Chat history buckets

Focused page id in the paper view, `home` at the library root,
`home:<folder path>` per folder — each folder keeps its own conversation, and
switching folders re-scopes the next message. The
`/api/chats/{block_id:path}` routes take the `:path` converter for the nested
keys, and folder rename/move/delete calls `POST /api/chats/folder-rename`
({src, dst}; dst "" deletes) BEFORE rewriting the tags so the destination
bucket exists when ChatDock reloads (a destination holding a real conversation
wins; empty save-echo rows are overwritten) — folder conversations follow
renames and moves, and are deleted with their folder.

### Chat history

Each bucket keeps its earlier conversations. `chats` (data.db) holds the
one ACTIVE conversation per bucket — what the panel shows and autosaves —
plus a `title` column (added lazily by `connect_data_db`); `chat_history`
holds the archived ones (`id, bucket, title, messages, created_at,
updated_at`). Routes: `gamma/routers/chats.py`, prefix `/api/chat-history`.

- **New chat** (+ in the header) archives the conversation: it POSTs
  `/chat-history/archive` `{bucket, messages, title}`, which files it into
  history and clears the active row. The title is the user's, else the first
  user message's first non-quote line (`derive_title`). The client sends its
  own copy of the messages, so a reply still inside the 500 ms autosave
  debounce is kept. An empty conversation archives to nothing.
- The **History** button (clock icon) opens a popover listing the active
  conversation first (highlighted, "now") and then the bucket's archived
  ones newest-first (`GET /chat-history?bucket=`; title, age, message count
  in the tooltip), with a search box filtering on title + first message.
  Clicking an entry POSTs `/chat-history/{id}/open` with the current
  conversation: the current one is archived, the entry becomes the active
  row and leaves history. A conversation is always in exactly one place.
  - Rename: inline `aiKeyInput`. The active chat's title goes through
    `PUT /chats/{key}` `{messages, title}`, an entry's through
    `PUT /chat-history/{id}`. The autosave never sends a title, so it can't
    roll a rename back.
  - Delete: confirm dialog, then `DELETE /chat-history/{id}`. The active
    conversation has no delete; start a new chat instead.
- History follows its bucket: `POST /chats/folder-rename` rewrites entry
  buckets along with the active rows, and `purge_page_data` drops a deleted
  page's entries. The gamma export/import and the account-merge path copy
  only the active `chats` rows, not history.
