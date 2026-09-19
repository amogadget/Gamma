// The AI chat window, self-contained: per-page conversation state (loaded/
// saved on the backend), ChatGPT-style message actions (copy/edit/find/stop),
// pasted figures, the "+" context picker, and the per-message PDF attach.
// App provides context (open paper, library, selections) and the model/effort/
// prompt preferences it also needs elsewhere.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { API, apiJson, copyText, isPdfFile, readNdjson } from "../shared/lib/utils";
import { DockWindow, ChatMarkdown, AutoGrowTextarea, useCopied, useTextScale } from "../shared/ui/Widgets";
import PaperMentionInput from "./PaperMentionInput";
import { MAX_CHAT_REFERENCES } from "./paperMentions";
import { addUsage, cachedPercent, conversationUsage, fmtTokens, liveUsage, usageDetail } from "./tokenUsage";
import { createTitleScorer } from "../library/librarySearch";
import { pageAttachment } from "../library/libraryUtils";
import { MenuSelect } from "../shared/ui/Menus";
import { CharSlider, approxPages } from "../settings/SettingsKit";
import { AgentToolPicker, CHAT_KIND_ROWS } from "../settings/SettingsDialog";
import { AlertCircleIcon, ArrowDownIcon, ArrowUpIcon, BookIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CloudDownloadIcon, CopyIcon, FileIcon, FolderIcon, GlobeIcon, HistoryIcon, InfoIcon, ListIcon, MicIcon, PaperclipIcon, PencilIcon, PlusIcon, SearchIcon, SettingsIcon, SlidersIcon, StopIcon, TrashIcon, XIcon } from "../shared/ui/Icons";

const JSON_HEADERS = { "Content-Type": "application/json" };

