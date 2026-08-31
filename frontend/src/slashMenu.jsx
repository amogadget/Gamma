// Presentational popup for the DOM-free slash command catalog.
import { useEffect } from "react";
import { useCaretAnchored } from "./latexEditor";

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
