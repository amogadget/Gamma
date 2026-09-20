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
| `\sqrt[n]`, `\underbrace`, `\overbrace`, `\textcolor`, `\argmax` + Tab | Snippets with several slots: index then radicand, brace then label, color then text |
| `\big(` … `\Bigg\{`, `\middle|`, `\left.` + Tab | Fixed-size delimiter pairs, a growing divider, an invisible left delimiter |
| `\mbb`, `\lra`, `\Ra`, `\ooo`, `\xx`, `\del` + Tab | Fuzzy and abbreviation matches: `\mathbb{}`, `\leftrightarrow`, `\Rightarrow`, `\infty`, `\times`, `\partial` |
| Tab / Shift+Tab | Moves forward / backward between argument slots; Tab also skips a `\right` delimiter or leaves the math span |
| Backspace inside an empty `\left...\right` pair | Removes the whole pair |

Command completion also accepts Enter. The list ranks an exact name first,
then names the typed letters prefix (a bare `\left` puts `\left(` before
`\leftarrow`), then the abbreviation table (`\Ra` is `\Rightarrow`, not
`\rangle`), then case-insensitive prefixes and the `begin`/`big`/`left`
aliases, and last a VS Code-style fuzzy tail: every typed letter must appear
in order in the name, starting with its first letter, ranked by the gaps the
match needed and then by name length (`\mcal` → `\mathcal`, `\bsym` →
`\boldsymbol`, `\sbeq` → `\subseteq`). Typed text is never rewritten on its
own — a snippet only lands through an accepted completion. Every catalog entry
renders in KaTeX (`tests/latexCompletion.test.mjs` pins the ranking and the
snippet shapes). Typing a closing `)`, `]`, `}`, or `|`
immediately before the corresponding `\right` skips the existing closer.
Use Tab to exit named delimiters such as `\right\rangle`. Nested pairs get
separate closers. Pasting text does not trigger character-by-character pairing.

The live preview and completion list render in the document body to escape
panel clipping. The completion list hangs off the caret. The preview is a
strip docked to the editor column — it starts at the block editor's left edge
and is never wider than the editor (or 720 px), so it cannot cover the row
handles or spill across the PDF beside a narrow notes column. It sits above
the math span's first line, so it holds still while the caret moves through a
multi-line `$$` block; when there is no room above it goes below the span's
last line, and when both edges are off screen it hugs the caret's own line.
A thin accent bar in the rendered formula marks the caret position (skipped
inside a `\command` name, an environment name or an `[...]` argument, and
whenever KaTeX would reject the marked source). Positions are clamped to the
visible viewport and refreshed after scrolling, resizing, or font/layout
changes. Long and tall equations scroll within the preview; clicking it
retains editor focus; its height is capped at 45% of the window.

Implementation: `editor/latexInput.js` contains delimiter edits and the shared
`escapedAt` check. `editor/BlockCmEditor.jsx` applies
delimiter edits as atomic CodeMirror transactions. `editor/latexCompletion.js`
(pure, node-testable) holds the command catalog, the matching tiers, snippet
insertion, the math span under the caret and Tab navigation;
`editor/LatexEditor.jsx` re-exports it and holds the preview and popup
components with their placement (`useCaretAnchored`, also used by the "/"
menu). `editor/BlockTree.jsx` computes the preview's docked anchor from the
editor's box and the span's first/last lines.

Validation (from `frontend`):

```sh
node --test tests/latexInput.test.mjs tests/latexCompletion.test.mjs
npm run e2e:latex
```

The browser regression (`tests/e2e/latexEditor.mjs`) bundles the real note
editor with esbuild over an in-memory fixture; it needs installed Playwright
Chromium, but no backend or AI provider, and is not part of `npm run e2e`.

The delimiter pairing follows Overleaf's scalable-delimiter matching, the
argument snippets and Tab-out navigation Obsidian's LaTeX Suite, the fuzzy
ranking VS Code's and the caret marker LaTeX Workshop's hover preview
([research notes](../research/latex-editing.md)); snippets are inserted only
through explicit command completion, never by rewriting typed variable names.
