# UI illustrations

Keep decorative examples for settings and dialogs here, organized by subject.
Import them through `index.js`.

| File | Purpose |
| --- | --- |
| `AppearanceIllustrations.jsx` | Theme palettes and PDF color sample |
| `TransferPreview.jsx` | Live import/export examples driven by the selected options |
| `FormatIllustration.jsx` | App marks for app formats; shared PDF, notes and Markdown icons for document formats |
| `brands/` | Local app icons and their source/license notes |
| `library-page.svg` | Static sample thumbnail for the real library `PageCard` |
| `illustrations.css` | Illustration-specific drawing and color rules |

Use React for illustrations whose parts change with controls; accept their
state through props. Use standalone SVG files for fixed drawings. These are
hand-coded examples, not renders of the user's documents.

Keep actual widgets, interaction handlers and surrounding layout in their
existing components. Reuse `icons.jsx`, `PageCard`, `Toggle` and other shared
widgets instead of maintaining lookalike copies here. Add a small focused file
when a new subject needs an illustration, rather than growing one large module.

Use recognizable app logos for app formats, and the shared document icons for
PDF, notes and Markdown. Keep their size and monochrome treatment consistent
with the interface; do not replace familiar marks with conceptual drawings. Format capabilities
and navigation rules live in `../transferFormats.js`, separate from the drawings.
