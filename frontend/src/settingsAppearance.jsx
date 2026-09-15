import React from "react";
import { PaneHead, Section, Row, Toggle, Stepper, PictureChoices } from "./settingsKit";
import { ContrastIcon, LayoutIcon, MaximizeIcon, MoonIcon } from "./icons";
import { UI_SCALE } from "./prefs";

const THEMES = [
  ["system", "System", "Match your device", "#eef0f3", "#ffffff", "#353b45", "#6089bb"],
  ["light", "Light", "Bright & crisp", "#f5f5f5", "#ffffff", "#1a1a1a", "#3a7bd5"],
  ["dark", "Dark", "A quieter backdrop", "#181818", "#292929", "#eeeeee", "#5b9bd5"],
  ["sepia", "Sepia", "Warm paper, deep ink", "#e9e1cb", "#fdf6e3", "#073642", "#1b6fa3"],
  ["solarized", "Solarized Light", "Warm paper, softer ink", "#eee8d5", "#fdf6e3", "#657b83", "#268bd2"],
  ["gray", "Gray", "Soft & neutral", "#e3e3e3", "#f4f4f4", "#2d2d2d", "#3a7bd5"],
];

// Small, abstract reading scenes: the same shapes make palettes easy to compare.
function ThemePreview({ theme }) {
  const [id, , , ground, paper, ink, accent] = theme;
  const clipId = React.useId();
  return (
    <svg className="setPicturePreview" viewBox="0 0 180 72" aria-hidden="true">
      <defs><clipPath id={clipId}><path d="M90 0h90v72H90z" /></clipPath></defs>
      <rect width="180" height="72" fill={ground} />
      <rect x="19" y="14" width="142" height="64" rx="5" fill={paper} />
      <path d="M48 14v64" stroke={ink} opacity=".1" />
      <g stroke={ink} strokeWidth="3" strokeLinecap="round" opacity=".25">
        <path d="M28 25h10M28 34h7M28 43h10M61 49h38M61 56h49M61 63h32" />
      </g>
      <path d="M61 29h35" stroke={ink} strokeWidth="4" strokeLinecap="round" opacity=".8" />
      <path d="M61 38h23" stroke={accent} strokeWidth="4" strokeLinecap="round" opacity=".55" />
      <circle cx="134" cy="37" r="12" fill={accent} opacity=".18" />
      <path d="M119 56l13-19 16 19z" fill={accent} opacity=".48" />
      {id === "system" ? <g clipPath={`url(#${clipId})`}>
        <rect width="180" height="72" fill="#181818" />
        <rect x="19" y="14" width="142" height="64" rx="5" fill="#292929" />
        <g stroke="#eee" strokeWidth="3" strokeLinecap="round" opacity=".3">
          <path d="M61 49h38M61 56h49M61 63h32" />
        </g>
        <path d="M61 29h35" stroke="#eee" strokeWidth="4" strokeLinecap="round" opacity=".8" />
        <circle cx="134" cy="37" r="12" fill="#5b9bd5" opacity=".3" />
        <path d="M119 56l13-19 16 19z" fill="#5b9bd5" opacity=".6" />
      </g> : null}
    </svg>
  );
}

function PdfPreview({ dark }) {
  return (
    <svg className={`appearancePdfPreview${dark ? " isDark" : ""}`} viewBox="0 0 64 78" aria-hidden="true">
      <rect className="appearancePdfPaper" x="1" y="1" width="62" height="76" rx="4" />
      <g fill="currentColor">
        <rect x="11" y="13" width="29" height="3" rx="1.5" />
        <rect x="11" y="21" width="41" height="2" rx="1" opacity=".35" />
        <rect x="11" y="27" width="35" height="2" rx="1" opacity=".35" />
        <circle cx="25" cy="45" r="9" opacity=".12" />
        <path d="M22 54l11-17 12 17z" opacity=".4" />
        <rect x="11" y="62" width="41" height="2" rx="1" opacity=".35" />
        <rect x="11" y="68" width="27" height="2" rx="1" opacity=".35" />
      </g>
    </svg>
  );
}

export function AppearanceSettings({ value, diagnostics }) {
  return (
    <div className="appearanceSettings">
      <PaneHead icon={ContrastIcon} title="Appearance">
        A comfortable space to read and think. Changes apply as you choose.
      </PaneHead>

      <Section title="Theme" action={<span className="appearanceScope">Your account</span>}>
        <p className="appearanceHint">Choose the colors around your work.</p>
        <PictureChoices label="Theme" value={value.theme} onChange={value.setTheme}
          options={THEMES.map((theme) => ({ value: theme[0], label: theme[1], hint: theme[2], preview: <ThemePreview theme={theme} /> }))} />
        <p className="appearanceFootnote">Sepia, Solarized Light and Gray also tint PDF pages and soften ink.</p>
      </Section>

      <Section title="PDF pages" action={<span className="appearanceScope">Your account</span>}>
        <div className="appearancePdf">
          <PdfPreview dark={value.pdfDarkPage} />
          <div className="appearancePdfControls">
            <Toggle icon={MoonIcon} label="Dark PDF pages"
              hint="Light text on a dark page, with any theme."
              checked={value.pdfDarkPage} onChange={value.setPdfDarkPage} />
            <p className="appearanceFootnote">Photos and figures invert too. Your files and exports keep their original colors.</p>
          </div>
        </div>
      </Section>

      <Section title="Interface" action={<span className="appearanceScope">This browser</span>}>
        <div className="appearanceInterface">
          <Row icon={MaximizeIcon} label="Control size" hint="Make buttons, icons and switches smaller or larger.">
            <Stepper value={value.uiScale} onChange={value.setUiScale}
              min={UI_SCALE.min} max={UI_SCALE.max} step={UI_SCALE.step} reset={UI_SCALE.default}
              format={(v) => `${Math.round(v * 100)}%`} />
          </Row>
          <Toggle icon={LayoutIcon} label="Status bar" hint="Show the latest activity below your tabs."
            checked={diagnostics.statusBarVisible} onChange={diagnostics.setStatusBarVisible} />
        </div>
        <p className="appearanceFootnote">To resize notes or chat text, hold Ctrl (⌘ on Mac) and scroll over that panel.</p>
      </Section>
    </div>
  );
}
