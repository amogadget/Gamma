# LaTeX editing aids: what the editors people already use do

Surveyed September 2026, before extending the block editor's `\command`
completion and re-arranging its live preview. The mechanics that came out of
it are in [docs/dev/latex_editing.md](../dev/latex_editing.md).

## Completion

**VS Code + LaTeX Workshop.** Completion opens on `\` (and `{`, `,`, `}`),
and the candidates are VS Code's own fuzzy-ranked list: a typed prefix wins,
but any query whose letters appear in order in the name still matches, so
`\lra` reaches `\leftrightarrow` and `\mbb` reaches `\mathbb`. Snippets carry
placeholders (`${1:num}`) that Tab walks through. A separate `@` trigger
offers shorthands for math (`@a` → `\alpha`, `@/` → `\frac{}{}`, `@I` →
`\int_{}^{}`) — a second, abbreviation-driven vocabulary next to the
command names.

**Obsidian + LaTeX Suite.** No `\` menu at all: typed text is rewritten by
snippets as you go (`mk` → `$$`, `sq` → `\sqrt{}`, `ooo` → `\infty`,
`xx` → `\times`, `->` → `\to`, `mbb` → `\mathbb{}`), with Tab hopping
between the snippet's slots. Fast for people who learned the table, and a
source of surprises for everyone else (a variable named `xx` becomes
`\times`) — which is why Gamma's earlier design already inserts snippets only
through an explicit completion, never by rewriting typed letters.

**Overleaf.** Prefix completion of commands with the argument braces filled
in as snippet slots; `\left(` pairs its `\right)`.

**What Gamma took.** Prefix and exact matches stay first (the list must not
move when the typed prefix already spells a command). Below them, VS Code's
subsequence match anchored on the first letter (`mbb`, `mcal`, `lra`, `Ra`,
`bsym`, `sbeq`), ranked by how many gaps the match needed and then by name
length, so the fuzzy tail is short and predictable. LaTeX Suite's shorthands
that no subsequence would find (`ooo`, `xx`, `del`, `RR`) are a small
abbreviation table rather than automatic rewrites — still typed after the
backslash, still accepted with Tab/Enter. The catalog was extended from
LaTeX Workshop's snippet list and checked against KaTeX (everything offered
renders; `\multline`, `\cancelto`, `\lcm`, `\sech` do not and were left out).

## The live preview

**LaTeX Workshop** previews the whole math environment on hover, and can
draw a caret marker inside the rendered formula at the editor's cursor
position (`hover.preview.cursor`). **Overleaf** shows a preview strip above
the equation, anchored to the equation rather than the caret. **Obsidian**
renders the equation in place once the caret leaves it.

Gamma's preview had floated at the caret, clamped to the window, which made
it jump as the caret moved through a multi-line `$$` block and let it spill
across the PDF when the notes column was narrow. The new arrangement is
Overleaf's: the tip is docked to the editor column (left edge and width of
the block editor), above the span's first line, below its last line when
there is no room above, and only when both are off screen does it hug the
caret line. LaTeX Workshop's caret marker was adopted: a thin accent bar
typeset at the caret's offset, skipped where an inserted token would break
the parse (inside a `\command` name, an environment name, or an `[...]`
optional argument) and dropped when KaTeX rejects the marked source.
