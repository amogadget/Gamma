// Icons for the shell's chrome. Same stroke style as frontend/src/icons.jsx,
// so the bar and the launcher do not look like a different program than the
// app underneath them.

const ICONS = {
  // The Gamma mark: a Fabry–Pérot cavity around a Γ. Matches assets/icon.svg.
  mark: `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="32" height="32" rx="7" fill="#1e1e1c"/>
    <path d="M 6 16 C 9 10.5 13 10.5 16 16 C 19 21.5 23 21.5 26 16" stroke="#e8a020" stroke-width="1.1" fill="none" opacity="0.6" stroke-linecap="round"/>
    <path d="M 6 16 C 9 21.5 13 21.5 16 16 C 19 10.5 23 10.5 26 16" stroke="#e8a020" stroke-width="1.1" fill="none" opacity="0.6" stroke-linecap="round"/>
    <path d="M 6 4 Q 2 16 6 28" stroke="#e8a020" stroke-width="2.6" fill="none" stroke-linecap="round" opacity="0.88"/>
    <path d="M 26 4 Q 30 16 26 28" stroke="#e8a020" stroke-width="2.6" fill="none" stroke-linecap="round" opacity="0.88"/>
    <rect x="9" y="8" width="14" height="3" rx="0.8" fill="#eeebe4"/>
    <rect x="9" y="8" width="3" height="16" rx="0.8" fill="#eeebe4"/>
  </svg>`,

  stroke: (d) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">${d}</svg>`,
};

// A local library: a stack of disks.
ICONS.local = ICONS.stroke(
  '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>',
);
// A server somewhere else: a globe.
ICONS.remote = ICONS.stroke(
  '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
);
ICONS.grid = ICONS.stroke(
  '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
);
ICONS.check = ICONS.stroke('<path d="M20 6 9 17l-5-5"/>');
ICONS.chevron = ICONS.stroke('<path d="m6 9 6 6 6-6"/>');
ICONS.plus = ICONS.stroke('<path d="M12 5v14"/><path d="M5 12h14"/>');
ICONS.reload = ICONS.stroke('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>');
ICONS.folder = ICONS.stroke(
  '<path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
);
ICONS.log = ICONS.stroke(
  '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
);
ICONS.pencil = ICONS.stroke('<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14 6l4 4"/>');
ICONS.trash = ICONS.stroke(
  '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
);
