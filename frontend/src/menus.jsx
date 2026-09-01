// Shared menu primitives. One dismissal + positioning story for every
// cursor-anchored menu in the app (right-click page/folder menu, highlight
// menu, attach-highlight menu), so they can't drift apart again. Rows
// (MenuItem), section headings (MenuLabel) and nested flyouts (SubMenuItem)
// live here too, so every menu gets the same iconed row and submenu behavior.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "./icons";
import { useMenuAim } from "./menuAim";

// Every ContextMenu publishes its submenu state so the rows inside it — at
// any nesting depth — can open/close flyouts without the caller wiring state.
const MenuCtx = createContext(null);

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
  // Open flyout (SubMenuItem id) + the pointer-intent guard that keeps a
  // diagonal move into it from being read as "hovered the row below".
  const [openSub, setOpenSub] = useState(null);
  const aim = useMenuAim();

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

  // Hovering anywhere in the menu that is NOT the open flyout (or its own
  // trigger) closes it — but only once the cursor stops aiming at it, so the
  // rows the diagonal path crosses don't snatch the hover.
  function onPointerOver(e) {
    if (!openSub) return;
    if (e.target.closest(".ctxSubMenu")) { aim.keep(); return; }
    if (e.target.closest(`[data-submenu="${CSS.escape(openSub)}"]`)) { aim.keep(); return; }
    aim.guard(() => setOpenSub(null));
  }

  return createPortal(
    <div
      ref={ref}
      className={`ctxMenu ${className}`}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerOver={onPointerOver}
    >
      <MenuCtx.Provider value={{ openSub, setOpenSub, aim }}>{children}</MenuCtx.Provider>
    </div>,
    document.body,
  );
}

// One menu row: optional leading glyph, label, optional trailing node.
// `danger` tints destructive actions. Everything that isn't a row prop is
// forwarded, so callers keep their own title/disabled/onClick.
function MenuItem({ icon: Icon, children, trailing, danger = false, className = "", ...rest }) {
  return (
    <button
      type="button"
      className={`ctxMenuItem ctxMenuItemIconed ${danger ? "danger" : ""} ${className}`}
      {...rest}
    >
      <span className="ctxMenuIcon">{Icon ? <Icon size={14} /> : null}</span>
      <span className="ctxMenuText">{children}</span>
      {trailing}
    </button>
  );
}

// Uppercase section heading inside a menu.
function MenuLabel({ children }) {
  return <div className="ctxMenuLabel">{children}</div>;
}

// A row that opens a nested flyout on hover (or click/Enter/→ for keyboard
// and touch). The panel renders INSIDE the parent menu's DOM — portalling it
// would put it outside the parent's outside-pointerdown test, and the parent
// would dismiss itself before a click on a flyout row could land. `id` just
// has to be unique within its menu.
function SubMenuItem({ id, icon: Icon, label, title, children }) {
  const { openSub, setOpenSub, aim } = useContext(MenuCtx) || {};
  const open = openSub === id;
  const panelRef = useRef(null);
  const wrapRef = useRef(null);
  const [style, setStyle] = useState({ left: "100%", top: -4 });

  // Side-flip + vertical clamp: prefer opening right, fall back to left when
  // that would leave the viewport, and slide up so the panel always fits.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current, wrap = wrapRef.current;
    if (!panel || !wrap) return;
    const pad = 8;
    const w = wrap.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const flip = w.right + p.width > window.innerWidth - pad && w.left - p.width > pad;
    let top = -4;
    if (w.top + top + p.height > window.innerHeight - pad) top = window.innerHeight - pad - p.height - w.top;
    if (w.top + top < pad) top = pad - w.top;
    setStyle(flip ? { right: "100%", top } : { left: "100%", top });
  }, [open]);

  // Hand the settled rect to the pointer-intent guard (and take it back when
  // the flyout closes, so nothing is protected that isn't on screen).
  useLayoutEffect(() => {
    if (!open) { aim?.setTarget(null); return undefined; }
    aim?.setTarget(panelRef.current?.getBoundingClientRect() || null);
    return () => aim?.setTarget(null);
  }, [open, style, aim]);

  return (
    <div className="ctxSubWrap" ref={wrapRef}>
      <button
        type="button"
        className={`ctxMenuItem ctxMenuItemIconed ctxSubTrigger ${open ? "open" : ""}`}
        data-submenu={id}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerEnter={() => aim?.guard(() => setOpenSub(id))}
        onClick={(e) => { e.stopPropagation(); aim?.keep(); setOpenSub(open ? null : id); }}
        onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); setOpenSub(id); } }}
      >
        <span className="ctxMenuIcon">{Icon ? <Icon size={14} /> : null}</span>
        <span className="ctxMenuText">{label}</span>
        <ChevronRightIcon size={13} className="ctxSubChev" />
      </button>
      {open ? (
        <div ref={panelRef} className="ctxMenu ctxSubMenu" style={style} role="menu">
          {children}
        </div>
      ) : null}
    </div>
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
// `iconOnly` also removes the chevron for especially tight toolbars.
// the current choice rides in the tooltip instead. Used where the pill's text
// width doesn't fit, e.g. the home toolbar's sort control on a phone.
function MenuSelect({ value, onChange, options, label, block, icon: TriggerIcon, iconOnly = false }) {
  const [menu, close, triggerProps, triggerRef] = useDropdown();
  const current = options.find(([v]) => v === value) || options[0];
  const CurrentIcon = current?.[2];
  const title = TriggerIcon ? `${current?.[1]} — ${label}` : label;
  return (
    <>
      <button type="button" className={`uiBtn sm uiSelectBtn ${block ? "block" : ""} ${TriggerIcon && iconOnly ? "iconSq" : ""}`}
        aria-label={title} title={title} {...triggerProps}>
        {TriggerIcon ? (
          <TriggerIcon size={13} />
        ) : (
          <>
            {CurrentIcon ? <CurrentIcon size={13} /> : null}
            <span className="uiSelectLabel">{current?.[1]}</span>
          </>
        )}
        {!iconOnly ? <ChevronDownIcon size={13} className="uiSelectChev" /> : null}
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

export { ContextMenu, MenuItem, MenuLabel, SubMenuItem, MenuSelect, ActionMenu };
