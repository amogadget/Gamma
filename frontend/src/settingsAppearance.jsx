import React from "react";
import { PaneHead, Section, Row, Toggle, Stepper, PictureChoices } from "./settingsKit";
import { ContrastIcon, LayoutIcon, MaximizeIcon, MoonIcon } from "./icons";
import { ThemePreview, PdfPreview } from "./illustrations";
import { UI_SCALE } from "./prefs";

const THEMES = [
  ["system", "System", "Match your device", "#eef0f3", "#ffffff", "#353b45", "#6089bb"],
  ["light", "Light", "Bright & crisp", "#f5f5f5", "#ffffff", "#1a1a1a", "#3a7bd5"],
  ["dark", "Dark", "A quieter backdrop", "#181818", "#292929", "#eeeeee", "#5b9bd5"],
  ["sepia", "Sepia", "Warm paper, deep ink", "#e9e1cb", "#fdf6e3", "#073642", "#1b6fa3"],
  ["solarized", "Solarized Light", "Warm paper, softer ink", "#eee8d5", "#fdf6e3", "#657b83", "#268bd2"],
  ["gray", "Gray", "Soft & neutral", "#e3e3e3", "#f4f4f4", "#2d2d2d", "#3a7bd5"],
];

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
