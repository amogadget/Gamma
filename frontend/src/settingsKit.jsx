// The building blocks every settings pane is composed from — and nothing
// else: PaneHead › Section › Row/Toggle for the panes themselves, SubDialog ›
// Step/Field for the editor dialogs they open, plus the small shared controls
// (Segmented, PictureChoices, Stepper, UnitInput, CharSlider, AccountPicker, LogBox, Stat, Empty, QuotaMeter/PercentMeter). New settings
// UI should reuse these; bespoke classes are for layout only.
import React from "react";
import { copyText, fmtBytes } from "./utils";
import { CheckIcon, EyeIcon, EyeOffIcon, ShieldIcon, UserIcon } from "./icons";

export const SettingsDraftContext = React.createContext(null);

export function useSettingsDraft(key, dirty, discard) {
  const drafts = React.useContext(SettingsDraftContext);
  React.useEffect(() => {
    if (dirty) drafts?.current.set(key, discard);
    else drafts?.current.delete(key);
    return () => drafts?.current.delete(key);
  }, [drafts, key, dirty, discard]);
}

export function PaneHead({ icon: Icon, title, children }) {
  return (
    <div className="setHead" data-setting={title}>
      <span className="setHeadIcon"><Icon size={17} /></span>
      <span className="settingText">
        <span className="settingsPaneTitle">{title}</span>
        {children ? <span className="settingsPaneHint">{children}</span> : null}
      </span>
    </div>
  );
}

export function Section({ title, action, children }) {
  return (
    <>
      <div className="setSection" data-setting={title}>
        <span className="setSectionLabel">{title}</span>
        <span className="setSectionRule" />
        {action}
      </div>
      {children}
    </>
  );
}

