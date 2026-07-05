// The AI chat window, self-contained: per-page conversation state (loaded/
// saved on the backend), ChatGPT-style message actions (copy/edit/find/stop),
// pasted figures, the "+" context picker, and the per-message PDF attach.
// App provides context (open paper, library, selections) and the model/effort/
// prompt preferences it also needs elsewhere.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { API, apiJson } from "./utils";
import { DockWindow, ChatMarkdown, AutoGrowTextarea } from "./widgets";

export default function ChatDock({
  docId, focusedBlockId, homeBlocks, pdfTitle,
  pdfSelections, setPdfSelections,
  chatModel, setChatModel, chatEffort, setChatEffort, chatSystem,
  aiInfo, openPromptEditor,
  openPopover, setOpenPopover,
  setStatus,
  onGrip, onGripDoubleClick, collapsed, onClose,
}) {
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  // Tracks which block we've finished loading from the server, so the save
  // effect doesn't fire (and clobber the stored chat) before the load lands.
  const chatLoadedForRef = useRef("");
  // Chat history is per page; the home view gets its own bucket.
  const chatKey = focusedBlockId || "home";
  const chatKeyRef = useRef(chatKey);
  chatKeyRef.current = chatKey;
  // Which conversation the in-flight request belongs to (typing indicator
  // shows there, and a reply landing after a page switch is saved there).
  const [chatLoadingKey, setChatLoadingKey] = useState("");
  const chatAbortRef = useRef(null); // in-flight chat request, so Stop can cancel it
  const [chatImages, setChatImages] = useState([]); // pasted figures (data URLs) pending send
  const [editingMsg, setEditingMsg] = useState(null); // {idx, text} — editing a sent user message
  const [copiedMsgIdx, setCopiedMsgIdx] = useState(null);
  const [chatFindOpen, setChatFindOpen] = useState(false);
  const [chatFind, setChatFind] = useState("");
  const [chatFindIdx, setChatFindIdx] = useState(0);
  const [attachPdf, setAttachPdf] = useState(() => {
    try { return localStorage.getItem("gamma-chat-attach-pdf") !== "0"; } catch { return true; }
  });
  // Extra chat context: selected PDF pages + whether to include notes/highlights.
  const [chatDocs, setChatDocs] = useState([]);
  const [chatIncludeNotes, setChatIncludeNotes] = useState(false);
  const chatScrollRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem("gamma-chat-attach-pdf", attachPdf ? "1" : "0"); } catch {}
  }, [attachPdf]);

  // Load chat from backend whenever the chat bucket changes.
  useEffect(() => {
    let cancelled = false;
    chatLoadedForRef.current = "";
    fetch(`${API}/chats/${encodeURIComponent(chatKey)}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(data => {
        if (cancelled) return;
        setChatMessages(data.messages || []);
        chatLoadedForRef.current = chatKey;
        // Fresh conversation → first question should carry the full PDF
        if (!(data.messages || []).length) setAttachPdf(true);
      })
      .catch(() => { if (!cancelled) chatLoadedForRef.current = chatKey; });
    return () => { cancelled = true; };
  }, [chatKey]);

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
    setAttachPdf(true); // new chat: first question carries the full PDF again
    fetch(`${API}/chats/${encodeURIComponent(chatKey)}`, {
      method: "DELETE",
      credentials: "include",
    }).catch(() => {});
  }

  // Paste a figure (screenshot/image) into the chat input → attach it.
  function handleChatPaste(e) {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.type?.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      if (f.size > 6 * 1024 * 1024) { setStatus("Image too large to attach (max 6 MB)."); continue; }
      const reader = new FileReader();
      reader.onload = () => setChatImages((prev) => prev.length >= 4 ? prev : [...prev, reader.result]);
      reader.readAsDataURL(f);
    }
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

  // Keep the chat scrolled to the newest message.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
    const prevMessages = baseMessages ?? chatMessages;
    const shown = selection ? `${text}\n\n> ${selection.slice(0, 280)}${selection.length > 280 ? "…" : ""}` : text;
    // Names of PDFs that ride along with THIS message (displayed in the bubble)
    const sendingPdf = attachPdf && (chatDocs.length > 0 || !!docId);
    const pdfNames = sendingPdf
      ? (chatDocs.length
          ? chatDocs.map((id) => homeBlocks.find((b) => b.id === id)?.content || "PDF")
          : [pdfTitle || "current PDF"])
      : [];
    const userMsg = {
      role: "user",
      text: shown,
      ...(images.length ? { images } : {}),
      ...(pdfNames.length ? { pdfs: pdfNames } : {}),
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
    setChatMessages([...prevMessages, userMsg]);
    setChatLoading(true);
    setChatLoadingKey(sendKey);
    // One-shot semantics: the PDF went with this message; don't silently
    // re-upload (and re-bill) it on every follow-up.
    if (sendingPdf) setAttachPdf(false);
    const ctrl = new AbortController();
    chatAbortRef.current = ctrl;
    let acc = ""; // streamed reply so far — kept on Stop
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
          stream: true,
        }),
      });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try { detail = (await res.json()).detail || detail; } catch {}
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
          acc += ev.delta || "";
        }
        if (acc) showReply({ role: "ai", text: acc, partial: true });
      }
      showReply({ role: "ai", text: acc || "(no response)" }, true);
    } catch (err) {
      const stopped = err?.name === "AbortError";
      showReply({
        role: "ai",
        text: stopped
          ? (acc ? `${acc}\n\n*(stopped)*` : "*(stopped)*")
          : (acc ? `${acc}\n\n**Error:** ${err.message}` : `Error: ${err.message}`),
      }, true);
    } finally {
      setChatLoading(false);
      setChatLoadingKey("");
      chatAbortRef.current = null;
    }
  }

  function sendChatMessage() {
    const text = chatInput;
    if (!text.trim() || chatLoading) return;
    setChatInput("");
    sendChat(text);
  }

  function stopChat() {
    chatAbortRef.current?.abort();
  }

  async function copyChatMessage(idx, text) {
    try {
      await navigator.clipboard.writeText(text || "");
      setCopiedMsgIdx(idx);
      setTimeout(() => setCopiedMsgIdx((cur) => (cur === idx ? null : cur)), 1200);
    } catch {}
  }

  const headerContent = (
    <>
      {aiInfo?.models?.length > 0 ? (() => {
        const models = aiInfo.models;
        const multiProvider = new Set(models.map((m) => m.provider)).size > 1;
        const currentId = models.some((m) => m.id === chatModel) ? chatModel : aiInfo.default;
        return (
          <span className="chatHeaderSelects">
            {models.length > 1 ? (
              <select className="chatModelSelect" value={currentId}
                onChange={(e) => setChatModel(e.target.value)} title="Switch model">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {multiProvider ? `${m.model} · ${m.provider}` : m.model}
                  </option>
                ))}
              </select>
            ) : null}
            <select className="chatModelSelect" value={chatEffort}
              onChange={(e) => setChatEffort(e.target.value)}
              title="Reasoning effort — leave on 'effort: default' unless the model supports it">
              <option value="">effort: default</option>
              {(aiInfo.efforts || ["low", "medium", "high"]).map((ef) => (
                <option key={ef} value={ef}>effort: {ef}</option>
              ))}
            </select>
          </span>
        );
      })() : null}
      <div className="chatPanelHeaderBtns">
        <button className={`chatClearBtn ${chatFindOpen ? "on" : ""}`}
          onClick={() => { setChatFindOpen((v) => !v); setChatFind(""); }}
          title="Find in this conversation">Find</button>
        <button className="chatClearBtn"
          onClick={openPromptEditor}
          title="View or edit the AI prompts (chat, metadata, citations)">Prompt</button>
        <button className="chatClearBtn" onClick={clearChat} title="Start a fresh conversation (clears saved history)">New chat</button>
      </div>
    </>
  );

  return (
    <DockWindow title="Chat" onGrip={onGrip} onGripDoubleClick={onGripDoubleClick}
      collapsed={collapsed} onClose={onClose} headerContent={headerContent}>
    <div className="chatPanel chatWindow">
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
          <button className="searchToggle" onClick={() => gotoChatFind(chatFindIdx - 1)} disabled={!chatFindMatches.length} title="Previous match">▲</button>
          <button className="searchToggle" onClick={() => gotoChatFind(chatFindIdx + 1)} disabled={!chatFindMatches.length} title="Next match">▼</button>
          <button className="searchToggle" onClick={() => { setChatFindOpen(false); setChatFind(""); }} title="Close find">×</button>
        </div>
      ) : null}
      <div className="chatMessages" ref={chatScrollRef}>
        {chatMessages.length === 0 ? (
          <div className="chatEmpty">
            {aiInfo && !aiInfo.enabled
              ? "AI is not configured — set a provider key in the server .env."
              : (focusedBlockId ? "Ask AI about this page…" : "Ask AI anything, or generate a report from your pages…")}
          </div>
        ) : (
          chatMessages.map((m, i) => {
            const isUser = m.role === "user";
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
                            sendChat(text, { baseMessages: base });
                          } else if (e.key === "Escape") { e.preventDefault(); setEditingMsg(null); }
                        }}
                      />
                      <div className="chatEditBtns">
                        <button type="button" className="chatClearBtn" onClick={() => setEditingMsg(null)}>Cancel</button>
                        <button type="button" className="chatClearBtn chatEditSend"
                          disabled={!editingMsg.text.trim() || chatLoading}
                          onClick={() => {
                            const base = chatMessages.slice(0, i);
                            const text = editingMsg.text;
                            setEditingMsg(null);
                            sendChat(text, { baseMessages: base });
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
                  <div className={`chatBubble ${isUser ? "user" : "ai"}`}>
                    {m.images?.length ? (
                      <div className="chatMsgImages">
                        {m.images.map((src, j) => <img key={j} src={src} className="chatMsgImage" alt="pasted figure" />)}
                      </div>
                    ) : null}
                    {m.pdfs?.length ? (
                      <div className="chatMsgPdfs">
                        {m.pdfs.map((n, j) => (
                          <span key={j} className="chatPdfChip" title={n}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                            {n.slice(0, 40)}{n.length > 40 ? "…" : ""}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {isUser
                      ? <div className="chatUserText">{m.text}</div>
                      : <ChatMarkdown text={m.text} />}
                  </div>
                  <div className="chatMsgActions">
                    <button type="button" className="chatMsgActionBtn" title="Copy message"
                      onClick={() => copyChatMessage(i, m.text)}>
                      {copiedMsgIdx === i
                        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>}
                    </button>
                    {isUser && !chatLoading ? (
                      <button type="button" className="chatMsgActionBtn" title="Edit and re-send (removes later messages)"
                        onClick={() => setEditingMsg({ idx: i, text: m.text })}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })
        )}
        {chatLoading && chatLoadingKey === chatKey && !chatMessages[chatMessages.length - 1]?.partial ? (
          <div className="chatBubbleRow ai">
            <div className="chatBubble ai">
              <span className="chatTyping"><span /><span /><span /></span>
            </div>
          </div>
        ) : null}
      </div>
      {pdfSelections.length ? (
        <div className="chatSelChips">
          {pdfSelections.map((s, i) => (
            <div key={i} className="chatSelChip" title={s}>
              <span className="chatSelChipLabel" title="Hold Ctrl while selecting in the PDF to add more passages">
                {pdfSelections.length > 1 ? `Sel ${i + 1}` : "Selection"}
              </span>
              <span className="chatSelChipText">{s.slice(0, 140)}{s.length > 140 ? "…" : ""}</span>
              <button
                type="button"
                className="chatSelChipClose"
                onClick={() => setPdfSelections((prev) => prev.filter((_, j) => j !== i))}
                title="Remove this passage"
              >×</button>
            </div>
          ))}
        </div>
      ) : null}
      {chatImages.length ? (
        <div className="chatImgPreviewRow">
          {chatImages.map((src, i) => (
            <span key={i} className="chatImgPreview">
              <img src={src} alt="pasted figure" />
              <button type="button" className="chatImgRemove" title="Remove image"
                onClick={() => setChatImages((prev) => prev.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <form
        className="chatInputRow"
        onSubmit={(e) => { e.preventDefault(); sendChatMessage(); }}
      >
        <span data-popover="chatdocs" style={{ position: "relative", display: "inline-flex" }}>
          <button
            type="button"
            className={`chatAttachToggle chatPlusBtn ${(chatDocs.length || chatIncludeNotes) ? "on" : ""}`}
            onClick={() => setOpenPopover((p) => (p === "chatdocs" ? null : "chatdocs"))}
            title="Add context: choose PDFs and notes to include in this chat"
            aria-label="Add chat context"
          >
            +{chatDocs.length ? <span className="chatPlusCount">{chatDocs.length}</span> : null}
          </button>
          {openPopover === "chatdocs" ? (
            <div className="popover popUp attachPopover">
              <div className="popoverTitle">Chat context</div>
              <div className="popoverHint">
                Selected PDFs (and optionally your notes) are sent with every question —
                select a few papers and just ask for a report.
              </div>
              <div className="attachList">
                {homeBlocks.filter((b) => b.properties?.doc_id).map((b) => (
                  <label key={b.id} className="popoverItem attachItem">
                    <input
                      type="checkbox"
                      checked={chatDocs.includes(b.id)}
                      onChange={(e) => setChatDocs((prev) => e.target.checked
                        ? [...prev, b.id]
                        : prev.filter((id) => id !== b.id))}
                    />
                    <span className="attachName">{b.content || "Untitled"}</span>
                  </label>
                ))}
                {homeBlocks.filter((b) => b.properties?.doc_id).length === 0 ? (
                  <div className="popoverHint">No PDFs yet — open or upload one first.</div>
                ) : null}
              </div>
              <div className="popoverDivider" />
              <label className="popoverItem attachItem">
                <input type="checkbox" checked={chatIncludeNotes} onChange={(e) => setChatIncludeNotes(e.target.checked)} />
                <span className="attachName">Include my notes &amp; highlights</span>
              </label>
              {!chatDocs.length && docId ? (
                <div className="popoverHint">Nothing selected — the currently open PDF is used.</div>
              ) : null}
            </div>
          ) : null}
        </span>
        <button
          type="button"
          className={`chatAttachToggle chatPdfToggle ${attachPdf ? "on" : ""}`}
          disabled={!docId && !chatDocs.length}
          onClick={() => setAttachPdf((v) => !v)}
          title={attachPdf
            ? "Full PDF file is sent with each message (model sees figures & tables). Click to switch to extracted text only."
            : "Send the full PDF file with your messages so the model sees figures & tables (uses more tokens). Click to enable."}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
          PDF
        </button>
        <AutoGrowTextarea
          className="chatInput chatInputArea"
          rows={1}
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onPaste={handleChatPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
          }}
          placeholder={chatImages.length ? "Ask about the pasted figure…" : (pdfSelections.length ? (pdfSelections.length > 1 ? `Ask about the ${pdfSelections.length} selected passages…` : "Ask about the selection… (Ctrl+select adds more)") : (chatDocs.length ? `Ask about ${chatDocs.length} selected PDF${chatDocs.length > 1 ? "s" : ""}…` : (focusedBlockId ? "Ask about this page… (Shift+Enter for a new line)" : "Ask AI… (paste images to attach)")))}
        />
        {chatLoading ? (
          <button className="chatSendBtn chatCircleBtn chatStopBtn" type="button" onClick={stopChat} title="Stop generating" aria-label="Stop generating">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
          </button>
        ) : (
          <button className="chatSendBtn chatCircleBtn" type="submit" disabled={!chatInput.trim()} title="Send" aria-label="Send">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
          </button>
        )}
      </form>
    </div>
    </DockWindow>
  );
}
