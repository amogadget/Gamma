// The AI chat window, self-contained: per-page conversation state (loaded/
// saved on the backend), ChatGPT-style message actions (copy/edit/find/stop),
// pasted figures, the "+" context picker, and the per-message PDF attach.
// App provides context (open paper, library, selections) and the model/effort/
// prompt preferences it also needs elsewhere.
import { useEffect, useMemo, useRef, useState } from "react";
import { API, apiJson, isEnterCommit, copyText, isPdfFile } from "./utils";
import { DockWindow, ChatMarkdown, AutoGrowTextarea, useCopied } from "./widgets";
import { MenuSelect } from "./menus";
import {
  AlertCircleIcon,
  ArrowUpIcon,
  BookIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  InfoIcon,
  ListIcon,
  MicIcon,
  PaperclipIcon,
  PencilIcon,
  SearchIcon,
  SlidersIcon,
  StopIcon,
  XIcon,
} from "./icons";

// Folder-agent tool chips expose the arguments and result the model saw.
const ACTION_ICONS = {
  rename: PencilIcon,
  move: FolderIcon,
  search: SearchIcon,
  read: BookIcon,
  list: ListIcon,
  error: XIcon,
};

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
        ? `Only ${span} of ${what} fit the context budget — the rest was not visible to the model. Raise the budget in Settings → Assistant → Context, or turn on Tools so it can read and search the whole paper.`
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

