// The building blocks every settings pane is composed from — and nothing
// else: PaneHead › Section › Row/Toggle for the panes themselves, SubDialog ›
// Step/Field for the editor dialogs they open, plus the small shared controls
// (Segmented, UnitInput, CharSlider, Stat, Empty, QuotaMeter). New settings
// UI should reuse these; bespoke classes are for layout only.
import React from "react";
import { fmtBytes } from "./utils";

export function PaneHead({ icon: Icon, title, children }) {
  return (
    <div className="setHead">
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
      <div className="setSection">
        <span className="setSectionLabel">{title}</span>
        <span className="setSectionRule" />
        {action}
      </div>
      {children}
    </>
  );
}

// `title` is the long explanation — deliberately not rendered, only hovered.
// Rows are plain containers: the control on the right is the only click target,
// so a stray click on the label or hint never flips a setting.
export function Row({ icon: Icon, label, hint, title, children }) {
  return (
    <div className="settingRow setRow" title={title}>
      <span className="setIcon">{Icon ? <Icon size={15} /> : null}</span>
      <span className="settingText">
        <span className="settingLabel">{label}</span>
        {hint ? <span className="settingDesc">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

export function Toggle({ checked, onChange, label, ...row }) {
  return (
    <Row label={label} {...row}>
      <span className="switch">
        <input
          type="checkbox" checked={checked} aria-label={label}
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
          className={`uiBtn sm ${value === val ? "on" : ""}`}
          onClick={() => onChange(val)}
        >
          {Icon ? <Icon size={13} /> : null}{label}
        </button>
      ))}
    </span>
  );
}

// Centered popup dialog opened from inside the settings modal — same shape as
// the PDF export dialog (reportModal), stacked above the settings overlay.
// Every editor dialog is composed the same way: SubDialog › .settingsForm ›
// Step (numbered stages, for flows) or Field (label + hint + one control),
// closed by a .reportModalBtns footer.
export function SubDialog({ title, onClose, children }) {
  return (
    <div className="reportOverlay subDialog" onClick={onClose}>
      <div className="reportModal" onClick={(event) => event.stopPropagation()}>
        <div className="reportModalTitle">{title}</div>
        {children}
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

// Number input with a fixed unit suffix, so "MB" never has to live in the
// label text. Empty string means "inherit" wherever the caller says so.
export function UnitInput({ value, onChange, unit, placeholder, min, onEnter }) {
  return (
    <span className="unitInput">
      <input
        className="aiKeyInput" type="number" min={min}
        placeholder={placeholder} value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onEnter ? (event) => { if (event.key === "Enter") onEnter(); } : undefined}
      />
      <span className="unitSuffix">{unit}</span>
    </span>
  );
}

// Character budgets span 100 … 1 000 000, so the slider is log-scaled and snaps
// to round numbers; the box next to it still accepts any exact value.
const SLIDER_MIN = 100, SLIDER_MAX = 1000000, SLIDER_SPAN = Math.log(SLIDER_MAX / SLIDER_MIN);
const toSlider = (v) => Math.round((1000 * Math.log(Math.max(SLIDER_MIN, v) / SLIDER_MIN)) / SLIDER_SPAN);
const fromSlider = (s) => {
  const raw = SLIDER_MIN * Math.exp((s / 1000) * SLIDER_SPAN);
  const step = raw < 10000 ? 100 : raw < 100000 ? 1000 : 10000;
  return Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(raw / step) * step));
};

export function CharSlider({ value, onChange }) {
  return (
    <span className="setSlider">
      <input
        type="range" min="0" max="1000" step="1" className="setRange"
        value={toSlider(value)}
        onChange={(event) => onChange(fromSlider(Number(event.target.value)))}
      />
      <input
        className="aiKeyInput setNum" type="number" min={SLIDER_MIN} max={SLIDER_MAX} step="1000"
        value={value}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(next)) onChange(Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, next)));
        }}
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

export function Empty({ icon: Icon, children }) {
  return <div className="setEmpty"><Icon size={26} />{children}</div>;
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
