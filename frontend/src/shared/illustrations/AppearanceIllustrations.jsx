import React from "react";

// Small, abstract reading scenes: the same shapes make palettes easy to compare.
// `dark` is the Dark row of the same table, for the System card's right half.
export function ThemePreview({ theme, dark }) {
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
      {id === "system" && dark ? <g clipPath={`url(#${clipId})`}>
        <rect width="180" height="72" fill={dark[3]} />
        <rect x="19" y="14" width="142" height="64" rx="5" fill={dark[4]} />
        <g stroke={dark[5]} strokeWidth="3" strokeLinecap="round" opacity=".3">
          <path d="M61 49h38M61 56h49M61 63h32" />
        </g>
        <path d="M61 29h35" stroke={dark[5]} strokeWidth="4" strokeLinecap="round" opacity=".8" />
        <circle cx="134" cy="37" r="12" fill={dark[6]} opacity=".3" />
        <path d="M119 56l13-19 16 19z" fill={dark[6]} opacity=".6" />
      </g> : null}
    </svg>
  );
}

export function PdfPreview({ dark }) {
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

