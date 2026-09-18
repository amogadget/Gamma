import React from "react";
import { PaneHead, Section, Row, Toggle, Stepper, PictureChoices } from "./SettingsKit";
import { ContrastIcon, LayoutIcon, MaximizeIcon, MoonIcon } from "../shared/ui/Icons";
import { ThemePreview, PdfPreview } from "../shared/illustrations";
import { UI_SCALE } from "../app/prefs";

const THEMES = [
  ["system", "System", "Match your device", "#eef0f3", "#ffffff", "#353b45", "#6089bb"],
  ["light", "Light", "Bright & crisp", "#f5f5f5", "#ffffff", "#1a1a1a", "#3a7bd5"],
  ["dark", "Dark", "A quieter backdrop", "#181818", "#292929", "#eeeeee", "#5b9bd5"],
  ["gamma-light", "Gamma Light", "Warm gray & amber", "#e7e5de", "#efeee9", "#292822", "#92620e"],
  ["gamma-dark", "Gamma Dark", "Charcoal & soft gold", "#1b1b1a", "#272725", "#f0ede6", "#e8b451"],
  ["sepia", "Sepia", "Warm paper, deep ink", "#e9e1cb", "#fdf6e3", "#073642", "#1b6fa3"],
  ["solarized", "Solarized Light", "Warm paper, softer ink", "#eee8d5", "#fdf6e3", "#657b83", "#268bd2"],
  ["gray", "Gray", "Soft & neutral", "#e3e3e3", "#f4f4f4", "#2d2d2d", "#3a7bd5"],
];
const DARK = THEMES.find((theme) => theme[0] === "dark");

export function AppearanceSettings({ value, diagnostics }) {
  return (
    <div className="appearanceSettings">
      <PaneHead icon={ContrastIcon} title="Appearance">
        A comfortable space to read and think. Changes apply as you choose.
      </PaneHead>

      <Section title="Theme" action={<span className="setScope">Your account</span>}>
        <p className="appearanceHint">Choose the colors around your work.</p>
        <PictureChoices label="Theme" value={value.theme} onChange={value.setTheme}
          options={THEMES.map((theme) => ({ value: theme[0], label: theme[1], hint: theme[2], preview: <ThemePreview theme={theme} dark={DARK} /> }))} />
        <p className="appearanceFootnote">Gamma themes also match PDF pages to the interface. Sepia, Solarized Light and Gray tint PDF pages and soften ink.</p>
      </Section>

      <Section title="PDF pages" action={<span className="setScope">Your account</span>}>
        <div className="appearancePdf">
          <PdfPreview dark={value.pdfDarkPage || value.theme === "gamma-dark"} />
          <div className="appearancePdfControls">
            <Toggle icon={MoonIcon} label="Dark PDF pages"
              hint={value.theme === "gamma-dark" ? "Gamma Dark already uses dark pages." : "Light text on a dark page, with any theme."}
              checked={value.pdfDarkPage} onChange={value.setPdfDarkPage} />
            <p className="appearanceFootnote">Photos and figures invert too. Your files and exports keep their original colors.</p>
          </div>
        </div>
      </Section>

      <Section title="Interface" action={<span className="setScope">This browser</span>}>
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