// Keep the row compact: icon, label, short hint, and a shared control.
// Longer explanations use the native hover tooltip.
export function Row({ icon: Icon, label, hint, title, scope, children }) {
  return (
    <div className="settingRow setRow" data-setting={label} title={title}>
      <span className="setIcon">{Icon ? <Icon size={15} /> : null}</span>
      <div className="settingText">
        <span className="settingLabel">{label}{scope ? <small className="setScope">{scope}</small> : null}</span>
        {hint ? <span className="settingDesc">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label, ...row }) {
  return (
    <Row label={label} {...row}>
      <span className="switch">
        <input
          type="checkbox" checked={checked} disabled={disabled} aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switchTrack" />
      </span>
    </Row>
  );
}

// Joined pill buttons for a single mutually-exclusive choice.
// `options` are [value, label, Icon, tooltip].
export function Segmented({ value, onChange, options }) {
  return (
    <span className="segGroup">
      {options.map(([val, label, Icon, tip]) => (
        <button
          key={val} type="button" title={tip || label}
          aria-pressed={value === val}
          className={`uiBtn sm ${value === val ? "on" : ""}`}
          onClick={() => onChange(val)}
        >
          {Icon ? <Icon size={13} /> : null}{label}
        </button>
      ))}
    </span>
  );
}

// Compact visual alternatives for a single preference. Previews are decorative;
// labels, descriptions and the pressed state identify each choice accessibly.
export function PictureChoices({ label, value, onChange, onConfirm, options, columns = 3 }) {
  return <div className="setPictureChoices" role="group" aria-label={label} style={{ "--picture-columns": columns }}>
    {options.map(({ value: id, label: name, hint, preview }) => (
      <button key={String(id)} type="button" className={`uiBtn setPictureChoice${value === id ? " on" : ""}`}
        aria-label={name} aria-description={hint} title={hint} aria-pressed={value === id} onClick={() => onChange(id)}
        onDoubleClick={onConfirm ? () => onConfirm(id) : undefined}>
        {preview}
        <span className="setPictureCaption">
          <span className="setPictureName">{name}</span>
          {hint ? <span className="setPictureHint">{hint}</span> : null}
          <span className="setPictureCheck" aria-hidden="true">{value === id ? <CheckIcon size={12} /> : null}</span>
        </span>
      </button>
    ))}
  </div>;
}

// A row of small icon + short-name chips, each an independent on/off switch
// (the multi-select counterpart of Segmented): the agent's per-tool
// permissions, any "which of these" choice. `options` are
// [value, label, Icon, tooltip]; `selected` lists the values that are on.
// Chips wrap when the row is narrow, so it fits a settings row's control
// slot and a chat popover alike.
export function ToggleGroup({ selected, onToggle, options, disabled }) {
  const on = new Set(selected || []);
  return (
    <span className="toggleGroup" role="group">
      {options.map(([val, label, Icon, tip]) => (
        <button
          key={val} type="button" title={tip || label} disabled={disabled}
          className={`uiBtn sm ${on.has(val) ? "on" : ""}`}
          aria-pressed={on.has(val)}
          onClick={() => onToggle(val, !on.has(val))}
        >
          {Icon ? <Icon size={13} /> : null}{label}
        </button>
      ))}
    </span>
  );
}

// Draft-aware editor dialog opened from inside the settings surface — same shape as
// the PDF export dialog (reportModal), stacked above the settings overlay.
// Every editor dialog is composed the same way: SubDialog › .settingsForm ›
// Step (numbered stages, for flows) or Field (label + hint + one control),
// closed by a .reportModalBtns footer.
export function SubDialog({ title, onClose, children, draft, className = "", closeButton = false }) {
  const key = React.useId();
  const [initial] = React.useState(() => JSON.stringify(draft));
  const dirty = draft !== undefined && JSON.stringify(draft) !== initial;
  const [confirmClose, setConfirmClose] = React.useState(false);
  const ref = React.useRef(null);
  useSettingsDraft(key, dirty, onClose);
  const close = () => dirty ? setConfirmClose(true) : onClose();
  React.useEffect(() => {
    const previous = document.activeElement;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div className="reportOverlay subDialog" onClick={(event) => { event.stopPropagation(); close(); }}>
      <div className={`reportModal ${className}`} role="dialog" aria-modal="true" aria-label={title}
        ref={ref} tabIndex={-1} onClick={(event) => event.stopPropagation()}
        onClickCapture={(event) => {
          if (dirty && event.target.closest("button")?.textContent.trim() === "Cancel") {
            event.preventDefault(); event.stopPropagation(); close();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation();
            if (confirmClose) setConfirmClose(false); else close();
          }
          if (event.key === "Tab") {
            event.stopPropagation();
            const targets = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary')]
              .filter((el) => el.getClientRects().length && !el.closest("[inert]"));
            const first = targets[0], last = targets.at(-1);
            if (event.shiftKey && (document.activeElement === first || !targets.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first?.focus(); }
          }
        }}>
        {closeButton ? <div className="settingsDialogHeader" inert={confirmClose ? "" : undefined}>
          <div className="reportModalTitle">{title}</div>
          <button type="button" className="uiClose uiCloseLg" onClick={close} aria-label={`Close ${title}`} title="Close">×</button>
        </div> : <div className="reportModalTitle">{title}</div>}
        <div className="settingsDialogContent" inert={confirmClose ? "" : undefined}>{children}</div>
        {confirmClose ? <div className="settingsUnsaved" role="alertdialog" aria-label="Unsaved changes">
          <span>Discard your unsaved edits?</span>
          <button className="uiBtn" autoFocus onClick={() => setConfirmClose(false)}>Keep editing</button>
          <button className="uiBtn danger" onClick={onClose}>Discard changes</button>
        </div> : null}
      </div>
    </div>
  );
}

// Numbered stage of a dialog flow (the add/edit-key wizard).
export function Step({ n, title, hint, children }) {
  return (
    <div className="setStep">
      <div className="setStepHead">
        <span className="setStepNum">{n}</span>
        <span className="settingText">
          <span className="setStepTitle">{title}</span>
          {hint ? <span className="settingDesc">{hint}</span> : null}
        </span>
      </div>
      <div className="setStepBody">{children}</div>
    </div>
  );
}

// One labeled control: bold-ish caption, muted hint after it, control below.
export function Field({ label, hint, children }) {
  return (
    <label className="setField">
      <span className="setFieldLabel">
        {label}
        {hint ? <span className="settingDesc"> — {hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

// A password box with a show/hide eye at its right edge. `className` is the
// input's own class (aiKeyInput in settings forms, loginInput on the login
// page); everything else is passed through to the <input>. The eye is kept
// out of the Tab order so Enter/Tab flow stays input → next control.
export function PasswordInput({ className = "aiKeyInput", ...props }) {
  const [shown, setShown] = React.useState(false);
  return (
    <span className="pwField">
      <input {...props} className={className} type={shown ? "text" : "password"} />
      <button
        type="button" className="ctlBtn pwToggle" tabIndex={-1}
        title={shown ? "Hide password" : "Show password"}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        onMouseDown={(event) => event.preventDefault()} // keep the input's focus + caret
        onClick={() => setShown((v) => !v)}
      >
        {shown ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
      </button>
    </span>
  );
}

// Number input with a fixed unit suffix, so "MB" never has to live in the
// label text. Empty string means "inherit" wherever the caller says so.
// Two modes: live (onChange fires per keystroke — for draft state the caller
// buffers itself) or deferred (onCommit fires the raw text on blur/Enter —
// for handlers that clamp into range, so the clamp doesn't fight half-typed
// values: typing "25" into a 1–32 field must not snap at "2").
export function UnitInput({ value, onChange, onCommit, unit, placeholder, min, onEnter }) {
  const [draft, setDraft] = React.useState(null); // non-null only while editing deferred
  return (
    <span className="unitInput">
      <input
        className="aiKeyInput" type="number" min={min}
        placeholder={placeholder} value={onCommit ? (draft ?? String(value ?? "")) : value}
        onChange={(event) => (onCommit ? setDraft(event.target.value) : onChange(event.target.value))}
        onBlur={onCommit ? () => { if (draft != null) { onCommit(draft); setDraft(null); } } : undefined}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (onCommit) event.currentTarget.blur(); // commit via onBlur
          onEnter?.();
        }}
      />
      <span className="unitSuffix">{unit}</span>
    </span>
  );
}

// A −/+ stepper for a small numeric range (the control size): two square
// `uiBtn sm iconSq` buttons around a tabular readout. `format` renders the
// value (e.g. as a percentage); steps clamp to [min, max] and round away
// float drift. Click the readout to jump back to `reset` when given.
export function Stepper({ value, onChange, min, max, step, format, reset }) {
  const clamp = (n) => Math.round(Math.min(max, Math.max(min, n)) * 1000) / 1000;
  return (
    <span className="stepper">
      <button type="button" className="uiBtn sm iconSq" aria-label="Smaller"
        disabled={value <= min} onClick={() => onChange(clamp(value - step))}>−</button>
      <button type="button" className="stepperValue" disabled={reset == null || value === reset}
        title={reset != null ? "Reset to default" : undefined}
        onClick={() => reset != null && onChange(reset)}>{format ? format(value) : value}</button>
      <button type="button" className="uiBtn sm iconSq" aria-label="Larger"
        disabled={value >= max} onClick={() => onChange(clamp(value + step))}>+</button>
      {reset != null ? <button type="button" className="uiBtn sm" disabled={value === reset}
        onClick={() => onChange(reset)}>Reset</button> : null}
    </span>
  );
}

// Character budgets span 100 … 1 000 000, so the slider is log-scaled and snaps
// to round numbers; the box next to it still accepts any exact value. The max
// matches the backend's request-model ceiling (READ_CHARS_MAX in
// gamma/ai_tools.py) — keep the two in sync.
const SLIDER_MIN = 100, SLIDER_MAX = 1000000, SLIDER_SPAN = Math.log(SLIDER_MAX / SLIDER_MIN);
const toSlider = (v) => Math.round((1000 * Math.log(Math.max(SLIDER_MIN, v) / SLIDER_MIN)) / SLIDER_SPAN);
const fromSlider = (s) => {
  const raw = SLIDER_MIN * Math.exp((s / 1000) * SLIDER_SPAN);
  const step = raw < 10000 ? 100 : raw < 100000 ? 1000 : 10000;
  return Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(raw / step) * step));
};

// The number box commits on blur/Enter, not per keystroke — the range clamp
// must not fight half-typed values (typing "20000" would snap to 100 at "2").
// The slider stays live; grabbing it blurs the box, committing any draft first.
export function CharSlider({ value, onChange }) {
  const [draft, setDraft] = React.useState(null); // non-null only while the box is being edited
  const commit = () => {
    if (draft == null) return;
    const next = Number.parseInt(draft, 10);
    if (Number.isFinite(next)) onChange(Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, next)));
    setDraft(null);
  };
  return (
    <span className="setSlider">
      <input
        type="range" min="0" max="1000" step="1" className="setRange"
        value={toSlider(value)}
        onChange={(event) => onChange(fromSlider(Number(event.target.value)))}
      />
      <input
        className="aiKeyInput setNum" type="number" min={SLIDER_MIN} max={SLIDER_MAX} step="1000"
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </span>
  );
}

// ~1800 characters is about one dense page of a paper — enough to make an
// abstract character budget mean something.
export const approxPages = (chars) => `≈ ${Math.max(1, Math.round(chars / 1800))} page${chars >= 2700 ? "s" : ""}`;

// Coverage tile: big count, what it counts, and how far along it is.
export function Stat({ icon: Icon, label, value, total, title }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  const tone = pct >= 100 ? "ok" : pct < 60 ? "warn" : "";
  return (
    <div className="setStat" title={title}>
      <span className="setStatTop">
        <span className="setStatNum">{value}</span>
        <span className="setStatOf">/ {total}</span>
      </span>
      <span className="setStatLabel"><Icon size={12} />{label}</span>
      <span className="setStatBar"><i className={tone} style={{ width: `${Math.max(pct, 2)}%` }} /></span>
    </div>
  );
}

// Newest-first log list with a Copy button — one rendering for the session
// log (Advanced) and the admin server log (Server). Entries are normalized
// to {key, timeMs, text}.
export function LogBox({ icon, label, description, entries, emptyText, copyStatus, setStatus }) {
  function copy() {
    const text = entries
      .map((entry) => `${new Date(entry.timeMs).toLocaleTimeString([], { hour12: false })} ${entry.text}`)
      .join("\n");
    copyText(text).then((ok) => setStatus(ok ? copyStatus : "Copy failed—copy manually."));
  }
  return (
    <>
      <Row icon={icon} label={label} hint={description}>
        <button className="uiBtn sm" disabled={!entries.length} onClick={copy}>Copy</button>
      </Row>
      <div className="sysLogBox">
        {entries.length ? [...entries].reverse().map((entry) => (
          <div key={entry.key} className="sysLogRow">
            <span className="sysLogTime">{new Date(entry.timeMs).toLocaleTimeString([], { hour12: false })}</span>
            <span className="sysLogMsg">{entry.text}</span>
          </div>
        )) : <div className="sysLogEmpty">{emptyText}</div>}
      </div>
    </>
  );
}

export function Empty({ icon: Icon, children }) {
  return <div className="setEmpty"><Icon size={26} />{children}</div>;
}

// Notion-style people picker: a search box over the account directory with
// the matches listed beneath as selectable rows (avatar · name · admin tag).
// `accounts` is the directory (null while loading), `exclude` the usernames
// already in (members, the owner); `value` is the picked username and
// `onChange` receives it (or "" again when the text no longer names one).
// Typing filters; Enter picks the first match; ↑/↓ move the highlight.
// `compact` keeps the list closed until the box is focused or has text —
// for a popover, where an always-open list would crowd the rest.
export function AccountPicker({ accounts, exclude = [], value, onChange, placeholder, autoFocus, compact }) {
  const [query, setQuery] = React.useState(value || "");
  const [cursor, setCursor] = React.useState(0);
  const [focused, setFocused] = React.useState(false);
  const skip = new Set(exclude);
  const q = query.trim().toLowerCase();
  const matches = (accounts || []).filter((a) => !skip.has(a.username) && (!q || a.username.toLowerCase().includes(q)));
  const shown = matches.slice(0, 8);
  const open = !compact || focused || !!q;

  function pick(name) {
    setQuery(name);
    onChange(name);
    setCursor(0);
  }
  function type(text) {
    setQuery(text);
    setCursor(0);
    // the text may spell an account exactly — that counts as picking it
    const exact = matches.find((a) => a.username === text.trim());
    onChange(exact ? exact.username : "");
  }
  function onKeyDown(event) {
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((c) => Math.min(c + 1, shown.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (event.key === "Enter" && shown[cursor] && shown[cursor].username !== value) { event.preventDefault(); pick(shown[cursor].username); }
  }

  return (
    <span className="setPick">
      <input
        className="aiKeyInput" type="text" spellCheck={false} autoComplete="off" autoFocus={autoFocus}
        placeholder={placeholder || "Search accounts…"} value={query}
        onChange={(event) => type(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)} // let a click on a row land first
        aria-label={placeholder || "Search accounts"}
      />
      {open ? (
        <span className="setPickList" role="listbox">
          {accounts == null ? <span className="setPickEmpty">Loading accounts…</span> : null}
          {accounts != null && !shown.length ? (
            <span className="setPickEmpty">{q ? `No account matches "${query.trim()}"` : "No other accounts"}</span>
          ) : null}
          {shown.map((a, i) => (
            <button
              key={a.username} type="button" role="option" aria-selected={a.username === value}
              className={`setPickItem ${a.username === value ? "picked" : ""} ${i === cursor ? "cursor" : ""}`}
              onMouseDown={(event) => event.preventDefault()} // keep the box focused
              onClick={() => pick(a.username)}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="setPickAvatar">{a.is_admin ? <ShieldIcon size={13} /> : <UserIcon size={13} />}</span>
              <span className="setPickName">{a.username}</span>
              {a.is_admin ? <span className="uiTag admin">admin</span> : null}
              {a.username === value ? <CheckIcon size={13} className="setPickCheck" /> : null}
            </button>
          ))}
          {matches.length > shown.length ? (
            <span className="setPickEmpty">{matches.length - shown.length} more — keep typing</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

// Cloud-drive-style storage meter: thin bar + "used of total" caption.
// quotaMb 0/undefined = unlimited → caption only, no bar (no denominator).
// barOnly renders just the bar (the account popover puts the numbers next to
// the user card instead). Shared by the popover, Users pane, Library.
export function QuotaMeter({ usedBytes, quotaMb, barOnly }) {
  if (usedBytes == null) return null;
  const quotaBytes = (quotaMb || 0) * 1024 * 1024;
  const pct = quotaBytes ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;
  const state = pct >= 95 ? " full" : pct >= 80 ? " warn" : "";
  return (
    <span className="quotaMeter">
      {quotaBytes ? (
        <span className="quotaBar">
          <span className={`quotaBarFill${state}`} style={{ width: `${usedBytes ? Math.max(pct, 2) : 0}%` }} />
        </span>
      ) : null}
      {barOnly ? null : (
        <span className="settingDesc">
          {quotaBytes
            ? `${fmtBytes(usedBytes)} of ${fmtBytes(quotaBytes)} used (${Math.round(pct)}%)`
            : `${fmtBytes(usedBytes)} used — no quota`}
        </span>
      )}
    </span>
  );
}

// Percentage-only variant of QuotaMeter. It deliberately shares the exact
// quotaMeter/quotaBar markup and warning thresholds so provider allowance and
// storage quota read as the same kind of capacity indicator.
export function PercentMeter({ percent, barOnly, caption = "" }) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return null;
  const pct = Math.max(0, Math.min(100, value));
  const state = pct >= 95 ? " full" : pct >= 80 ? " warn" : "";
  return (
    <span className="quotaMeter">
      <span className="quotaBar">
        <span className={`quotaBarFill${state}`} style={{ width: `${pct ? Math.max(pct, 2) : 0}%` }} />
      </span>
      {barOnly ? null : <span className="settingDesc">{caption || `${Math.round(pct)}% used`}</span>}
    </span>
  );
}
