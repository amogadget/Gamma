# LaTeX editing

These aids apply inside `$...$` and `$$...$$` in notes and editable embedded
notes. Ordinary prose and fenced code retain their usual typing behavior.

| Type | Result / action |
| --- | --- |
| `\left(` | Inserts `\right)` and leaves the caret between them |
| `\left[` or `\left\{` | Inserts `\right]` or `\right\}` |
| `\left|` or `\left\lVert` | Pairs absolute-value or norm delimiters |
| `\left\langle`, `\left\lfloor`, `\left\lceil` | Pairs angle, floor, or ceiling delimiters |
| `\frac` + Tab | `\frac{}{}`; Tab moves from numerator to denominator |
| `\sum`, `\prod`, `\int`, `\oint` + Tab | Adds lower/upper limit slots: `_{...}^{...}` |
| `\lim` + Tab | Adds a subscript slot |
| `\abs` or `\norm` + Tab | Inserts scalable absolute-value or norm delimiters |
| `\sqrt`, `\ket`, `\bra`, `\braket` + Tab | Inserts the command and its argument slot |
| `\begin{` + an environment prefix + Tab | Inserts matching begin/end; display math uses multiple lines |
| Tab / Shift+Tab | Moves forward / backward between argument slots; Tab also skips a `\right` delimiter or leaves the math span |
| Backspace inside an empty `\left...\right` pair | Removes the whole pair |

Command completion also accepts Enter. Typing a closing `)`, `]`, `}`, or `|`
immediately before the corresponding `\right` skips the existing closer.
Use Tab to exit named delimiters such as `\right\rangle`. Nested pairs get
separate closers. Pasting text does not trigger character-by-character pairing.

The live preview and completion list render in the document body to escape
panel clipping. Their measured positions are clamped on both axes to the
visible viewport and refreshed after scrolling, resizing, or font/layout changes.
Long and tall equations scroll within the preview; clicking it retains editor
focus. The preview is capped at 720 px wide and 45% of the window height.

Implementation: `editor/latexInput.js` contains delimiter edits and the shared
`escapedAt` check. `editor/BlockCmEditor.jsx` applies
delimiter edits as atomic CodeMirror transactions. `editor/LatexEditor.jsx` contains
the command catalog, completion edits, Tab navigation and preview positioning.

Validation (from `frontend`):

```sh
node --test tests/latexInput.test.mjs
node tests/e2e/latexEditor.mjs
```

The browser regression (`tests/e2e/latexEditor.mjs`) bundles the real note
editor with esbuild over an in-memory fixture; it needs installed Playwright
Chromium, but no backend or AI provider, and is not part of `npm run e2e`.

The delimiter pairing follows Overleaf's scalable-delimiter matching, the
argument snippets and Tab-out navigation Obsidian's LaTeX Suite; snippets are
inserted only through explicit command completion, never by rewriting typed
variable names.
