import React, { useEffect, useMemo, useRef, useState } from "react";
import { AutoGrowTextarea } from "./widgets";
import { BookIcon, CheckIcon } from "./icons";
import { createTitleScorer } from "./librarySearch";
import { insertMention, mentionAt } from "./paperMentions";

export default function PaperMentionInput({ value, onChange, pages, openTabs, selected, onAttach, maxPages, onSend, ...props }) {
  const input = useRef(null);
  const list = useRef(null);
  const [mention, setMention] = useState(null);
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const score = createTitleScorer(mention?.query || "");
    const tabs = new Set((openTabs || []).map((t) => t.id));
    return pages.filter((p) => !score || score(p) > 0).sort((a, b) =>
      (score ? score(b) - score(a) : Number(tabs.has(b.id)) - Number(tabs.has(a.id)))
      || (b.updated_at || "").localeCompare(a.updated_at || "")).slice(0, 8);
  }, [pages, openTabs, mention?.query]);
  useEffect(() => { setActive(0); }, [mention?.query]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);
  useEffect(() => { if (!value) setMention(null); }, [value]);
  const scan = (el) => setMention(mentionAt(el.value, el.selectionStart, el.selectionEnd));
  const choose = (page) => {
    if (!page || (!selected.includes(page.id) && selected.length >= maxPages)) return;
    onAttach(page.id);
    const next = insertMention(value, mention, page.content || "Untitled");
    onChange(next.text);
    setMention(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
  };
  return <div className="chatMentionInput">
    {mention && <div className="chatMentionPicker">
      <div className="chatMentionHeading">Mention a library page <span>↑↓ choose · Enter add · Esc close</span></div>
      <div ref={list} id="chat-paper-options" role="listbox" aria-label="Library pages">
        {results.map((page, i) => {
          const meta = page.properties?.meta || {};
          const detail = [meta.year, meta.venue, page.properties?.folder].filter(Boolean).join(" · ");
          const disabled = !selected.includes(page.id) && selected.length >= maxPages;
          return <button type="button" role="option" id={`chat-paper-option-${i}`} key={page.id}
            aria-selected={i === active} aria-disabled={disabled} className="chatMentionOption"
            onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(page)}>
            <BookIcon size={15} /><span><strong>{page.content || "Untitled"}</strong>{detail && <small>{detail}</small>}</span>
            {selected.includes(page.id) && <CheckIcon size={13} />}
          </button>;
        })}
        {!results.length && <div className="popoverHint">No matching pages. Try another title.</div>}
      </div>
      <div className="chatMentionHint">{selected.length >= maxPages ? `Up to ${maxPages} attached pages. Remove one to add another.` : "Adds paper details and text to chat context. Tools can read more."}</div>
    </div>}
    <AutoGrowTextarea {...props} ref={input} value={value} role="combobox" aria-label="Message AI"
      aria-autocomplete="list" aria-expanded={!!mention} aria-controls={mention ? "chat-paper-options" : undefined}
      aria-activedescendant={mention && results[active] ? `chat-paper-option-${active}` : undefined}
      onChange={(e) => { onChange(e.target.value); scan(e.target); }}
      onClick={(e) => scan(e.target)} onBlur={() => setMention(null)}
      onKeyUp={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) scan(e.target); }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (mention) {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMention(null); return; }
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault(); setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + results.length) % (results.length || 1)); return;
          }
          if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && results.length)) {
            e.preventDefault(); choose(results[active]); return;
          }
        }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
      }} />
  </div>;
}