const MUTATING_KINDS = new Set(["rename", "move"]);
const toolCallText = (action) => {
  const args = Object.entries(action.args || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  const head = `${action.tool || action.kind}(${args})`;
  return [head, action.result].filter(Boolean).join("\n\n");
};

export default function ChatDock({
  docId,
  focusedBlockId,
  homeBlocks,
  pdfTitle,
  openTabs,
  pdfSelections,
  setPdfSelections,
  chatImages,
  setChatImages,
  chatModel,
  setChatModel,
  chatEffort,
  setChatEffort,
  chatSystem,
  setAiProvider,
  dictationModel,
  dictationLang,
  chatContextChars,
  multiContextChars,
  aiInfo,
  aiProvider,
  openAiKeysEditor,
  aiHealth,
  dismissAiHealth,
  refreshAiModels,
  openPopover,
  setOpenPopover,
  setStatus,
  // Home/folder view: the folder path being viewed ("" = library root) —
  // enables folder-agent tools; paper view gets scoped read tools.
  organizeFolder = null,
  toolRounds,
  agentReadChars,
  agentPerms,
  agentSystem,
  agentEnabled,
  folderToolsDefault,
  pdfToolsDefault,
  onLibraryChange,
  onGrip,
  onGripDoubleClick,
  collapsed,
  onClose,
}) {
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatModelRefreshing, setChatModelRefreshing] = useState(false);
  // Tracks which block we've finished loading from the server, so the save
  // effect doesn't fire (and clobber the stored chat) before the load lands.
  const chatLoadedForRef = useRef("");
  // Chat history is per page; the home view buckets per folder so switching
  // folders cannot leak one organizer conversation into another.
  const chatKey = focusedBlockId || (organizeFolder ? `home:${organizeFolder}` : "home");
  const folderChat = organizeFolder != null;
  const settingsDefault = folderChat ? folderToolsDefault !== false : !!pdfToolsDefault;
  // Conversation-local overrides. Switching pages/folders retains each
  // conversation's choice for this session; New chat drops it back to the
  // configured scope default.
  const [chatToolConfigs, setChatToolConfigs] = useState({});
  const chatToolConfig = chatToolConfigs[chatKey];
  const chatToolPerms = agentPerms || {};
  const toolsRequested = chatToolConfig?.enabled ?? settingsDefault;
  const toolsEnabled = !!agentEnabled && !!toolsRequested;
  const perm = (key) => chatToolPerms?.[key] !== false;
  const toggleToolsForChat = () => setChatToolConfigs((prev) => ({
    ...prev,
    [chatKey]: { enabled: !(prev[chatKey]?.enabled ?? settingsDefault) },
  }));
  const resetToolConfig = () => setChatToolConfigs((prev) => {
    const next = { ...prev };
    delete next[chatKey];
    return next;
  });
  // What the agent may do here after applying the chat-local switches.
  const agentReads = perm("list") || perm("read") || perm("search");
  const agentWrites = perm("rename") || perm("move");
  const agentPayload = () => {
    if (!toolsEnabled) return {};
    const scope =
      organizeFolder != null && (agentReads || agentWrites)
        ? { agent_scope: "folder", folder: organizeFolder }
        : focusedBlockId && (perm("read") || perm("search"))
          ? { agent_scope: "page", page_id: focusedBlockId }
          : null;
    return scope
      ? {
          ...scope,
          tool_rounds: toolRounds || 0,
          read_char_limit: agentReadChars || 0,
          permissions: agentPerms || {},
          agent_system: agentSystem || "",
        }
      : {};
  };
  const agentScopeName = organizeFolder ? "this folder" : "your library";
  const agentIntro =
    organizeFolder == null || !toolsEnabled
      ? null
      : agentWrites
        ? `Ask AI anything — it can ${agentReads ? "read, search and " : ""}organize ${agentScopeName} (rename papers, file them into folders)…`
        : agentReads
          ? `Ask AI across ${organizeFolder ? "this folder's papers" : "your library"} — it can read, search and summarize them…`
          : null;
  const agentAsk = agentIntro
    ? agentWrites
      ? `Ask, or organize ${agentScopeName}…`
      : `Ask across ${agentScopeName}…`
    : null;
  const chatKeyRef = useRef(chatKey);
  chatKeyRef.current = chatKey;
  // Which conversation the in-flight request belongs to (typing indicator
  // shows there, and a reply landing after a page switch is saved there).
  const [chatLoadingKey, setChatLoadingKey] = useState("");
  const chatAbortRef = useRef(null); // in-flight chat request, so Stop can cancel it
  // chatImages (pasted/area-selection figures pending send) lives in App —
  // like pdfSelections — so the PDF viewer can attach into it.
  const [editingMsg, setEditingMsg] = useState(null); // {idx, text} — editing a sent user message
  const [copiedMsgIdx, flashCopiedMsg] = useCopied(1200);
  const [openActions, setOpenActions] = useState(() => new Set());
  const toggleAction = (key) =>
    setOpenActions((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
    `${activeModel?.provider_name || "This provider"} does not accept PDF files — the PDF is sent as extracted text instead (first ${(chatContextChars || 0).toLocaleString()} characters; Settings → Assistant → Context).`;
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
  const [docPicker, setDocPicker] = useState(false); // "Add papers" modal
  const [docPickerQuery, setDocPickerQuery] = useState("");
  const fileInputRef = useRef(null);
  const chatScrollRef = useRef(null);
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

  // Load chat from backend whenever the chat bucket changes.
  useEffect(() => {
    let cancelled = false;
    chatLoadedForRef.current = "";
    fetch(`${API}/chats/${encodeURIComponent(chatKey)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data) => {
        if (cancelled) return;
        const msgs = data.messages || [];
        setChatMessages(msgs);
        chatLoadedForRef.current = chatKey;
        // PDF button: on until this document has been sent in THIS
        // conversation, then off. Messages record the doc ids they carried
        // (pdfDocs); older saves only have display names — treat any sent
        // PDF as covering the current one.
        const sent = msgs.some((m) =>
          m.pdfDocs
            ? (docId && m.pdfDocs.includes(docId)) || m.pdfDocs.some((d) => chatDocs.includes(d))
            : m.pdfs?.length,
        );
        attachPdfManualRef.current = false;
        setAttachPdf(!sent && nativePdf);
      })
      .catch(() => {
        if (!cancelled) chatLoadedForRef.current = chatKey;
      });
    return () => {
      cancelled = true;
    };
    // chatDocs is read inside the async callback, not a load trigger — the
    // chat re-fetches only when the bucket (chatKey/docId) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey, docId]);

  // Save chat to backend (debounced) when chatMessages changes, but only
  // after the load for the current chat bucket completed.
  useEffect(() => {
    if (chatLoadedForRef.current !== chatKey) return;
    const timer = setTimeout(() => {
      fetch(`${API}/chats/${encodeURIComponent(chatKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages: chatMessages }),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [chatMessages, chatKey]);

  function clearChat() {
    setChatMessages([]);
    attachPdfManualRef.current = false;
    setAttachPdf(nativePdf); // new chat: first question carries the full PDF again (where the provider takes it)
    resetToolConfig();
    fetch(`${API}/chats/${encodeURIComponent(chatKey)}`, {
      method: "DELETE",
      credentials: "include",
    }).catch(() => {});
  }

  // Attach picked/pasted files: images join the pasted-figures row, PDFs
  // become one-shot native attachments (same as the library PDF button).
  function addChatFiles(files) {
    for (const f of files) {
      if (isPdfFile(f)) {
        if (f.size > 15 * 1024 * 1024) { setStatus(`"${f.name}" is too large to attach (max 15 MB).`); continue; }
        const reader = new FileReader();
        reader.onload = () =>
          setChatFiles((prev) =>
            prev.length >= 4
              ? prev
              : [...prev, { name: f.name || "file.pdf", data: reader.result }],
          );
        reader.readAsDataURL(f);
      } else if (f.type?.startsWith("image/")) {
        if (f.size > 6 * 1024 * 1024) {
          setStatus("Image too large to attach (max 6 MB).");
          continue;
        }
        const reader = new FileReader();
        reader.onload = () =>
          setChatImages((prev) => (prev.length >= 4 ? prev : [...prev, reader.result]));
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
    return chatMessages
      .map((m, i) => ((m.text || "").toLowerCase().includes(q) ? i : -1))
      .filter((i) => i >= 0);
  }, [chatFind, chatMessages]);
  useEffect(() => {
    setChatFindIdx(0);
  }, [chatFind]);

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
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "f" &&
        document.activeElement?.closest?.(".chatPanel")
      ) {
        e.preventDefault();
        setChatFindOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Escape closes the paper-picker modal wherever focus is.
  useEffect(() => {
    if (!docPicker) return;
    function onKey(e) {
      if (e.key === "Escape") setDocPicker(false);
    }
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
  useEffect(() => {
    chatStickRef.current = true;
  }, [chatKey]);
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
  async function sendChat(rawText, { baseMessages } = {}) {
    const text = (rawText || "").trim();
    if (!text || chatLoading) return;
    const selection = pdfSelections.join("\n\n---\n\n");
    setPdfSelections([]);
    const images = chatImages;
    setChatImages([]);
    const files = chatFiles;
    setChatFiles([]);
    const prevMessages = baseMessages ?? chatMessages;
    const shown = selection
      ? `${text}\n\n> ${selection.slice(0, 280)}${selection.length > 280 ? "…" : ""}`
      : text;
    // Names of PDFs that ride along with THIS message (displayed in the bubble)
    const sendingPdf = attachPdf && (chatDocs.length > 0 || !!docId);
    const pdfNames = [
      ...files.map((f) => f.name),
      ...(sendingPdf
        ? chatDocs.length
          ? chatDocs.map((id) => homeBlocks.find((b) => b.id === id)?.content || "PDF")
          : [pdfTitle || "current PDF"]
        : []),
    ];
    const userMsg = {
      role: "user",
      text: shown,
      ...(images.length ? { images } : {}),
      // pdfDocs records WHICH documents rode along, so reloading the page
      // can tell whether this document was already sent in the conversation
      // (uploaded files aren't library docs — they contribute names only).
      ...(pdfNames.length
        ? { pdfs: pdfNames, pdfDocs: sendingPdf ? (chatDocs.length ? [...chatDocs] : [docId]) : [] }
        : {}),
    };
    const sendKey = chatKey; // reply belongs to THIS conversation, even if the user navigates away
    const showReply = (aiMsg, final) => {
      if (chatKeyRef.current === sendKey) {
        setChatMessages([...prevMessages, userMsg, aiMsg]);
      } else if (final) {
        // The user switched pages mid-request — save straight to the
        // original conversation instead of the one on screen.
        fetch(`${API}/chats/${encodeURIComponent(sendKey)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ messages: [...prevMessages, userMsg, aiMsg] }),
        }).catch(() => {});
      }
    };
    chatStickRef.current = true; // sending always snaps back to the bottom
    setChatMessages([...prevMessages, userMsg]);
    setChatLoading(true);
    setChatLoadingKey(sendKey);
    // One-shot semantics: the PDF went with this message; don't silently
    // re-upload (and re-bill) it on every follow-up.
    if (sendingPdf) setAttachPdf(false);
    const ctrl = new AbortController();
    chatAbortRef.current = ctrl;
    let acc = ""; // streamed reply so far — kept on Stop
    const actions = []; // organizer mutations streamed for this reply
    let coverage = null; // {"context": [...]} — what the model was given, per document
    const aiMsg = (extra = {}) => ({
      role: "ai", text: acc,
      ...(actions.length ? { actions: [...actions] } : {}),
      ...(coverage ? { context: coverage } : {}),
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
          doc_id: docId || "",
          history: prevMessages,
          model: chatModel || "",
          selection,
          attach_pdf: sendingPdf,
          effort: chatEffort || "",
          system: chatSystem || "",
          pages: chatDocs,
          include_notes: chatIncludeNotes,
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
        try {
          detail = (await res.json()).detail || detail;
        } catch {}
        throw new Error(detail);
      }
      // NDJSON stream: {"delta": "…"} per chunk, {"error": "…"} on failure.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop(); // keep the trailing partial line
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.error) throw new Error(ev.error);
          if (ev.action) { actions.push(ev.action); continue; }
          if (ev.context) { coverage = ev.context; continue; }
          acc += ev.delta || "";
        }
        if (acc || actions.length) showReply(aiMsg({ partial: true }));
      }
      showReply(aiMsg({ text: acc || (actions.length ? "" : "(no response)") }), true);
    } catch (err) {
      const stopped = err?.name === "AbortError";
      showReply(
        {
          role: "ai",
          text: stopped
            ? acc
              ? `${acc}\n\n*(stopped)*`
              : "*(stopped)*"
            : acc
              ? `${acc}\n\n**Error:** ${err.message}`
              : `Error: ${err.message}`,
        },
        true,
      );
    } finally {
      setChatLoading(false);
      setChatLoadingKey("");
      chatAbortRef.current = null;
      // Read-only tool calls render as chips but do not change the library.
      if (actions.some((action) => MUTATING_KINDS.has(action.kind))) onLibraryChange?.();
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
    chatAbortRef.current?.abort();
  }

  async function startDictation() {
    if (dictation) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setStatus(
        "Voice input needs HTTPS or localhost — the browser blocks the microphone on plain HTTP.",
      );
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
    const mime =
      ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) || "";
    const rec = {
      recorder: new MediaRecorder(stream, mime ? { mimeType: mime } : undefined),
      stream,
      chunks: [],
      canceled: false,
      autoSend: false,
      baseText: chatInput, // composer text at record start (the input is hidden while recording)
      amps: [],
      peak: 0,
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
    rec.recorder.ondataavailable = (e) => {
      if (e.data?.size) rec.chunks.push(e.data);
    };
    rec.recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      rec.audioCtx?.close().catch(() => {});
      if (rec.canceled) return;
      transcribeDictation(
        new Blob(rec.chunks, { type: rec.recorder.mimeType || mime || "audio/webm" }),
        rec,
      );
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
    try {
      rec.recorder.stop();
    } catch {
      setDictation("");
    }
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
    let raf,
      lastPush = 0;
    const draw = (now) => {
      raf = requestAnimationFrame(draw);
      rec.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      rec.peak = Math.max(rec.peak, Math.sqrt(sum / data.length));
      if (now - lastPush >= 50) {
        // one slot ≈ 50 ms of audio
        rec.amps.push(rec.peak);
        rec.peak = 0;
        lastPush = now;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth,
        h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = barColor;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      const cursorX = w - 3;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(cursorX, h * 0.12);
      ctx.lineTo(cursorX, h * 0.88);
      ctx.stroke();
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
  useEffect(
    () => () => {
      const rec = recRef.current;
      if (rec) {
        rec.canceled = true;
        try {
          rec.recorder.stop();
        } catch {}
        rec.stream.getTracks().forEach((t) => t.stop());
        rec.audioCtx?.close().catch(() => {});
      }
    },
    [],
  );

  async function copyChatMessage(idx, text) {
    if (await copyText(text || "")) flashCopiedMsg(idx);
  }

  const headerContent = (
    <>
      {aiInfo && !aiInfo.enabled && openAiKeysEditor ? (
        <button
          className="uiBtn sm"
          onClick={openAiKeysEditor}
          title="AI needs an API key — add a provider to enable chat"
        >
          Set up AI…
        </button>
      ) : null}
      {aiInfo?.models?.length > 0
        ? (() => {
            // Show every configured model, not just the active key's. Picking one
            // from a different provider also flips the Settings-side aiProvider so
            // the two selectors stay in sync (previously the model-scope effect
            // in App.jsx snapped chatModel back and made cross-provider picks a
            // no-op).
            const models = aiInfo.models;
            const multiProvider = new Set(models.map((m) => m.provider)).size > 1;
            const currentId = models.some((m) => m.id === chatModel) ? chatModel : models[0].id;
            const lastRefresh = aiInfo.refreshed_at ? new Date(aiInfo.refreshed_at) : null;
            return (
              <span className="chatHeaderSelects">
                <MenuSelect
                  label="Switch model"
                  value={currentId}
                  onChange={(id) => {
                    const picked = models.find((m) => m.id === id);
                    if (picked && picked.provider !== aiProvider) setAiProvider?.(picked.provider);
                    setChatModel(id);
                  }}
                  options={models.map((m) => [
                    m.id,
                    multiProvider ? `${m.model} · ${m.provider_name || m.provider}` : m.model,
                  ])}
                />
                <button
                  className="chatModelRefreshBtn"
                  onClick={refreshModelList}
                  disabled={chatModelRefreshing}
                  title={
                    `Fetch the latest model lists from your providers` +
                    (lastRefresh && !Number.isNaN(lastRefresh.getTime())
                      ? ` — last auto-refresh ${lastRefresh.toLocaleString()}`
                      : " — refreshed automatically about once a day")
                  }
                >
                  {chatModelRefreshing ? "…" : "↻"}
                </button>
                <MenuSelect
                  label="Reasoning effort — leave on 'effort: default' unless the model supports it"
                  icon={BrainIcon}
                  iconOnly
                  value={chatEffort}
                  onChange={setChatEffort}
                  options={[
                    ["", "effort: default"],
                    ...(aiInfo.efforts || ["low", "medium", "high"]).map((ef) => [ef, `effort: ${ef}`]),
                  ]}
                />
              </span>
            );
          })()
        : null}
      <div className="chatPanelHeaderBtns">
        <button
          type="button"
          className={`uiBtn sm iconSq chatHeaderIconBtn chatToolsBtn ${toolsEnabled ? "on" : ""}`}
          disabled={!agentEnabled}
          aria-pressed={toolsEnabled}
          aria-label={`Tools ${toolsEnabled ? "on" : "off"}`}
          onClick={() => { setOpenPopover(null); toggleToolsForChat(); }}
          title={agentEnabled
            ? `Turn tools ${toolsEnabled ? "off" : "on"} for this chat only`
            : "Agent tools are disabled in Settings → Assistant"}
        >
          <SlidersIcon size={17} />
        </button>
        <button
          className={`uiBtn sm iconSq chatHeaderIconBtn ${chatFindOpen ? "on" : ""}`}
          onClick={() => {
            setChatFindOpen((v) => !v);
            setChatFind("");
          }}
          title="Find in this conversation"
          aria-label="Find in this conversation"
        >
          <SearchIcon size={17} />
        </button>
        <button
          className="uiBtn sm"
          onClick={clearChat}
          title="Start a fresh conversation (clears saved history)"
        >
          New chat
        </button>
      </div>
    </>
  );

  async function refreshModelList() {
    if (chatModelRefreshing) return;
    setChatModelRefreshing(true);
    try {
      await apiJson(`${API}/ai/models/refresh`, { method: "POST" });
      await refreshAiModels?.();
      setStatus?.("Model list refreshed from providers");
    } catch (e) {
      setStatus?.(e.message || "Model refresh failed");
    } finally {
      setChatModelRefreshing(false);
    }
  }

  return (
    <DockWindow
      title="Chat"
      onGrip={onGrip}
      onGripDoubleClick={onGripDoubleClick}
      collapsed={collapsed}
      onClose={onClose}
      headerContent={headerContent}
    >
      <div className="chatPanel chatWindow">
        {aiHealth && !aiHealth.ok ? (
          // The login connection check found the active provider broken — say
          // so here, where the failure would otherwise surface mid-conversation.
          <div className="chatHealthStrip" title={aiHealth.error || ""}>
            <span className="chatHealthText">
              {aiHealth.provider_name ? `${aiHealth.provider_name}: ` : ""}
              {aiHealth.auth
                ? "authentication is broken — sign in again or update the key."
                : `connection failed — ${aiHealth.error || "provider unreachable"}`}
            </span>
            {openAiKeysEditor ? (
              <button className="uiBtn sm" onClick={openAiKeysEditor}>
                Fix…
              </button>
            ) : null}
            <button
              className="uiClose"
              onClick={dismissAiHealth}
              title="Dismiss"
              aria-label="Dismiss"
            >
              ×
            </button>
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
                if (isEnterCommit(e)) {
                  e.preventDefault();
                  gotoChatFind(e.shiftKey ? chatFindIdx - 1 : chatFindIdx + 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setChatFindOpen(false);
                  setChatFind("");
                }
              }}
            />
            <span className="chatFindCount">
              {chatFind.trim()
                ? `${chatFindMatches.length ? chatFindIdx + 1 : 0}/${chatFindMatches.length}`
                : ""}
            </span>
            <button
              className="searchToggle searchNavBtn"
              onClick={() => gotoChatFind(chatFindIdx - 1)}
              disabled={!chatFindMatches.length}
              title="Previous match"
            >
              <ChevronUpIcon size={14} />
            </button>
            <button
              className="searchToggle searchNavBtn"
              onClick={() => gotoChatFind(chatFindIdx + 1)}
              disabled={!chatFindMatches.length}
              title="Next match"
            >
              <ChevronDownIcon size={14} />
            </button>
            <button
              className="uiClose"
              onClick={() => {
                setChatFindOpen(false);
                setChatFind("");
              }}
              title="Close find"
              aria-label="Close find"
            >
              ×
            </button>
          </div>
        ) : null}
        <div
          className="chatMessages"
          ref={chatScrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const last = chatLastScrollTopRef.current;
            chatLastScrollTopRef.current = el.scrollTop;
            if (chatProgScrollRef.current) {
              chatProgScrollRef.current = false;
              return;
            }
            if (el.scrollTop < last) {
              chatStickRef.current = false; // any upward move de-sticks
            } else if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
              chatStickRef.current = true; // back at the bottom → follow again
            }
          }}
          onWheel={(e) => {
            // Upward intent unsticks immediately — before any scroll event —
            // so an arriving delta can't yank the view back down first.
            if (e.deltaY < 0) chatStickRef.current = false;
          }}
        >
          {chatMessages.length === 0 ? (
            <div className="chatEmpty">
              {aiInfo && !aiInfo.enabled ? (
                openAiKeysEditor ? (
                  <>
                    AI is not configured —{" "}
                    <button className="chatEmptyLink" onClick={openAiKeysEditor}>
                      add an AI provider
                    </button>{" "}
                    with your API key to enable it.
                  </>
                ) : (
                  "AI is not configured."
                )
              ) : focusedBlockId ? (
                "Ask AI about this page…"
              ) : (
                agentIntro || "Ask AI anything, or generate a report from your pages…"
              )}
            </div>
          ) : (
            chatMessages.map((m, i) => {
              const isUser = m.role === "user";
              const isFindHit =
                chatFindOpen && chatFind.trim() && chatFindMatches[chatFindIdx] === i;
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
                            if (isEnterCommit(e) && !e.shiftKey) {
                              e.preventDefault();
                              const base = chatMessages.slice(0, i);
                              const text = editingMsg.text;
                              setEditingMsg(null);
                              sendChat(text, { baseMessages: base });
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditingMsg(null);
                            }
                          }}
                        />
                        <div className="chatEditBtns">
                          <button
                            type="button"
                            className="uiBtn sm"
                            onClick={() => setEditingMsg(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="uiBtn sm chatEditSend"
                            disabled={!editingMsg.text.trim() || chatLoading}
                            onClick={() => {
                              const base = chatMessages.slice(0, i);
                              const text = editingMsg.text;
                              setEditingMsg(null);
                              sendChat(text, { baseMessages: base });
                            }}
                            title="Re-send — replaces this message and everything after it"
                          >
                            Send
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={i}
                  className={`chatBubbleRow ${isUser ? "user" : "ai"}${isFindHit ? " findHit" : ""}`}
                  data-msg-idx={i}
                >
                  <div className="chatMsgCol">
                    <div className={`chatBubble ${isUser ? "user" : "ai"}`}>
                      {m.images?.length ? (
                        <div className="chatMsgImages">
                          {m.images.map((src, j) => (
                            <img key={j} src={src} className="chatMsgImage" alt="pasted figure" />
                          ))}
                        </div>
                      ) : null}
                      {m.pdfs?.length ? (
                        <div className="chatMsgPdfs">
                          {m.pdfs.map((n, j) => (
                            <span key={j} className="chatPdfChip" title={n}>
                              <FileIcon size={11} />
                              {n.slice(0, 40)}
                              {n.length > 40 ? "…" : ""}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {isUser ? (
                        <div className="chatUserText">{m.text}</div>
                      ) : (
                        <ChatMarkdown text={m.text} />
                      )}
                      {!isUser && m.context?.length ? (
                        <ContextCoverage items={m.context} />
                      ) : null}
                      {!isUser && m.actions?.length ? (
                        <div className="chatToolActions">
                          {m.actions.map((action, actionIndex) => {
                            const Icon = ACTION_ICONS[action.kind] || FolderIcon;
                            const hasDetail = Boolean(action.tool || action.result);
                            const actionKey = `${i}:${actionIndex}`;
                            const open = openActions.has(actionKey);
                            return (
                              <div
                                key={actionIndex}
                                className={`chatToolAction${action.error ? " err" : ""}`}
                              >
                                {hasDetail ? (
                                  <button
                                    type="button"
                                    className="chatToolActionHead"
                                    onClick={() => toggleAction(actionKey)}
                                    title={open ? "Hide tool output" : "Show tool output"}
                                  >
                                    <Icon size={11} />
                                    <span>{action.summary}</span>
                                    {open ? (
                                      <ChevronUpIcon size={10} />
                                    ) : (
                                      <ChevronDownIcon size={10} />
                                    )}
                                  </button>
                                ) : (
                                  <div className="chatToolActionHead plain" title={action.summary}>
                                    <Icon size={11} />
                                    <span>{action.summary}</span>
                                  </div>
                                )}
                                {open ? (
                                  <pre className="chatToolDetail">{toolCallText(action)}</pre>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                    <div className="chatMsgActions">
                      <button
                        type="button"
                        className="chatMsgActionBtn"
                        title="Copy message"
                        onClick={() => copyChatMessage(i, m.text)}
                      >
                        {copiedMsgIdx === i ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                      </button>
                      {isUser && !chatLoading ? (
                        <button
                          type="button"
                          className="chatMsgActionBtn"
                          title="Edit and re-send (removes later messages)"
                          onClick={() => setEditingMsg({ idx: i, text: m.text })}
                        >
                          <PencilIcon size={13} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })
          )}
          {chatLoading &&
          chatLoadingKey === chatKey &&
          !chatMessages[chatMessages.length - 1]?.partial ? (
            <div className="chatBubbleRow ai">
              <div className="chatBubble ai">
                <span className="chatTyping">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          ) : null}
        </div>
        {pdfSelections.length ? (
          <div className="chatSelChips">
            {pdfSelections.map((s, i) => (
              <div key={i} className="chatSelChip" title={s}>
                <span
                  className="chatSelChipLabel"
                  title="Hold Ctrl while selecting in the PDF to add more passages"
                >
                  {pdfSelections.length > 1 ? `Sel ${i + 1}` : "Selection"}
                </span>
                <span className="chatSelChipText">
                  {s.slice(0, 140)}
                  {s.length > 140 ? "…" : ""}
                </span>
                <button
                  type="button"
                  className="uiClose uiCloseSm chatSelChipClose"
                  onClick={() => setPdfSelections((prev) => prev.filter((_, j) => j !== i))}
                  title="Remove this passage"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {chatFiles.length ? (
          <div className="chatImgPreviewRow">
            {chatFiles.map((f, i) => (
              <span
                key={i}
                className="chatFileChip"
                title={
                  nativePdf
                    ? `${f.name} — sent with your next message`
                    : `${f.name} — ${nativePdfNote}`
                }
              >
                {nativePdf ? <FileIcon size={12} /> : <AlertCircleIcon size={12} />}
                <span className="chatFileChipName">{f.name}</span>
                <button
                  type="button"
                  className="uiClose uiCloseSm chatFileChipRemove"
                  title="Remove file"
                  onClick={() => setChatFiles((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {chatImages.length ? (
          <div className="chatImgPreviewRow">
            {chatImages.map((src, i) => (
              <span key={i} className="chatImgPreview">
                <img src={src} alt="pasted figure" />
                <button
                  type="button"
                  className="uiClose uiCloseSm uiCloseDanger chatImgRemove"
                  title="Remove image"
                  onClick={() => setChatImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <form
          className="chatInputRow"
          onSubmit={(e) => {
            e.preventDefault();
            sendChatMessage();
          }}
        >
          {dictation === "rec" ? (
            <>
              <button
                className="uiBtn chatCircleBtn chatMicBtn"
                type="button"
                onClick={() => finishDictation("cancel")}
                title="Cancel recording"
                aria-label="Cancel recording"
              >
                <XIcon size={13} />
              </button>
              <canvas ref={waveCanvasRef} className="chatWaveCanvas" />
              <span className="chatRecTimer" aria-live="polite">
                <span className="chatRecDot" />
                {Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, "0")}
              </span>
              <button
                className="uiBtn chatCircleBtn chatMicBtn"
                type="button"
                onClick={() => finishDictation("insert")}
                title="Stop — put the transcript in the input"
                aria-label="Stop and transcribe"
              >
                <StopIcon size={11} />
              </button>
              <button
                className="uiBtn primary chatCircleBtn"
                type="button"
                onClick={() => finishDictation("send")}
                title="Stop and send"
                aria-label="Stop, transcribe and send"
              >
                <ArrowUpIcon size={14} strokeWidth={2.4} />
              </button>
            </>
          ) : (
            <>
              <span
                data-popover="chatdocs"
                style={{ position: "relative", display: "inline-flex" }}
              >
                <button
                  type="button"
                  className={`chatAttachToggle chatPlusBtn ${chatDocs.length || chatIncludeNotes ? "on" : ""}`}
                  onClick={() => setOpenPopover((p) => (p === "chatdocs" ? null : "chatdocs"))}
                  title="Add photos & files, or papers from your library"
                  aria-label="Add attachments or chat context"
                >
                  +
                  {chatDocs.length ? (
                    <span className="chatPlusCount">{chatDocs.length}</span>
                  ) : null}
                </button>
                {openPopover === "chatdocs" ? (
                  <div className="popover popUp chatPlusMenu">
                    <button
                      type="button"
                      className="chatPlusMenuItem"
                      onClick={() => {
                        setOpenPopover(null);
                        fileInputRef.current?.click();
                      }}
                    >
                      <span className="chatPlusMenuIcon">
                        <PaperclipIcon size={15} />
                      </span>
                      <span className="chatPlusMenuLabel">Add photos &amp; files</span>
                      <span className="chatPlusMenuHint">Images or PDFs from your computer</span>
                    </button>
                    <button
                      type="button"
                      className="chatPlusMenuItem"
                      onClick={() => {
                        setOpenPopover(null);
                        setDocPickerQuery("");
                        setDocPicker(true);
                      }}
                    >
                      <span className="chatPlusMenuIcon">
                        <BookIcon size={15} />
                      </span>
                      <span className="chatPlusMenuLabel">Add papers from library</span>
                      <span className="chatPlusMenuHint">
                        {chatDocs.length ? `${chatDocs.length} selected` : "Search your papers"}
                      </span>
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
                onChange={(e) => {
                  addChatFiles(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className={`chatAttachToggle chatPdfToggle ${attachPdf ? "on" : ""}`}
                disabled={!docId && !chatDocs.length}
                onClick={() => {
                  attachPdfManualRef.current = true;
                  setAttachPdf((v) => !v);
                }}
                title={
                  !nativePdf
                    ? `${attachPdf ? "On, but: " : ""}${nativePdfNote}`
                    : attachPdf
                    ? "Full PDF file is sent with each message (model sees figures & tables). Click to switch to extracted text only."
                    : "Send the full PDF file with your messages so the model sees figures & tables (uses more tokens). Click to enable."
                }
              >
                <FileIcon size={12} />
                PDF
              </button>
              {attachPdf && !nativePdf ? (
                <button
                  type="button"
                  className="chatAttachToggle chatPdfToggle chatPdfWarn"
                  onClick={() => setStatus(nativePdfNote)}
                  title={nativePdfNote}
                  aria-label="This provider cannot accept PDF files"
                >
                  <AlertCircleIcon size={12} />
                </button>
              ) : null}
              <AutoGrowTextarea
                className="chatInput chatInputArea"
                rows={1}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onPaste={handleChatPaste}
                onKeyDown={(e) => {
                  if (isEnterCommit(e) && !e.shiftKey) {
                    e.preventDefault();
                    sendChatMessage();
                  }
                }}
                placeholder={
                  chatFiles.length
                    ? `Ask about the attached file${chatFiles.length > 1 ? "s" : ""}…`
                    : chatImages.length
                      ? "Ask about the pasted figure…"
                      : pdfSelections.length
                        ? pdfSelections.length > 1
                          ? `Ask about the ${pdfSelections.length} selected passages…`
                          : "Ask about the selection…"
                        : chatDocs.length
                          ? `Ask about ${chatDocs.length} selected PDF${chatDocs.length > 1 ? "s" : ""}…`
                          : agentAsk || "Ask…"
                }
              />
              {chatLoading ? (
                <button
                  className="uiBtn chatCircleBtn chatStopBtn"
                  type="button"
                  onClick={stopChat}
                  title="Stop generating"
                  aria-label="Stop generating"
                >
                  <StopIcon size={11} />
                </button>
              ) : dictation === "busy" ? (
                <button
                  className="uiBtn chatCircleBtn chatMicBtn"
                  type="button"
                  disabled
                  title="Transcribing…"
                  aria-label="Transcribing"
                >
                  <span className="transferSpin inline" />
                </button>
              ) : (
                <>
                  <button
                    className="uiBtn chatCircleBtn chatMicBtn"
                    type="button"
                    onClick={startDictation}
                    title="Dictate — transcribed with your OpenAI key"
                    aria-label="Start dictation"
                  >
                    <MicIcon size={13} />
                  </button>
                  <button
                    className="uiBtn primary chatCircleBtn"
                    type="submit"
                    disabled={!chatInput.trim()}
                    title="Send"
                    aria-label="Send"
                  >
                    <ArrowUpIcon size={14} strokeWidth={2.4} />
                  </button>
                </>
              )}
            </>
          )}
        </form>
        {docPicker ? (
          <div className="reportOverlay" onClick={() => setDocPicker(false)}>
            <div className="reportModal docPickerModal" onClick={(e) => e.stopPropagation()}>
              <div className="reportModalTitle">Add papers to the chat</div>
              <div className="reportModalHint">
                Selected papers (and optionally your notes) are sent with every question — pick a
                few and just ask for a report.
              </div>
              <input
                autoFocus
                className="searchInput"
                placeholder="Search your papers…"
                value={docPickerQuery}
                onChange={(e) => setDocPickerQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDocPicker(false);
                  }
                }}
              />
              <div className="reportPageList docPickerList">
                {(() => {
                  const papers = homeBlocks.filter((b) => b.properties?.doc_id);
                  if (!papers.length)
                    return (
                      <div className="popoverHint">No PDFs yet — open or upload one first.</div>
                    );
                  const title = (b) => b.content || "Untitled";
                  const byRecency = (x, y) =>
                    (y.updated_at || "").localeCompare(x.updated_at || "");
                  const row = (b, badge) => (
                    <label key={b.id} className="docPickerItem" title={title(b)}>
                      <input
                        type="checkbox"
                        checked={chatDocs.includes(b.id)}
                        onChange={(e) =>
                          setChatDocs((prev) =>
                            e.target.checked ? [...prev, b.id] : prev.filter((id) => id !== b.id),
                          )
                        }
                      />
                      <span className="attachName">{title(b)}</span>
                      {badge || null}
                    </label>
                  );
                  const q = docPickerQuery.trim().toLowerCase();
                  if (q) {
                    const words = q.split(/\s+/);
                    const hits = papers
                      .filter((b) => {
                        const t = title(b).toLowerCase();
                        return words.every((w) => t.includes(w));
                      })
                      .sort(byRecency);
                    return hits.length ? (
                      hits.map((b) => row(b))
                    ) : (
                      <div className="popoverHint">No papers match “{docPickerQuery.trim()}”.</div>
                    );
                  }
                  // No search: papers open as tabs first (the likely candidates),
                  // then the rest of the library by recency.
                  const tabIds = (openTabs || []).map((t) => t.id);
                  const inTabs = tabIds
                    .map((id) => papers.find((b) => b.id === id))
                    .filter(Boolean);
                  const rest = papers.filter((b) => !tabIds.includes(b.id)).sort(byRecency);
                  return (
                    <>
                      {inTabs.length ? <div className="popoverSection">Open tabs</div> : null}
                      {inTabs.map((b) =>
                        row(
                          b,
                          b.id === focusedBlockId ? (
                            <span className="docPickerBadge">current</span>
                          ) : null,
                        ),
                      )}
                      {rest.length ? <div className="popoverSection">Library</div> : null}
                      {rest.map((b) => row(b))}
                    </>
                  );
                })()}
              </div>
              <label className="docPickerItem docPickerNotes">
                <input
                  type="checkbox"
                  checked={chatIncludeNotes}
                  onChange={(e) => setChatIncludeNotes(e.target.checked)}
                />
                <span className="attachName">Include my notes &amp; highlights</span>
              </label>
              {!chatDocs.length && docId ? (
                <div className="popoverHint">
                  Nothing selected — the currently open PDF is used.
                </div>
              ) : null}
              <div className="reportModalBtns">
                {chatDocs.length ? (
                  <button className="uiBtn" onClick={() => setChatDocs([])}>
                    Clear selection
                  </button>
                ) : null}
                <button className="uiBtn primary" onClick={() => setDocPicker(false)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </DockWindow>
  );
}
