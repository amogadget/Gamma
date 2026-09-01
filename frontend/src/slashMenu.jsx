// Presentational popup for the DOM-free slash command catalog.
import { useEffect } from "react";
import { useCaretAnchored } from "./latexEditor";

// Notion-style "Paste as" chooser, shown right after a URL is pasted into the
// editor. The URL text is already inserted; picking an option rewrites it
// (mention chip / synced embed / titled link), dismissing keeps the URL.
export function PasteAsPopup({ items, selected, anchor, onPick }) {
  const [listRef, style] = useCaretAnchored(anchor, false, [items]);
  return (
    <div ref={listRef} className="slashMenu pasteAsMenu" style={style}>
      <div className="pasteAsTitle">Paste as</div>
      {items.map((c, i) => (
        <button
          key={c.name}
          type="button"
          className={`slashMenuItem${i === selected ? " selected" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
        >
          <span className="slashMenuGlyph">{c.glyph}</span>
          <span className="slashMenuLabel">{c.label}</span>
          {c.hint ? <span className="slashMenuHint">{c.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SlashMenuPopup({ items, selected, anchor, onPick }) {
  const [listRef, style] = useCaretAnchored(anchor, false, [items]);
  useEffect(() => {
    listRef.current
      ?.querySelector(".slashMenuItem.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, listRef]);
  return (
    <div ref={listRef} className="slashMenu" style={style}>
      {items.map((command, index) => (
        <button
          key={command.name}
          type="button"
          className={`slashMenuItem${index === selected ? " selected" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(command)}
        >
          <span className="slashMenuGlyph">{command.glyph}</span>
          <span className="slashMenuLabel">{command.label}</span>
          {command.hint ? <span className="slashMenuHint">{command.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
