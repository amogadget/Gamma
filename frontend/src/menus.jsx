// Shared menu primitives. One dismissal + positioning story for every
// cursor-anchored menu in the app (right-click page/folder menu, highlight
// menu, attach-highlight menu), so they can't drift apart again.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "./icons";

// A context menu positioned at a screen point (x, y). Rendered through a
// portal so it escapes the window-stack's overflow/stacking contexts, clamps
// itself inside the viewport, and dismisses on outside-pointerdown or Escape.
// Menu items still close the menu themselves via their own onClick.
// anchorRight treats x as the menu's RIGHT edge (dropdowns opening from a
// right-aligned control, e.g. the settings selects).
// ignoreRef: element whose pointerdowns must NOT dismiss the menu — the
// dropdown trigger, so its own click can toggle instead of fighting the
// outside-pointerdown dismissal.
function ContextMenu({ x, y, onClose, className = "", anchorRight = false, ignoreRef, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp inside the viewport once we know the menu's size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const { width, height } = el.getBoundingClientRect();
    let left = anchorRight ? x - width : x, top = y;
    if (left + width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - width - pad);
    if (left < pad) left = pad;
    if (top + height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - height - pad);
    setPos({ left, top });
  }, [x, y, anchorRight]);

  useEffect(() => {
    function onDown(e) {
      if (!ref.current || ref.current.contains(e.target)) return;
      if (ignoreRef?.current && ignoreRef.current.contains(e.target)) return;
      onClose();
    }
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }
    // Capture phase so we see the click before it lands on other handlers.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`ctxMenu ${className}`}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

// One dropdown story for every choice control (Codex-style): a pill trigger
// showing the current value, opening a ContextMenu below it. The hook gives
// the trigger props (including its ref — passed to ContextMenu as ignoreRef
// so the trigger's own click toggles) plus the open state; MenuSelect and
// ActionMenu are the two shapes built on it.
function useDropdown() {
  const [menu, setMenu] = useState(null); // {x (right edge), y}
  const triggerRef = useRef(null);
  const close = () => setMenu(null);
  const triggerProps = {
    ref: triggerRef,
    onClick: () => {
      if (menu) { close(); return; }
      const r = triggerRef.current.getBoundingClientRect();
      setMenu({ x: r.right, y: r.bottom + 4 });
    },
  };
  return [menu, close, triggerProps, triggerRef];
}

// A <select> replacement: options are [value, label] pairs; the menu marks
// the current one with a check. `block` stretches the trigger into a field.
// Options are [value, label] or [value, label, Icon] tuples — with an Icon the
// pill and the menu items lead with the glyph (same look as ActionMenu items).
// `icon` collapses the trigger to that fixed glyph + chevron (no value label) —
// the current choice rides in the tooltip instead. Used where the pill's text
// width doesn't fit, e.g. the home toolbar's sort control on a phone.
function MenuSelect({ value, onChange, options, label, block, icon: TriggerIcon }) {
  const [menu, close, triggerProps, triggerRef] = useDropdown();
  const current = options.find(([v]) => v === value) || options[0];
  const CurrentIcon = current?.[2];
  const title = TriggerIcon ? `${current?.[1]} — ${label}` : label;
  return (
    <>
      <button type="button" className={`uiBtn sm uiSelectBtn ${block ? "block" : ""}`}
        aria-label={title} title={title} {...triggerProps}>
        {TriggerIcon ? (
          <TriggerIcon size={13} />
        ) : (
          <>
            {CurrentIcon ? <CurrentIcon size={13} /> : null}
            <span className="uiSelectLabel">{current?.[1]}</span>
          </>
        )}
        <ChevronDownIcon size={13} className="uiSelectChev" />
      </button>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} anchorRight onClose={close} ignoreRef={triggerRef}>
          {options.map(([val, lab, OptIcon]) => (
            <button key={val} className="ctxMenuItem ctxMenuItemIconed"
              onClick={() => { close(); onChange(val); }}>
              {OptIcon ? <span className="ctxMenuIcon"><OptIcon size={14} /></span> : null}
              {lab}
              {val === value ? <CheckIcon size={14} className="ctxMenuCheck" /> : null}
            </button>
          ))}
        </ContextMenu>
      ) : null}
    </>
  );
}

// A button that opens a small action menu (the Users rows' Export / Import).
// items: [{icon, label, title, onClick}].
function ActionMenu({ label, icon: Icon, items, disabled }) {
  const [menu, close, triggerProps, triggerRef] = useDropdown();
  return (
    <>
      <button type="button" className="uiBtn sm uiSelectBtn" disabled={disabled} {...triggerProps}>
        {Icon ? <Icon size={13} /> : null}{label}
        <ChevronDownIcon size={13} className="uiSelectChev" />
      </button>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} anchorRight onClose={close} ignoreRef={triggerRef}>
          {items.map(({ icon: ItemIcon, label: lab, title, onClick }) => (
            <button key={lab} className="ctxMenuItem ctxMenuItemIconed" title={title}
              onClick={() => { close(); onClick(); }}>
              {ItemIcon ? <span className="ctxMenuIcon"><ItemIcon size={14} /></span> : null}
              {lab}
            </button>
          ))}
        </ContextMenu>
      ) : null}
    </>
  );
}

export { ContextMenu, MenuSelect, ActionMenu };
