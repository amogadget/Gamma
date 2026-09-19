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
`escapedAt` check (also exported by `editor/LatexEditor.jsx`). `editor/BlockCmEditor.jsx` applies
delimiter edits as atomic CodeMirror transactions. `editor/LatexEditor.jsx` contains
the command catalog, completion edits, Tab navigation and preview positioning.

Validation (from `frontend`):

```sh
node --test tests/latexInput.test.mjs
node tests/e2e/latexEditor.mjs
```

The browser regression uses the real note editor with an isolated in-memory
fixture; it needs installed Playwright Chromium, but no backend or AI provider.

References consulted for the interaction design:

- [Overleaf: Brackets and Parentheses](https://www.overleaf.com/learn/latex/Brackets_and_Parentheses): matching scalable delimiters.
- [Obsidian LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite): argument snippets, Tab-out navigation and equation previews. Gamma uses explicit command completion for the added snippets rather than automatically rewriting variable names.
