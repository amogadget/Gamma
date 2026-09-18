import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { AutoGrowTextarea } from "../shared/ui/Widgets";
import { BookIcon, CheckIcon } from "../shared/ui/Icons";
import { createTitleScorer } from "../library/librarySearch";
import { insertMention, mentionAt, MAX_CHAT_REFERENCES } from "./paperMentions";

export default function PaperMentionInput({ value, onChange, pages, openTabs, selected, onAttach, onSend, ...props }) {
  const input = useRef(null);
  const list = useRef(null);
  const listId = useId();
  const dismissed = useRef(null);
  const [mention, setMention] = useState(null);
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    if (!mention) return [];
    const score = createTitleScorer(mention?.query || "");
    const tabs = new Set((openTabs || []).map((t) => t.id));
    return pages.filter((p) => !score || score(p) > 0).sort((a, b) =>
      (score ? score(b) - score(a) : Number(tabs.has(b.id)) - Number(tabs.has(a.id)))
      || (b.updated_at || "").localeCompare(a.updated_at || "")).slice(0, 8);
  }, [pages, openTabs, mention?.query, !!mention]);
  useEffect(() => { setActive(0); }, [mention?.query]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);
  useEffect(() => { if (!value) { setMention(null); dismissed.current = null; } }, [value]);
  const scan = (el) => {
    const next = mentionAt(el.value, el.selectionStart, el.selectionEnd);
    if (next?.start === dismissed.current) { setMention(null); return; }
    dismissed.current = null;
    setMention(next);
  };
  const choose = (page) => {
    if (!mention || !page || (!selected.includes(page.id) && selected.length >= MAX_CHAT_REFERENCES)) return;
    onAttach(page.id);
    const next = insertMention(value, mention, page.content || "Untitled");
    onChange(next.text);
    setMention(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
  };
  return <div className="chatMentionInput">
    {mention && <div className="chatMentionPicker">
      <div className="chatMentionHeading">Mention a library page <span>↑↓ choose · Enter add · Esc close</span></div>
      <div ref={list} id={listId} role="listbox" aria-label="Library pages">
        {results.map((page, i) => {
          const meta = page.properties?.meta || {};
          const authors = (meta.authors || []).slice(0, 2).join(", ");
          const detail = [authors, meta.year, meta.venue, page.properties?.folder].filter(Boolean).join(" · ");
          const disabled = !selected.includes(page.id) && selected.length >= MAX_CHAT_REFERENCES;
          return <button type="button" role="option" id={`${listId}-${i}`} key={page.id} tabIndex={-1}
            title={[page.content || "Untitled", detail].filter(Boolean).join("\n")}
            aria-selected={i === active} aria-disabled={disabled} className={`slashMenuItem chatMentionOption${i === active ? " selected" : ""}`}
            onPointerDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(page)}>
            <BookIcon size={15} /><span><strong>{page.content || "Untitled"}</strong>{detail && <small>{detail}</small>}</span>
            {selected.includes(page.id) && <CheckIcon size={13} />}
          </button>;
        })}
        {!results.length && <div className="popoverHint">No matching pages. Try another title.</div>}
      </div>
      <div className="chatMentionHint">{selected.length >= MAX_CHAT_REFERENCES ? `Up to ${MAX_CHAT_REFERENCES} attached pages. Remove one to add another.` : "Adds paper details and text to chat context. Tools can read more."}</div>
    </div>}
    <AutoGrowTextarea {...props} ref={input} value={value} role="combobox" aria-label="Message AI"
      aria-autocomplete="list" aria-expanded={!!mention} aria-controls={mention ? listId : undefined}
      aria-activedescendant={mention && results[active] ? `${listId}-${active}` : undefined}
      onChange={(e) => { onChange(e.target.value); scan(e.target); }}
      onSelect={(e) => scan(e.target)} onBlur={() => setMention(null)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (mention) {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismissed.current = mention.start; setMention(null); return; }
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault(); setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + results.length) % (results.length || 1)); return;
          }
          if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey && results.length &&
              (selected.includes(results[active]?.id) || selected.length < MAX_CHAT_REFERENCES))) {
            e.preventDefault(); choose(results[active]); return;
          }
        }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
      }} />
  </div>;
}