// A conversation's display name when the user never named it: the first
// user message's first non-quote line (mirrors derive_title in
// gamma/routers/chats.py, which names entries when they are archived).
function deriveTitle(messages) {
  const first = (messages || []).find((m) => m.role === "user");
  const line = (first?.text || "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith(">"));
  return (line || "").replace(/\s+/g, " ").slice(0, 80);
}

// Compact age for a history row: "now", "5m", "3h", "2d", "4mo", "1y".
function relAge(iso) {
  const ms = Date.now() - Date.parse(iso || "");
  if (!Number.isFinite(ms) || ms < 60000) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
}

// Folder-agent tool chips: icon per action kind; rename/move are the kinds
// that changed the library (they trigger the home-feed refresh). Every chip
// carries the raw call the server ran (tool/args/result, both truncated), so
// clicking one expands the arguments and the output the model saw.
const ACTION_ICONS = { rename: PencilIcon, move: FolderIcon, search: SearchIcon, read: BookIcon, list: ListIcon, edit: PencilIcon, create: PlusIcon, websearch: GlobeIcon, fetch: CloudDownloadIcon, error: XIcon };
// What the model was given for a reply, per document — streamed by
// /api/ai/chat as its first line and saved on the message. Shown only when
// it matters: the paper was truncated, or the PDF file was requested but the
// provider refused it (text went instead). A full native attachment or a
// paper that fit whole stays silent.
function ContextCoverage({ items }) {
  const notes = items.map((c) => {
    const refused = c.native_requested && !c.native;
    if (!refused && !c.partial) return null;
    const span = c.pages_shown && c.pages
      ? `pages 1–${Math.min(c.pages_shown, c.pages)} of ${c.pages}`
      : c.selection ? "selected passages + head" : `${(c.chars || 0).toLocaleString()} characters`;
    const what = c.title ? `“${c.title.slice(0, 48)}${c.title.length > 48 ? "…" : ""}”` : "the PDF";
    const short = refused && !c.partial
      ? `PDF file not accepted — sent as text`
      : refused
        ? `PDF file not accepted — text only, ${span}`
        : `Model saw ${span}`;
    const long = (refused ? "This provider does not accept PDF files, so the document went as extracted text. " : "")
      + (c.partial
        ? `Only ${span} of ${what} fit the context budget — the rest was not visible to the model. Raise the budget in Settings / AI / Advanced AI settings / Context size, or turn on Tools so it can read and search the whole paper.`
        : `${what} was sent as extracted text.`);
    return { short, long, refused };
  }).filter(Boolean);
  if (!notes.length) return null;
  return (
    <div className="chatMsgPdfs">
      {notes.map((n, i) => (
        <span key={i} className="chatPdfChip" title={n.long}>
          {n.refused ? <AlertCircleIcon size={11} /> : <InfoIcon size={11} />}
          {n.short}
        </span>
      ))}
    </div>
  );
}

// The token line under a reply, Claude Code style: prompt in, reply out,
// and the share of the prompt the provider served from its cache. Every
// count comes from the provider's own report ({"usage"} lines of the chat
// stream, summed over an agent reply's rounds); a reply without one shows
// nothing. While the reply streams the same line ticks up next to the
// "Responding" pill: exact counts for the rounds already reported, a "~"
// estimate from the characters received for the one still arriving.
function UsageLine({ usage, className = "chatMsgUsage" }) {
  if (!usage || !(usage.input || usage.output)) return null;
  const cached = cachedPercent(usage);
  const live = !!usage.estimate;
  return (
    <span className={className} title={live ? "Counting while the reply streams — the provider's own count replaces the estimate when it finishes" : usageDetail(usage)}>
      {usage.input ? <span className="chatMsgUsagePart"><ArrowUpIcon size={9} />{fmtTokens(usage.input)}</span> : null}
      <span className="chatMsgUsagePart"><ArrowDownIcon size={9} />{live ? "~" : ""}{fmtTokens(usage.output)}</span>
      {cached && !live ? <span className="chatMsgUsagePart">{cached}% cached</span> : null}
    </span>
  );
}

const MUTATING_KINDS = new Set(["rename", "move", "edit", "create"]);
// The note-block mutators: their actions carry the page id(s) they touched,
// so the open page's block tree can reload and show the change.
const BLOCK_TOOLS = new Set(["edit_block", "create_block", "move_block"]);
const toolCallText = (a) => {
  const args = Object.entries(a.args || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
  const head = `${a.tool || a.kind}(${args})`;
  return [head, a.result].filter(Boolean).join("\n\n");
};

// One chip in the composer's strip: a PDF passage, the cursor block, an
// attached block or selected note text. `kind` is the modifier class that
// colours the label (isCursor / isBlock / isNote; none for a PDF passage).
function SelChip({ kind, label, labelTitle, text, title, onRemove, removeTitle }) {
  return (
    <div className={`chatSelChip${kind ? ` ${kind}` : ""}`} title={title ?? text}>
      <span className="chatSelChipLabel" title={labelTitle}>{label}</span>
      <span className="chatSelChipText">{text.slice(0, 140)}{text.length > 140 ? "…" : ""}</span>
      <button type="button" className="uiClose uiCloseSm chatSelChipClose" onClick={onRemove} title={removeTitle}>×</button>
    </div>
  );
}

export default function ChatDock({
  session,
  readOnly = false,
  docId, pageAttach, focusedBlockId, homeBlocks, pageTitle, openTabs,
  pdfSelections, setPdfSelections,
  // Note chips ([{kind: "block", id, text} | {kind: "note", text}], App
  // state like pdfSelections) and the block row the user's cursor is on —
  // both ride with the next message so "this block" means something.
  chatNotes, setChatNotes, focusedNote,
  chatImages, setChatImages,
  chatModel, setChatModel, chatEffort, setChatEffort, chatSystem,
  dictationModel, dictationLang,
  chatContextChars, setChatContextChars, multiContextChars,
  aiInfo, aiProvider, openAiKeysEditor,
  aiHealth, dismissAiHealth,
  openPopover, setOpenPopover,
  setStatus, askConfirm,
  // Home/folder view: the folder path being viewed ("" = library root) —
  // enables the folder-agent tools; null in the paper view. agentPerms is the
  // Settings per-chat-kind permission map ({folder, pdf, notes} → {list,
  // read, block_read, search, rename, move, block_edit}; setAgentPerms edits
  // it from the ⚙ popover) and toolRounds the round budget. When the AI applied changes, onLibraryChange
  // refreshes the home feed and onNotesChange reloads touched pages' notes.
  organizeFolder = null, toolRounds, agentReadChars, agentPerms, setAgentPerms, agentSystem,
  agentEnabled, setAgentEnabled, onLibraryChange, onNotesChange, onAgentEvent,
  // Opens a page the reply links to (/?page=<id>) in place.
  onOpenPage,
  onGrip, onGripDoubleClick, collapsed, onClose,
}) {
  const [loadedMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [loadError, setLoadError] = useState("");
  // Chat history is per page; the home view buckets per folder ("home" at the
  // library root, "home:<path>" inside a folder) — switching folders switches
  // conversations, so the organizer never drags one folder's context into
  // another. App migrates the buckets on folder rename/move/delete
  // (POST /api/chats/folder-rename).
  const chatKey = focusedBlockId || (organizeFolder ? `home:${organizeFolder}` : "home");
  const sessionState = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const chatMessages = sessionState.replies.get(chatKey)?.messages || loadedMessages;
  const chatLoadingKey = sessionState.activeKey;
  const chatLoading = !!chatLoadingKey;
  const folderChat = organizeFolder != null;
  // Which of the three chat kinds this is — each has its own tool permission
  // map in Settings → Assistant (prefs.js CHAT_KINDS): the folder chat, a
  // page with a PDF, a page of notes.
  const chatKind = folderChat ? "folder" : pageAttach ? "pdf" : "notes";
  const chatKindLabel = CHAT_KIND_ROWS.find((r) => r[0] === chatKind)?.[2] || "Chat";
  // The chat settings shortcut edits the same global preferences as Settings.
  const chatToolPerms = agentPerms?.[chatKind] || {};
  const toolsEnabled = !!agentEnabled;
  const perm = (key) => chatToolPerms?.[key] !== false;
  const toggleTools = () => setAgentEnabled(!agentEnabled);
  // What the agent may do here after applying the shared permissions.
  const agentReads = perm("list") || perm("read") || perm("block_read") || perm("search")
    || perm("web_search") || perm("web_read");
  const agentWrites = perm("rename") || perm("move") || perm("block_edit");
  // Agent fields riding on /api/ai/chat ({} = plain chat): folder chats reach
  // the folder's pages, page chats get the read + note-block tools for their
  // own page.
  const agentPayload = () => {
    if (!toolsEnabled) return {};
    const scope = organizeFolder != null && (agentReads || agentWrites)
      ? { agent_scope: "folder", folder: organizeFolder }
      : focusedBlockId && (perm("read") || perm("block_read") || perm("search")
                           || perm("web_search") || perm("web_read") || perm("block_edit"))
        ? { agent_scope: "page", page_id: focusedBlockId }
        : null;
    return scope
      ? { ...scope, tool_rounds: toolRounds || 0, read_char_limit: agentReadChars || 0,
          permissions: chatToolPerms, agent_system: agentSystem || "" }
      : {};
  };
  // The block the user's cursor is on shows as a "Cursor" chip (like a PDF
  // selection) and rides with the message as focus_block_id; its × leaves it
  // out for that block until the cursor moves.
  const [cursorOff, setCursorOff] = useState(null);
  useEffect(() => { setCursorOff(null); }, [focusedNote?.id]);
  const cursorChip = focusedNote && focusedNote.id !== cursorOff ? focusedNote : null;
  // Empty-state intro and input placeholder for an agent-enabled home chat.
  const agentScopeName = organizeFolder ? "this folder" : "your library";
  const agentIntro = organizeFolder == null || !toolsEnabled ? null
    : agentWrites
      ? `Ask AI anything — it can ${agentReads ? "read, search and " : ""}organize ${agentScopeName} (rename pages, file them into folders${perm("block_edit") ? ", edit notes" : ""})…`
      : agentReads
        ? `Ask AI across ${organizeFolder ? "this folder's pages" : "your library"} — it can read, search and summarize them…`
        : null;
  const agentAsk = agentIntro ? (agentWrites ? `Ask, or organize ${agentScopeName}…` : `Ask across ${agentScopeName}…`) : null;
  const chatKeyRef = useRef(chatKey);
  chatKeyRef.current = chatKey;
  // chatImages (pasted/area-selection figures pending send) lives in App —
  // like pdfSelections — so the PDF viewer can attach into it.
  const [editingMsg, setEditingMsg] = useState(null); // {idx, text} — editing a sent user message
  const [copiedMsgIdx, flashCopiedMsg] = useCopied(1200);
  const [openActions, setOpenActions] = useState(() => new Set()); // expanded tool chips, "<msg>:<action>"
  const toggleAction = (key) => setOpenActions((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const [chatFindOpen, setChatFindOpen] = useState(false);
  const [chatFind, setChatFind] = useState("");
  const [chatFindIdx, setChatFindIdx] = useState(0);
  // On by default for a conversation that hasn't seen this document yet;
  // derived from the loaded history below, so a refresh can't re-enable it
  // after the PDF was already sent (re-sending re-bills the whole file).
  const [attachPdf, setAttachPdf] = useState(false);
  // Whether the active model's provider takes the PDF file itself. The
  // ChatGPT sign-in wire (Codex backend) refuses file parts — the server
  // falls back to extracted text — so there the PDF button must not
  // default on, and turning it on by hand gets a warning, not silence.
  const activeModel = (aiInfo?.models || []).find((m) => m.id === chatModel) || null;
  const nativePdf = activeModel ? activeModel.native_pdf !== false : true;
  const nativePdfNote = nativePdf ? "" :
    `${activeModel?.provider_name || "This provider"} does not accept PDF files — the PDF is sent as extracted text instead (first ${(chatContextChars || 0).toLocaleString()} characters; Settings / AI / Advanced AI settings / Context size).`;
  const attachPdfManualRef = useRef(false); // the user toggled the PDF button themselves
  useEffect(() => {
    // A provider without native PDF input: drop the automatic "send the file
    // once" default. A deliberate manual switch-on stays (with its warning).
    if (!nativePdf && !attachPdfManualRef.current) setAttachPdf(false);
  }, [nativePdf]);
  // Extra chat context: selected PDF pages + whether to include notes/highlights.
  const [chatDocs, setChatDocs] = useState([]);
  const [chatIncludeNotes, setChatIncludeNotes] = useState(false);
  const [chatFiles, setChatFiles] = useState([]); // uploaded PDFs ({name, data}) pending send
  const [docPicker, setDocPicker] = useState(false); // "Add pages" modal
  const [docPickerQuery, setDocPickerQuery] = useState("");
  const fileInputRef = useRef(null);
  const chatScrollRef = useRef(null);
  // Ctrl+scroll over the transcript: session-only text size (useTextScale).
  const chatTextScale = useTextScale();
  const chatScrollRefCb = useCallback((el) => { chatScrollRef.current = el; chatTextScale.ref(el); }, [chatTextScale.ref]);
  // Voice dictation (ChatGPT-style): mic records (live waveform), ■ transcribes
  // into the input via /api/ai/transcribe, ↑ transcribes and sends, × discards.
  const [dictation, setDictation] = useState(""); // "" | "rec" | "busy"
  const [recSecs, setRecSecs] = useState(0);
  const recRef = useRef(null); // {recorder, stream, chunks, canceled, autoSend, baseText, analyser, audioCtx, amps}
  const waveCanvasRef = useRef(null);
  // Latest sendChat for the record-view ↑ button — the recorder's onstop fires
  // from the render that started it, and a page switch mid-recording would
  // otherwise send through a stale conversation closure.
  const sendChatRef = useRef(null);

  // The active conversation's user-given name ("" = derived from its first
  // message). Renames go to the server directly; the autosave never sends
  // it, so a debounced save can't roll a rename back.
  const [chatTitle, setChatTitle] = useState("");

  // Show a conversation that came from the server (bucket switch, or a
  // history entry opened). PDF button: on until this document has been sent
  // in THIS conversation, then off. Messages record the doc ids they carried
  // (pdfDocs); older saves only have display names — treat any sent PDF as
  // covering the current one.
  function showLoaded(msgs, title) {
    setChatMessages(msgs);
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const references = [...new Set((lastUser?.contextPages || []).map((p) => p.id))].slice(0, MAX_CHAT_REFERENCES);
    setChatDocs(references);
    setChatIncludeNotes(!!lastUser?.includeNotes);
    setChatInput("");
    setChatTitle(title || "");
    const sent = msgs.some((m) => m.pdfDocs
      ? (docId && m.pdfDocs.includes(docId)) || m.pdfDocs.includes(focusedBlockId)
        || (!docId && references.some((id) => m.pdfDocs.includes(id)
          || m.pdfDocs.includes(pageAttachment(homeBlocks.find((b) => b.id === id))?.id)))
      : m.pdfs?.length);
    attachPdfManualRef.current = false;
    setAttachPdf(!sent && nativePdf);
  }

  // Load chat from backend whenever the chat bucket changes.
  useEffect(() => {
    let cancelled = false;
    setChatDocs([]);
    setChatIncludeNotes(false);
    setChatInput("");
    setDocPicker(false);
    const reply = session.getSnapshot().replies.get(chatKey);
    const reloadSaved = session.isSaved(chatKey);
    showLoaded(reply?.messages || [], reply?.title);
    setLoadError("");
    apiJson(`${API}/chats/${encodeURIComponent(chatKey)}`)
      .then(data => {
        if (cancelled) return;
        const latest = session.getSnapshot().replies.get(chatKey);
        // Once a reply was saved before this GET, the server is authoritative
        // again (another tab or a folder rename may have changed the bucket).
        if (reloadSaved && latest === reply && session.isSaved(chatKey)) {
          showLoaded(data.messages || [], data.title);
          session.forget(chatKey);
        } else {
          showLoaded(latest?.messages || data.messages || [], data.title);
        }
      })
      .catch((err) => { if (!cancelled && !session.getSnapshot().replies.has(chatKey)) setLoadError(`Could not load chat: ${err.message}`); });
    return () => { cancelled = true; };
  }, [chatKey, docId, readOnly, session]);

  // History: the bucket's earlier conversations (server `chat_history`).
  // "New chat" archives the current one there instead of deleting it, and
  // opening an entry swaps it with the current one. Both send the client's
  // copy of the conversation, so a reply still sitting in the autosave
  // debounce is kept. The list loads lazily when the popover opens and is
  // dropped on any change (bucket switch, archive, open) so it re-fetches.
  const [history, setHistory] = useState(null); // null = not loaded yet
  const [historyQuery, setHistoryQuery] = useState("");
  const [renaming, setRenaming] = useState(null); // {id: "" = the active chat | entry id, text}
  const renameCancelRef = useRef(false);
  const historyOpen = openPopover === "chathistory";
  useEffect(() => { setHistory(null); setHistoryQuery(""); setRenaming(null); }, [chatKey]);
  useEffect(() => {
    if (readOnly || !historyOpen || history != null) return;
    let cancelled = false;
    apiJson(`${API}/chat-history?bucket=${encodeURIComponent(chatKey)}`)
      .then((data) => { if (!cancelled) setHistory(data.sessions || []); })
      .catch((err) => { if (!cancelled) { setHistory([]); setStatus(`Chat history: ${err.message}`); } });
    return () => { cancelled = true; };
  }, [historyOpen, history, chatKey, readOnly]);
  const activeTitle = chatTitle || deriveTitle(chatMessages) || "Untitled";
  const busyHere = chatLoading && chatLoadingKey === chatKey; // a reply is streaming into this conversation
  // Reserve the reply's bubble before the first stream event. This placeholder
  // is display-only; tool activity and answer text replace it in the same row.
  const visibleMessages = busyHere && (!chatMessages.length || chatMessages.at(-1).role === "user")
    ? [...chatMessages, { role: "ai", text: "", partial: true }]
    : chatMessages;
  const currentPayload = () => ({ bucket: chatKey, messages: chatMessages, title: chatTitle });

  async function newChat() {
    if (busyHere) return;
    const payload = currentPayload();
    try {
      await session.flush(chatKey);
      await apiJson(`${API}/chat-history/archive`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) });
    } catch (err) {
      setStatus(`Couldn't keep the conversation in history: ${err.message}`);
      return;
    }
    session.forget(chatKey);
    if (chatKeyRef.current !== chatKey) return;
    setChatMessages([]);
    setChatDocs([]);
    setChatInput("");
    setChatIncludeNotes(false);
    setChatTitle("");
    attachPdfManualRef.current = false;
    setAttachPdf(nativePdf); // new chat: first question carries the full PDF again (where the provider takes it)
    setHistory(null);
  }

  async function openHistory(id) {
    if (busyHere) return;
    try {
      await session.flush(chatKey);
      const data = await apiJson(`${API}/chat-history/${id}/open`,
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(currentPayload()) });
      session.forget(chatKey);
      if (chatKeyRef.current !== chatKey) return;
      showLoaded(data.messages || [], data.title);
      setHistory(null);
      setOpenPopover(null);
      chatStickRef.current = true;
    } catch (err) {
      setStatus(`Couldn't open the conversation: ${err.message}`);
    }
  }

  // Rename commits on blur (Enter just blurs; Escape flags a cancel first),
  // so there is exactly one commit path for the input's disappearance.
  async function commitRename() {
    const edit = renaming;
    setRenaming(null);
    if (!edit || renameCancelRef.current) { renameCancelRef.current = false; return; }
    const title = edit.text.trim();
    try {
      if (edit.id === "") {
        setChatTitle(title);
        await session.flush(chatKey);
        await apiJson(`${API}/chats/${encodeURIComponent(chatKey)}`,
          { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ messages: chatMessages, title }) });
      } else {
        setHistory((prev) => (prev || []).map((s) => (s.id === edit.id ? { ...s, title } : s)));
        await apiJson(`${API}/chat-history/${edit.id}`,
          { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ title }) });
      }
    } catch (err) {
      setStatus(`Couldn't rename the conversation: ${err.message}`);
    }
  }

  function deleteHistory(entry) {
    const run = async () => {
      setHistory((prev) => (prev || []).filter((s) => s.id !== entry.id));
      try {
        await apiJson(`${API}/chat-history/${entry.id}`, { method: "DELETE" });
      } catch (err) {
        setStatus(`Couldn't delete the conversation: ${err.message}`);
        setHistory(null);
      }
    };
    askConfirm({
      title: "Delete conversation",
      message: `Delete “${entry.title || "Untitled"}” from this chat's history? This can't be undone.`,
      confirmLabel: "Delete", danger: true, onConfirm: run,
    });
  }

  // Rows of the history popover: the active conversation first, then the
  // archived ones newest-first, filtered by the search box.
  const historyRows = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    const active = { id: "", title: activeTitle, preview: deriveTitle(chatMessages), updated_at: "", active: true };
    const rows = [active, ...(history || [])];
    return q ? rows.filter((s) => `${s.title} ${s.preview || ""}`.toLowerCase().includes(q)) : rows;
  }, [history, historyQuery, activeTitle, chatMessages]);

  // Attach picked/pasted files: images join the pasted-figures row, PDFs
  // become one-shot native attachments (same as the library PDF button).
  function addChatFiles(files) {
    for (const f of files) {
      if (isPdfFile(f)) {
        if (f.size > 15 * 1024 * 1024) { setStatus(`"${f.name}" is too large to attach (max 15 MB).`); continue; }
        const reader = new FileReader();
        reader.onload = () => setChatFiles((prev) => prev.length >= 4 ? prev : [...prev, { name: f.name || "file.pdf", data: reader.result }]);
        reader.readAsDataURL(f);
      } else if (f.type?.startsWith("image/")) {
        if (f.size > 6 * 1024 * 1024) { setStatus("Image too large to attach (max 6 MB)."); continue; }
        const reader = new FileReader();
        reader.onload = () => setChatImages((prev) => prev.length >= 4 ? prev : [...prev, reader.result]);
        reader.readAsDataURL(f);
      } else {
        setStatus(`Can't attach "${f.name}" — only images and PDFs are supported.`);
      }
    }
  }

  // Paste a figure (screenshot/image) into the chat input → attach it.
  function handleChatPaste(e) {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.type?.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    addChatFiles(files);
  }

  const chatFindMatches = useMemo(() => {
    const q = chatFind.trim().toLowerCase();
    if (!q) return [];
    return chatMessages.map((m, i) => ((m.text || "").toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0);
  }, [chatFind, chatMessages]);
  useEffect(() => { setChatFindIdx(0); }, [chatFind]);

  function gotoChatFind(n) {
    if (!chatFindMatches.length) return;
    const idx = ((n % chatFindMatches.length) + chatFindMatches.length) % chatFindMatches.length;
    setChatFindIdx(idx);
    const el = chatScrollRef.current?.querySelector(`[data-msg-idx="${chatFindMatches[idx]}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Ctrl+F while focus is inside the chat opens find-in-chat (App's global
  // handler defers to us in that case).
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f"
          && document.activeElement?.closest?.(".chatPanel")) {
        e.preventDefault();
        setChatFindOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Escape closes the page-picker modal wherever focus is.
  useEffect(() => {
    if (!docPicker) return;
    function onKey(e) { if (e.key === "Escape") setDocPicker(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docPicker]);

  // Follow the newest message only while stuck to the bottom (ChatGPT-style):
  // ANY upward scroll — wheel, scrollbar drag, touch — unsticks immediately,
  // even a small one; scrolling back down to the bottom re-sticks. Our own
  // scroll-to-bottom writes are flagged so their scroll events can't re-stick.
  const chatStickRef = useRef(true);
  const chatProgScrollRef = useRef(false);
  const chatLastScrollTopRef = useRef(0);
  useEffect(() => { chatStickRef.current = true; }, [chatKey]);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el || !chatStickRef.current) return;
    const target = el.scrollHeight - el.clientHeight;
    if (el.scrollTop < target - 1) {
      chatProgScrollRef.current = true;
      el.scrollTop = target;
    }
  }, [chatMessages, chatLoading]);

  // Core chat send. baseMessages overrides the history (used when re-sending
  // an edited message: everything after the edited message is discarded,
  // ChatGPT-style).
  async function sendChat(rawText, { baseMessages, referenceMessage } = {}) {
    if (readOnly) return;
    const text = (rawText || "").trim();
    if (!text || chatLoading) return;
    const selectedDocs = referenceMessage ? (referenceMessage.contextPages || []).map((p) => p.id) : chatDocs;
    const includeNotes = referenceMessage ? !!referenceMessage.includeNotes : chatIncludeNotes;
    if (referenceMessage) { setChatDocs(selectedDocs); setChatIncludeNotes(includeNotes); }
    const selection = pdfSelections.join("\n\n---\n\n");
    setPdfSelections([]);
    // Note chips: attached blocks go as ids (the server serves their current
    // text, id-labelled, so the agent can edit them); selected note text as
    // verbatim passages.
    const notes = chatNotes || [];
    setChatNotes?.([]);
    const contextBlocks = notes.filter((n) => n.kind === "block").map((n) => n.id);
    const notePassages = notes.filter((n) => n.kind === "note").map((n) => n.text);
    const images = chatImages;
    setChatImages([]);
    const files = chatFiles;
    setChatFiles([]);
    const prevMessages = baseMessages ?? chatMessages;
    const quoted = [selection, ...notes.map((n) => n.text)].filter(Boolean).join("\n\n---\n\n");
    const shown = quoted ? `${text}\n\n> ${quoted.slice(0, 280)}${quoted.length > 280 ? "…" : ""}` : text;
    // Names of PDFs that ride along with THIS message (displayed in the bubble)
    const contextIds = [...new Set([focusedBlockId, ...selectedDocs].filter(Boolean))];
    const pdfPages = contextIds.flatMap((id) => {
      const page = homeBlocks.find((b) => b.id === id);
      const attachment = id === focusedBlockId ? pageAttach : pageAttachment(page);
      return attachment ? [{ id: attachment.id, title: page?.content || (id === focusedBlockId ? pageTitle : "") || "Untitled" }] : [];
    });
    const sendingPdf = attachPdf && pdfPages.length > 0;
    const pdfNames = [
      ...files.map((f) => f.name),
      ...(sendingPdf ? pdfPages.map((p) => p.title) : []),
    ];
    const contextPages = selectedDocs.map((id) => ({ id, title: homeBlocks.find((b) => b.id === id)?.content || "Untitled" }));
    const userMsg = {
      contextPages,
      includeNotes,
      role: "user",
      text: shown,
      ...(images.length ? { images } : {}),
      // pdfDocs records WHICH documents rode along, so reloading the page
      // can tell whether this document was already sent in the conversation
      // (uploaded files aren't library docs — they contribute names only).
      ...(pdfNames.length ? { pdfs: pdfNames, pdfDocs: sendingPdf ? pdfPages.map((p) => p.id) : [] } : {}),
    };
    const sendKey = chatKey; // reply belongs to THIS conversation, even if the user navigates away
    const showReply = (aiMsg, final) => {
      const saved = session.update(sendKey, [...prevMessages, userMsg, aiMsg], final);
      saved?.catch((err) => setStatus(`Couldn't save the conversation: ${err.message}`));
    };
    chatStickRef.current = true; // sending always snaps back to the bottom
    const ctrl = new AbortController();
    if (!session.start(sendKey, [...prevMessages, userMsg], chatTitle, ctrl)) return;
    // One-shot semantics: the PDF went with this message; don't silently
    // re-upload (and re-bill) it on every follow-up.
    if (sendingPdf) setAttachPdf(false);
    let acc = ""; // streamed reply so far — kept on Stop
    const actions = []; // organizer mutations streamed for this reply
    let coverage = null; // {"context": [...]} — what the model was given, per document
    let usage = null; // the provider's token report, summed over the reply's rounds
    let liveChars = 0; // characters received since the last report — the running estimate
    const liveArgs = new Map(); // tool call id -> argument chars previewed so far (cumulative)
    const aiMsg = (extra = {}) => ({
      role: "ai", text: acc,
      ...(actions.length ? { actions: [...actions] } : {}),
      ...(coverage ? { context: coverage } : {}),
      ...(usage ? { usage } : {}),
      ...extra,
    });
    try {
      const res = await fetch(`${API}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: ctrl.signal,
        body: JSON.stringify({
          prompt: text,
          page_id: focusedBlockId || "",
          history: prevMessages.filter((m) => !m.error), // failed replies aren't answers
          model: chatModel || "",
          selection,
          focus_block_id: cursorChip ? cursorChip.id : "",
          context_blocks: contextBlocks,
          note_passages: notePassages,
          attach_pdf: sendingPdf,
          effort: chatEffort || "",
          system: chatSystem || "",
          pages: selectedDocs.length ? contextIds : [],
          include_notes: includeNotes,
          images,
          files,
          context_char_limit: chatContextChars,
          multi_context_char_limit: multiContextChars,
          stream: true,
          ...agentPayload(),
        }),
      });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try { detail = (await res.json()).detail || detail; } catch {}
        throw new Error(detail);
      }
      // NDJSON stream: {"delta": "…"} per chunk, {"error": "…"} on failure.
      await readNdjson(res, (events) => {
        for (const ev of events) {
          if (ev.error) throw new Error(ev.error);
          if (ev.action) {
            actions.push(ev.action);
            // Live: the notes panel lights up the block the agent just
            // read/edited (and reloads the tree for an applied edit).
            onAgentEvent?.({ type: "action", action: ev.action });
          } else if (ev.progress) {
            // The agent is still writing a note edit — the block types it in.
            onAgentEvent?.({ type: "progress", ...ev.progress });
            const seen = liveArgs.get(ev.progress.id) || 0;
            const now = (ev.progress.content || "").length;
            if (now > seen) { liveChars += now - seen; liveArgs.set(ev.progress.id, now); }
          } else if (ev.context) {
            coverage = ev.context;
          } else if (ev.usage) {
            // The round is counted for real now; the estimate starts over.
            usage = addUsage(usage, ev.usage);
            liveChars = 0;
            liveArgs.clear();
          } else {
            acc += ev.delta || "";
            liveChars += (ev.delta || "").length;
          }
        }
        if (acc || actions.length || usage) showReply(aiMsg({ partial: true, live: liveChars }));
      });
      showReply(aiMsg({ text: acc || (actions.length ? "" : "(no response)") }), true);
    } catch (err) {
      const stopped = err?.name === "AbortError";
      // A reply that never started is an error bubble (`error: true`): shown
      // and saved so the failure is visible after a reload, but rendered
      // apart from answers and never replayed to the model as one. A reply
      // cut off mid-stream keeps its text and just notes the failure.
      showReply(aiMsg({
        text: stopped
          ? (acc ? `${acc}\n\n*(stopped)*` : "*(stopped)*")
          : (acc ? `${acc}\n\n**Error:** ${err.message}` : `Error: ${err.message}`),
        ...(!stopped && !acc ? { error: true } : {}),
      }), true);
    } finally {
      session.finish();
      onAgentEvent?.({ type: "done" });
      // Agent tools changed the library — reload the home feed. Read-only
      // tool calls (list/read/search) render as chips but change nothing.
      if (actions.some((a) => MUTATING_KINDS.has(a.kind))) onLibraryChange?.();
      // Note-block edits carry the page(s) they touched, so the open page's
      // block tree can reload and show the change.
      const notePages = [...new Set(actions
        .filter((a) => !a.error && BLOCK_TOOLS.has(a.tool))
        .flatMap((a) => [a.page_id, a.src_page_id].filter(Boolean)))];
      if (notePages.length) onNotesChange?.(notePages);
    }
  }

  sendChatRef.current = sendChat;

  function sendChatMessage() {
    const text = chatInput;
    if (!text.trim() || chatLoading) return;
    setChatInput("");
    sendChat(text);
  }

  function stopChat() {
    session.stop();
  }

  async function startDictation() {
    if (dictation) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setStatus("Voice input needs HTTPS or localhost — the browser blocks the microphone on plain HTTP.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("Microphone access was denied.");
      return;
    }
    // Chrome/Firefox record webm/opus; Safari only mp4 (m4a to OpenAI).
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const rec = {
      recorder: new MediaRecorder(stream, mime ? { mimeType: mime } : undefined),
      stream, chunks: [], canceled: false, autoSend: false,
      baseText: chatInput, // composer text at record start (the input is hidden while recording)
      amps: [], peak: 0,
    };
    // Analyser feeds the live waveform; recording works fine without it.
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      rec.audioCtx = audioCtx;
      rec.analyser = analyser;
    } catch {}
    recRef.current = rec;
    rec.recorder.ondataavailable = (e) => { if (e.data?.size) rec.chunks.push(e.data); };
    rec.recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      rec.audioCtx?.close().catch(() => {});
      if (rec.canceled) return;
      transcribeDictation(new Blob(rec.chunks, { type: rec.recorder.mimeType || mime || "audio/webm" }), rec);
    };
    rec.recorder.start();
    setRecSecs(0);
    setDictation("rec");
  }

  // mode: "cancel" discards, "insert" transcribes into the input (■),
  // "send" transcribes and sends immediately (↑) — ChatGPT's dictation pair.
  function finishDictation(mode) {
    const rec = recRef.current;
    if (!rec || dictation !== "rec") return;
    rec.canceled = mode === "cancel";
    rec.autoSend = mode === "send";
    setDictation(rec.canceled ? "" : "busy");
    try { rec.recorder.stop(); } catch { setDictation(""); }
    if (rec.canceled) recRef.current = null;
  }

  async function transcribeDictation(blob, rec) {
    try {
      if (blob.size > 24 * 1024 * 1024) throw new Error("recording too long (max ~25 MB)");
      const form = new FormData();
      form.append("file", blob, blob.type.includes("mp4") ? "dictation.m4a" : "dictation.webm");
      if (dictationModel) form.append("model", dictationModel);
      if (dictationLang) form.append("language", dictationLang);
      if (chatModel) form.append("model_hint", chatModel);
      const data = await apiJson(`${API}/ai/transcribe`, { method: "POST", body: form });
      const text = (data.text || "").trim();
      if (text && rec.autoSend) {
        setChatInput("");
        sendChatRef.current?.([rec.baseText.trim(), text].filter(Boolean).join(" "));
      } else if (text) {
        setChatInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${text}` : text));
      }
    } catch (e) {
      setStatus(`Voice input: ${e.message}`);
    } finally {
      setDictation("");
      recRef.current = null;
    }
  }

  // Live waveform, drawn ChatGPT-style: newest audio as bars at the right
  // edge next to a cursor line, history scrolling left, silence as dots.
  useEffect(() => {
    if (dictation !== "rec") return;
    const canvas = waveCanvasRef.current;
    const rec = recRef.current;
    if (!canvas || !rec?.analyser) return;
    const ctx = canvas.getContext("2d");
    const data = new Uint8Array(rec.analyser.fftSize);
    const barColor = getComputedStyle(canvas).color; // fixed for the recording
    let raf, lastPush = 0;
    const draw = (now) => {
      raf = requestAnimationFrame(draw);
      rec.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      rec.peak = Math.max(rec.peak, Math.sqrt(sum / data.length));
      if (now - lastPush >= 50) { // one slot ≈ 50 ms of audio
        rec.amps.push(rec.peak);
        rec.peak = 0;
        lastPush = now;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = barColor;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      const cursorX = w - 3;
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(cursorX, h * 0.12); ctx.lineTo(cursorX, h * 0.88); ctx.stroke();
      const pitch = 5;
      for (let i = 0; i < Math.floor((cursorX - 4) / pitch); i++) {
        const amp = rec.amps[rec.amps.length - 1 - i];
        if (amp === undefined) break;
        const x = cursorX - (i + 1) * pitch;
        // sqrt lifts normal speech into view; the floor keeps a dotted
        // baseline running through silence.
        const len = Math.max(2, Math.min(1, Math.sqrt(amp) * 2.2) * h * 0.78);
        ctx.globalAlpha = len <= 2.5 ? 0.3 : 0.7;
        ctx.beginPath();
        ctx.moveTo(x, (h - len) / 2);
        ctx.lineTo(x, (h + len) / 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [dictation]);

  // Recording timer + drop the mic on unmount (stops the tracks so the
  // browser's recording indicator doesn't linger).
  useEffect(() => {
    if (dictation !== "rec") return;
    const timer = setInterval(() => setRecSecs((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [dictation]);
  useEffect(() => () => {
    const rec = recRef.current;
    if (rec) {
      rec.canceled = true;
      try { rec.recorder.stop(); } catch {}
      rec.stream.getTracks().forEach((t) => t.stop());
      rec.audioCtx?.close().catch(() => {});
    }
  }, []);

  async function copyChatMessage(idx, text) {
    if (await copyText(text || "")) flashCopiedMsg(idx);
  }

  // Header: one icon strip (the PDF zoom column's buttons, laid flat) —
  // ⚙ chat settings (model, reasoning effort, context size — the same prefs
  // Settings / AI edits, in a popover), Tools, Find, New chat.
  const settingsOpen = openPopover === "chatsettings";
  const findBtn = (
    <button type="button" className={`ctlBtn ${chatFindOpen ? "modeActive" : ""}`}
      onClick={() => { setChatFindOpen((v) => !v); setChatFind(""); }}
      title="Find in this conversation" aria-label="Find in this conversation">
      <SearchIcon size={15} />
    </button>
  );
  const headerContent = (
    <>
      {aiInfo && !aiInfo.enabled && openAiKeysEditor ? (
        <button className="uiBtn sm" onClick={openAiKeysEditor}
          title="AI needs an API key — add a provider to enable chat">
          Set up AI…
        </button>
      ) : null}
      <div className="ctlBtnRow chatPanelHeaderBtns">
        {aiInfo?.models?.length > 0 ? (() => {
          // Scoped to the active key (Settings → AI & API keys); all models
          // only when no key is selected or the selected one is gone.
          const models = aiProvider && aiInfo.models.some((m) => m.provider === aiProvider)
            ? aiInfo.models.filter((m) => m.provider === aiProvider)
            : aiInfo.models;
          const multiProvider = new Set(models.map((m) => m.provider)).size > 1;
          const currentId = models.some((m) => m.id === chatModel) ? chatModel : models[0].id;
          const currentModel = models.find((m) => m.id === currentId);
          const totalUsage = conversationUsage(chatMessages);
          const usageTitle = totalUsage ? `; this conversation: ${fmtTokens(totalUsage.input)} tokens in, ${fmtTokens(totalUsage.output)} out` : "";
          return (
            <span data-popover="chatsettings" className="popoverAnchor">
              <button type="button" className={`ctlBtn ${settingsOpen ? "modeActive" : ""}`}
                onClick={() => setOpenPopover((p) => (p === "chatsettings" ? null : "chatsettings"))}
                title={`Chat settings — ${currentModel?.model || "model"}${chatEffort ? `, effort: ${chatEffort}` : ""}, context ${chatContextChars.toLocaleString()} chars${usageTitle}`}
                aria-label="Chat settings" aria-expanded={settingsOpen}>
                <SettingsIcon size={15} />
              </button>
              {settingsOpen ? (
                <div className="popover chatSettingsPop">
                  <div className="popoverHint">Global settings for all chats in this browser. Changes also appear in Settings.</div>
                  <div className="popoverSection">Model</div>
                  <MenuSelect
                    block
                    label="Switch model"
                    value={currentId}
                    onChange={setChatModel}
                    options={models.map((m) => [
                      m.id,
                      multiProvider ? `${m.model} · ${m.provider_name || m.provider}` : m.model,
                    ])}
                  />
                  <div className="popoverSection">Reasoning effort</div>
                  <MenuSelect
                    block
                    label="Reasoning effort — leave on 'default' unless the model supports it"
                    value={chatEffort}
                    onChange={setChatEffort}
                    options={[
                      ["", "default"],
                      ...(aiInfo.efforts || ["low", "medium", "high"]).map((ef) => [ef, ef]),
                    ]}
                  />
                  <div className="popoverSection">Context per page · {approxPages(chatContextChars)}</div>
                  <CharSlider value={chatContextChars} onChange={setChatContextChars} />
                  <div className="popoverHint">
                    Extracted PDF text sent with each message. The multi-page total and the agent's read window are in Settings / AI / Advanced AI settings.
                  </div>
                  <div className="popoverSection">Tools</div>
                  <label className="chatToolPermRow" title="Allow assistant tools in all chats">
                    <input type="checkbox" checked={toolsEnabled} onChange={toggleTools} />
                    <SlidersIcon size={13} />
                    <span>Allow tools in all chats</span>
                  </label>
                  <div className="chatToolPicker">
                    <AgentToolPicker kind={chatKind} perms={agentPerms} setPerms={setAgentPerms} disabled={!toolsEnabled} />
                  </div>
                  <div className="popoverHint">
                    Applies to all {chatKindLabel.toLowerCase()} conversations in this browser.
                  </div>
                  <div className="popoverSection">Tokens · this conversation</div>
                  {totalUsage ? (
                    <div className="chatUsageTotal" title={usageDetail(totalUsage)}>
                      <UsageLine usage={totalUsage} className="chatMsgUsage inline" />
                      <span className="popoverHint">{chatMessages.filter((m) => m.role === "ai" && m.usage).length} replies counted, as the provider reported them. Totals per day and model: Settings / AI / Token usage.</span>
                    </div>
                  ) : (
                    <div className="popoverHint">No token counts yet — they appear under each reply once the provider reports them.</div>
                  )}
                </div>
              ) : null}
            </span>
          );
        })() : null}
        <button
          type="button"
          className={`ctlBtn ${toolsEnabled ? "modeActive" : ""}`}
          aria-pressed={toolsEnabled}
          aria-label={`Tools ${toolsEnabled ? "on" : "off"}`}
          onClick={() => { setOpenPopover(null); toggleTools(); }}
          title={`Tools ${toolsEnabled ? "on" : "off"} for all chats - click to change the global setting`}
        >
          <SlidersIcon size={15} />
        </button>
        {findBtn}
        <span data-popover="chathistory" className="popoverAnchor">
          <button type="button" className={`ctlBtn ${historyOpen ? "modeActive" : ""}`}
            onClick={() => setOpenPopover((p) => (p === "chathistory" ? null : "chathistory"))}
            title={`Chat history — earlier conversations of ${folderChat ? "this folder" : "this page"}`}
            aria-label="Chat history" aria-expanded={historyOpen}>
            <HistoryIcon size={15} />
          </button>
          {historyOpen ? (
            <div className="popover chatHistoryPop">
              <input
                autoFocus
                className="searchInput"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder="Search conversations…"
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setOpenPopover(null); } }}
              />
              <div className="chatHistList">
                {historyRows.map((s) => renaming?.id === s.id ? (
                  <div key={s.id} className="chatHistRow renaming">
                    <input
                      autoFocus
                      className="aiKeyInput"
                      value={renaming.text}
                      placeholder="Conversation name"
                      onChange={(e) => setRenaming({ id: s.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                        else if (e.key === "Escape") { e.preventDefault(); renameCancelRef.current = true; e.currentTarget.blur(); }
                      }}
                      onBlur={commitRename}
                    />
                  </div>
                ) : (
                  <div key={s.id} className={`chatHistRow${s.active ? " active" : ""}`}
                    role="button" tabIndex={0}
                    title={s.active ? "The conversation shown now" : `${s.preview || s.title}${s.count ? ` · ${s.count} messages` : ""}`}
                    onClick={() => { if (!s.active) openHistory(s.id); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !s.active) openHistory(s.id); }}>
                    <span className="chatHistTitle">{s.title || "Untitled"}</span>
                    <span className="chatHistAge">{s.active ? "now" : relAge(s.updated_at)}</span>
                    <span className="ctlBtnRow chatHistActs" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="ctlBtn" title="Rename" aria-label="Rename conversation"
                        onClick={() => { renameCancelRef.current = false; setRenaming({ id: s.id, text: s.active ? chatTitle : s.title || "" }); }}>
                        <PencilIcon size={13} />
                      </button>
                      {!s.active ? (
                        <button type="button" className="ctlBtn" title="Delete" aria-label="Delete conversation"
                          onClick={() => deleteHistory(s)}>
                          <TrashIcon size={13} />
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
                {history == null ? <div className="popoverHint">Loading…</div>
                  : historyRows.length <= 1 && !historyQuery.trim() ? <div className="popoverHint">No earlier conversations — New chat keeps the current one here.</div>
                  : !historyRows.length ? <div className="popoverHint">No conversation matches.</div>
                  : null}
              </div>
            </div>
          ) : null}
        </span>
        <button type="button" className="ctlBtn" onClick={newChat} disabled={busyHere}
          title="New chat — keeps this conversation in history and starts a fresh one" aria-label="New chat">
          <PlusIcon size={16} />
        </button>
      </div>
    </>
  );

  return (
    <DockWindow title="Chat" onGrip={onGrip} onGripDoubleClick={onGripDoubleClick}
      collapsed={collapsed} onClose={onClose} headerContent={readOnly ? <>
        <span className="uiTag">Read only</span>
        {findBtn}
      </> : headerContent}>
    <div className="chatPanel chatWindow">
      {!readOnly && aiHealth && !aiHealth.ok ? (
        // The login connection check found the active provider broken — say so
        // here, where the failure would otherwise surface mid-conversation.
        <div className="chatHealthStrip" title={aiHealth.error || ""}>
          <span className="chatHealthText">
            {aiHealth.provider_name ? `${aiHealth.provider_name}: ` : ""}
            {aiHealth.auth
              ? "authentication is broken — sign in again or update the key."
              : `connection failed — ${aiHealth.error || "provider unreachable"}`}
          </span>
          {openAiKeysEditor ? (
            <button className="uiBtn sm" onClick={openAiKeysEditor}>Fix…</button>
          ) : null}
          <button className="uiClose" onClick={dismissAiHealth} title="Dismiss" aria-label="Dismiss">×</button>
        </div>
      ) : null}
      {chatFindOpen ? (
        <div className="chatFindRow">
          <input
            autoFocus
            className="searchInput"
            value={chatFind}
            onChange={(e) => setChatFind(e.target.value)}
            placeholder="Find in chat…"
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); gotoChatFind(e.shiftKey ? chatFindIdx - 1 : chatFindIdx + 1); }
              else if (e.key === "Escape") { e.preventDefault(); setChatFindOpen(false); setChatFind(""); }
            }}
          />
          <span className="chatFindCount">{chatFind.trim() ? `${chatFindMatches.length ? chatFindIdx + 1 : 0}/${chatFindMatches.length}` : ""}</span>
          <button className="searchToggle searchNavBtn" onClick={() => gotoChatFind(chatFindIdx - 1)} disabled={!chatFindMatches.length} title="Previous match">
            <ChevronUpIcon size={14} />
          </button>
          <button className="searchToggle searchNavBtn" onClick={() => gotoChatFind(chatFindIdx + 1)} disabled={!chatFindMatches.length} title="Next match">
            <ChevronDownIcon size={14} />
          </button>
          <button className="uiClose" onClick={() => { setChatFindOpen(false); setChatFind(""); }} title="Close find" aria-label="Close find">×</button>
        </div>
      ) : null}
      <div
        className="chatMessages"
        ref={chatScrollRefCb}
        style={chatTextScale.style}
        onScroll={(e) => {
          const el = e.currentTarget;
          const last = chatLastScrollTopRef.current;
          chatLastScrollTopRef.current = el.scrollTop;
          if (chatProgScrollRef.current) { chatProgScrollRef.current = false; return; }
          if (el.scrollTop < last) {
            chatStickRef.current = false; // any upward move de-sticks
          } else if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
            chatStickRef.current = true; // back at the bottom → follow again
          }
        }}
        onWheel={(e) => {
          // Upward intent unsticks immediately — before any scroll event —
          // so an arriving delta can't yank the view back down first.
          if (e.deltaY < 0 && !(e.ctrlKey || e.metaKey)) chatStickRef.current = false; // Ctrl+wheel resizes text, not scroll
        }}
      >
        {chatTextScale.badge}
        {visibleMessages.length === 0 ? (
          <div className="chatEmpty">
            {loadError || (readOnly ? "No saved conversation for this page." : aiInfo && !aiInfo.enabled ? (
              openAiKeysEditor ? (
                <>Connect an AI provider to start — <button className="chatEmptyLink" onClick={openAiKeysEditor}>Set up AI</button>.</>
              ) : "AI is not configured."
            ) : focusedBlockId ? "Ask AI about this page…"
              : agentIntro || "Ask AI anything, or generate a report from your pages…")}
          </div>
        ) : (
          visibleMessages.map((m, i) => {
            const isUser = m.role === "user";
            const isResponding = busyHere && !isUser && m.partial && i === visibleMessages.length - 1;
            const isFindHit = chatFindOpen && chatFind.trim() && chatFindMatches[chatFindIdx] === i;
            if (editingMsg?.idx === i) {
              return (
                <div key={i} className="chatBubbleRow user" data-msg-idx={i}>
                  <div className="chatMsgCol">
                    <div className="chatBubble user chatEditBubble">
                      <AutoGrowTextarea
                        autoFocus
                        className="chatEditTextarea"
                        value={editingMsg.text}
                        onChange={(e) => setEditingMsg({ idx: i, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            const base = chatMessages.slice(0, i);
                            const text = editingMsg.text;
                            setEditingMsg(null);
                            sendChat(text, { baseMessages: base, referenceMessage: m });
                          } else if (e.key === "Escape") { e.preventDefault(); setEditingMsg(null); }
                        }}
                      />
                      <div className="chatEditBtns">
                        <button type="button" className="uiBtn sm" onClick={() => setEditingMsg(null)}>Cancel</button>
                        <button type="button" className="uiBtn sm chatEditSend"
                          disabled={!editingMsg.text.trim() || chatLoading}
                          onClick={() => {
                            const base = chatMessages.slice(0, i);
                            const text = editingMsg.text;
                            setEditingMsg(null);
                            sendChat(text, { baseMessages: base, referenceMessage: m });
                          }}
                          title="Re-send — replaces this message and everything after it">Send</button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className={`chatBubbleRow ${isUser ? "user" : "ai"}${isFindHit ? " findHit" : ""}`} data-msg-idx={i}>
                <div className="chatMsgCol">
                  <div className={`chatBubble ${isUser ? "user" : "ai"}${m.error ? " error" : ""}`}>
                    {m.images?.length ? (
                      <div className="chatMsgImages">
                        {m.images.map((src, j) => <img key={j} src={src} className="chatMsgImage" alt="pasted figure" />)}
                      </div>
                    ) : null}
                    {m.pdfs?.length ? (
                      <div className="chatMsgPdfs">
                        {m.pdfs.map((n, j) => (
                          <span key={j} className="chatPdfChip" title={n}>
                            <FileIcon size={11} />
                            {n.slice(0, 40)}{n.length > 40 ? "…" : ""}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {!isUser && m.context?.length ? (
                      <ContextCoverage items={m.context} />
                    ) : null}
                    {!isUser && m.actions?.length ? (
                      <div className="chatToolActions">
                        {m.actions.map((a, j) => {
                          const Icon = ACTION_ICONS[a.kind] || FolderIcon;
                          // Chats saved before tool output was recorded have
                          // no raw call — those chips stay plain text.
                          const hasDetail = !!(a.tool || a.result);
                          const key = `${i}:${j}`;
                          const open = openActions.has(key);
                          return (
                            <div key={j} className={`chatToolAction${a.error ? " err" : ""}`}>
                              {hasDetail ? (
                                <button type="button" className="chatToolActionHead"
                                  onClick={() => toggleAction(key)}
                                  title={open ? "Hide tool output" : "Show tool output"}>
                                  <Icon size={11} />
                                  <span>{a.summary}</span>
                                  {open ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
                                </button>
                              ) : (
                                <div className="chatToolActionHead plain" title={a.summary}>
                                  <Icon size={11} />
                                  <span>{a.summary}</span>
                                </div>
                              )}
                              {open ? <pre className="chatToolDetail">{toolCallText(a)}</pre> : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {isUser && m.contextPages?.length ? <div className="chatMsgPdfs">
                      {m.contextPages.map((p) => <button type="button" key={p.id} className="crumbBtn" title={p.title} onClick={() => onOpenPage?.(p.id)}><BookIcon size={11} /><span className="linkChipText">{p.title}</span></button>)}
                    </div> : null}
                    {isUser
                      ? <div className="chatUserText">{m.text}</div>
                      : m.text ? <ChatMarkdown text={m.text} onOpenPage={onOpenPage} copyBlocks /> : null}
                    {isResponding ? (
                      <div className="chatThinking" role="status" aria-label={m.text ? "AI is responding" : "AI is thinking"}>
                        <span aria-hidden="true">{m.text ? "Responding" : "Thinking"}</span>
                        <span className="chatTyping" aria-hidden="true"><span /><span /><span /></span>
                        <UsageLine usage={liveUsage(m.usage, m.live)} className="chatMsgUsage live" />
                      </div>
                    ) : null}
                  </div>
                  {!isResponding ? <div className="chatMsgFoot">
                    {!isUser ? <UsageLine usage={m.usage} /> : null}
                    <div className="chatMsgActions">
                    <button type="button" className="chatMsgActionBtn" title="Copy message"
                      onClick={() => copyChatMessage(i, m.text)}>
                      {copiedMsgIdx === i
                        ? <CheckIcon size={13} />
                        : <CopyIcon size={13} />}
                    </button>
                    {!readOnly && isUser && !chatLoading ? (
                      <button type="button" className="chatMsgActionBtn" title="Edit and re-send (removes later messages)"
                        onClick={() => setEditingMsg({ idx: i, text: m.text })}>
                        <PencilIcon size={13} />
                      </button>
                    ) : null}
                    </div>
                  </div> : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      {!readOnly ? <>
      {pdfSelections.length || chatNotes?.length || cursorChip ? (
        <div className="chatSelChips">
          {cursorChip ? (
            <SelChip kind="isCursor" label="Cursor" text={cursorChip.text}
              title={`Your cursor is on this block — it rides with the message, so "this block" means it.\n${cursorChip.text}`}
              onRemove={() => setCursorOff(cursorChip.id)}
              removeTitle="Don't send the cursor block with this message" />
          ) : null}
          {pdfSelections.map((s, i) => (
            <SelChip key={`p${i}`} text={s}
              label={pdfSelections.length > 1 ? `Sel ${i + 1}` : "Selection"}
              labelTitle="Hold Ctrl while selecting in the PDF to add more passages"
              onRemove={() => setPdfSelections((prev) => prev.filter((_, j) => j !== i))}
              removeTitle="Remove this passage" />
          ))}
          {(chatNotes || []).map((n, i) => (
            <SelChip key={`n${i}`} kind={n.kind === "block" ? "isBlock" : "isNote"} text={n.text}
              label={n.kind === "block" ? "Block" : "Note"}
              labelTitle={n.kind === "block" ? "A note block attached with Ctrl+click or the ⋮⋮ menu — the assistant gets its text and id" : "Text selected in your notes with Ctrl held"}
              onRemove={() => setChatNotes?.((prev) => prev.filter((_, j) => j !== i))}
              removeTitle={n.kind === "block" ? "Detach this block" : "Remove this passage"} />
          ))}
        </div>
      ) : null}
      {chatDocs.length ? (
        <div className="chatReferenceStrip" aria-label="Attached library pages">
          <span className="chatReferenceLabel" title="Paper details and text stay in context for follow-up questions. Notes are optional in the library picker.">Context</span>
          {chatDocs.map((id) => <span className="chatReferenceChip" key={id}>
            <button type="button" className="crumbBtn" title={homeBlocks.find((b) => b.id === id)?.content || "Unavailable page"} onClick={() => onOpenPage?.(id)}><BookIcon size={12} /><span className="linkChipText">{homeBlocks.find((b) => b.id === id)?.content || "Unavailable page"}</span></button>
            <button type="button" className="uiClose uiCloseSm" aria-label={`Remove ${homeBlocks.find((b) => b.id === id)?.content || "page"} from context`} onClick={() => setChatDocs((prev) => prev.filter((p) => p !== id))}><XIcon size={11} /></button>
          </span>)}
        </div>
      ) : null}
      {chatFiles.length ? (
        <div className="chatImgPreviewRow">
          {chatFiles.map((f, i) => (
            <span key={i} className="chatFileChip" title={nativePdf ? `${f.name} — sent with your next message` : `${f.name} — ${nativePdfNote}`}>
              {nativePdf ? <FileIcon size={12} /> : <AlertCircleIcon size={12} />}
              <span className="chatFileChipName">{f.name}</span>
              <button type="button" className="uiClose uiCloseSm chatFileChipRemove" title="Remove file"
                onClick={() => setChatFiles((prev) => prev.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      {chatImages.length ? (
        <div className="chatImgPreviewRow">
          {chatImages.map((src, i) => (
            <span key={i} className="chatImgPreview">
              <img src={src} alt="pasted figure" />
              <button type="button" className="uiClose uiCloseSm uiCloseDanger chatImgRemove" title="Remove image"
                onClick={() => setChatImages((prev) => prev.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <form
        className="chatInputRow"
        onSubmit={(e) => { e.preventDefault(); sendChatMessage(); }}
      >
        {dictation === "rec" ? (
          <>
            <button className="uiBtn chatCircleBtn chatMicBtn" type="button" onClick={() => finishDictation("cancel")} title="Cancel recording" aria-label="Cancel recording">
              <XIcon size={13} />
            </button>
            <canvas ref={waveCanvasRef} className="chatWaveCanvas" />
            <span className="chatRecTimer" aria-live="polite">
              <span className="chatRecDot" />
              {Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, "0")}
            </span>
            <button className="uiBtn chatCircleBtn chatMicBtn" type="button" onClick={() => finishDictation("insert")} title="Stop — put the transcript in the input" aria-label="Stop and transcribe">
              <StopIcon size={11} />
            </button>
            <button className="uiBtn primary chatCircleBtn" type="button" onClick={() => finishDictation("send")} title="Stop and send" aria-label="Stop, transcribe and send">
              <ArrowUpIcon size={14} strokeWidth={2.4} />
            </button>
          </>
        ) : (
        <>
        <span data-popover="chatdocs" className="popoverAnchor">
          <button
            type="button"
            className={`chatAttachToggle chatPlusBtn ${(chatDocs.length || chatIncludeNotes) ? "on" : ""}`}
            onClick={() => setOpenPopover((p) => (p === "chatdocs" ? null : "chatdocs"))}
            title="Add photos & files, or pages from your library"
            aria-label="Add attachments or chat context"
          >
            +{chatDocs.length ? <span className="chatPlusCount">{chatDocs.length}</span> : null}
          </button>
          {openPopover === "chatdocs" ? (
            <div className="popover popUp chatPlusMenu">
              <button type="button" className="chatPlusMenuItem"
                onClick={() => { setOpenPopover(null); fileInputRef.current?.click(); }}>
                <span className="chatPlusMenuIcon">
                  <PaperclipIcon size={15} />
                </span>
                <span className="chatPlusMenuLabel">Add photos &amp; files</span>
                <span className="chatPlusMenuHint">Images or PDFs from your computer</span>
              </button>
              <button type="button" className="chatPlusMenuItem"
                onClick={() => { setOpenPopover(null); setDocPickerQuery(""); setDocPicker(true); }}>
                <span className="chatPlusMenuIcon">
                  <BookIcon size={15} />
                </span>
                <span className="chatPlusMenuLabel">Add pages from library</span>
                <span className="chatPlusMenuHint">{chatDocs.length ? `${chatDocs.length} selected` : "Search your pages"}</span>
              </button>
            </div>
          ) : null}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          style={{ display: "none" }}
          onChange={(e) => { addChatFiles(Array.from(e.target.files || [])); e.target.value = ""; }}
        />
        <button
          type="button"
          className={`chatAttachToggle chatPdfToggle ${attachPdf ? "on" : ""}`}
          disabled={!pageAttach && !chatDocs.length}
          onClick={() => { attachPdfManualRef.current = true; setAttachPdf((v) => !v); }}
          title={!nativePdf
            ? `${attachPdf ? "On, but: " : ""}${nativePdfNote}`
            : attachPdf
              ? "Full PDF file is sent with each message (model sees figures & tables). Click to switch to extracted text only."
              : "Send the full PDF file with your messages so the model sees figures & tables (uses more tokens). Click to enable."}
        >
          <FileIcon size={12} />
          PDF
        </button>
        {attachPdf && !nativePdf ? (
          <button type="button" className="chatAttachToggle chatPdfToggle chatPdfWarn"
            onClick={() => setStatus(nativePdfNote)} title={nativePdfNote}
            aria-label="This provider cannot accept PDF files">
            <AlertCircleIcon size={12} />
          </button>
        ) : null}
        <PaperMentionInput
          key={chatKey}
          pages={homeBlocks} openTabs={openTabs} selected={chatDocs}
          onAttach={(id) => setChatDocs((prev) => prev.includes(id) ? prev : [...prev, id])}
          onSend={sendChatMessage}
          className="chatInput chatInputArea"
          rows={1}
          value={chatInput}
          onChange={setChatInput}
          onPaste={handleChatPaste}
          placeholder={(
            // Names what the message will be about, most specific attachment first.
            chatFiles.length ? `Ask about the attached file${chatFiles.length > 1 ? "s" : ""}…`
            : chatImages.length ? "Ask about the pasted figure…"
            : pdfSelections.length > 1 ? `Ask about the ${pdfSelections.length} selected passages…`
            : pdfSelections.length ? "Ask about the selection…"
            : chatNotes?.length > 1 ? `Ask about the ${chatNotes.length} attached notes…`
            : chatNotes?.length ? (chatNotes[0].kind === "block" ? "Ask about the attached block…" : "Ask about the selected note…")
            : cursorChip ? "Ask about this block…"
            : chatDocs.length ? `Ask about ${chatDocs.length} attached page${chatDocs.length > 1 ? "s" : ""}…`
            : agentAsk || "Ask…"
          ) + " (@ paper)"}
        />
        {chatLoading ? (
          <button className="uiBtn chatCircleBtn chatStopBtn" type="button" onClick={stopChat} title="Stop generating" aria-label="Stop generating">
            <StopIcon size={11} />
          </button>
        ) : dictation === "busy" ? (
          <button className="uiBtn chatCircleBtn chatMicBtn" type="button" disabled title="Transcribing…" aria-label="Transcribing">
            <span className="transferSpin inline" />
          </button>
        ) : (
          <>
            <button className="uiBtn chatCircleBtn chatMicBtn" type="button" onClick={startDictation} title="Dictate — transcribed with your OpenAI key" aria-label="Start dictation">
              <MicIcon size={13} />
            </button>
            <button className="uiBtn primary chatCircleBtn" type="submit" disabled={!chatInput.trim()} title="Send" aria-label="Send">
              <ArrowUpIcon size={14} strokeWidth={2.4} />
            </button>
          </>
        )}
        </>
        )}
      </form>
      </> : null}
      {docPicker ? (
        <div className="reportOverlay" onClick={() => setDocPicker(false)}>
          <div className="reportModal docPickerModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">Add pages to the chat</div>
            <div className="reportModalHint">
              Selected pages (their PDF text, and optionally your notes) are sent with every question —
              pick a few and just ask for a report.
            </div>
            <input
              autoFocus
              className="searchInput"
              placeholder="Search your pages…"
              value={docPickerQuery}
              onChange={(e) => setDocPickerQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setDocPicker(false); } }}
            />
            <div className="reportPageList docPickerList">
              {(() => {
                // Every page can be context — a page of notes as much as a
                // paper; the server adds PDF text for pages that carry one.
                const pages = homeBlocks;
                if (!pages.length) return <div className="popoverHint">No pages yet — create one first.</div>;
                const title = (b) => b.content || "Untitled";
                const byRecency = (x, y) => (y.updated_at || "").localeCompare(x.updated_at || "");
                const row = (b, badge) => (
                  <label key={b.id} className="docPickerItem" title={title(b)}>
                    <input
                      type="checkbox"
                      checked={chatDocs.includes(b.id)}
                      disabled={!chatDocs.includes(b.id) && chatDocs.length >= MAX_CHAT_REFERENCES}
                      onChange={(e) => setChatDocs((prev) => e.target.checked
                        ? [...prev, b.id]
                        : prev.filter((id) => id !== b.id))}
                    />
                    <span className="attachName">{title(b)}</span>
                    {badge || null}
                  </label>
                );
                const q = docPickerQuery.trim().toLowerCase();
                if (q) {
                  const score = createTitleScorer(q);
                  const hits = pages
                    .filter((b) => score && score(b) > 0)
                    .sort((a, b) => score(b) - score(a) || byRecency(a, b));
                  return hits.length
                    ? hits.map((b) => row(b))
                    : <div className="popoverHint">No pages match “{docPickerQuery.trim()}”.</div>;
                }
                // No search: pages open as tabs first (the likely candidates),
                // then the rest of the library by recency.
                const tabIds = (openTabs || []).map((t) => t.id);
                const inTabs = tabIds.map((id) => pages.find((b) => b.id === id)).filter(Boolean);
                const rest = pages.filter((b) => !tabIds.includes(b.id)).sort(byRecency);
                return (
                  <>
                    {inTabs.length ? <div className="popoverSection">Open tabs</div> : null}
                    {inTabs.map((b) => row(b, b.id === focusedBlockId
                      ? <span className="docPickerBadge">current</span> : null))}
                    {rest.length ? <div className="popoverSection">Library</div> : null}
                    {rest.map((b) => row(b))}
                  </>
                );
              })()}
            </div>
            <label className="docPickerItem docPickerNotes">
              <input type="checkbox" checked={chatIncludeNotes} onChange={(e) => setChatIncludeNotes(e.target.checked)} />
              <span className="attachName">Include my notes &amp; highlights</span>
            </label>
            {!chatDocs.length && docId ? (
              <div className="popoverHint">Nothing selected — the open page is used.</div>
            ) : null}
            <div className="reportModalBtns">
              {chatDocs.length ? (
                <button className="uiBtn" onClick={() => setChatDocs([])}>Clear selection</button>
              ) : null}
              <button className="uiBtn primary" onClick={() => setDocPicker(false)}>Done</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
    </DockWindow>
  );
}
