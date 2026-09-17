---
name: cleanup
description: Clean up the code and docs of recent commits — unify scattered logic, conform UI to the shared design, cut over-engineering and dead code, plain-prose the docs, and list what was left unfinished. Behavior-preserving; never commits.
---

# Cleanup of recent commits

A cleaning pass over work that already landed on the branch. The output is
a tidier tree plus a short report. It is NOT a bug hunt (`/code-review`)
and NOT a restyle: the goal is that the new code looks like it was written
by the same careful person who wrote the rest of the repo.

Rules that hold throughout:

- **Behavior-preserving.** Refactor, dedupe, delete dead things, reword
  docs. Anything that changes what the user sees or what an endpoint
  returns is a *proposal* in the report, not an edit.
- **Never commit.** Leave the changes in the working tree.
- **Don't touch unrelated dirty files.** Other sessions may be editing the
  same tree. Only edit files that the scoped commits touched, plus files a
  fix genuinely has to reach (a shared helper, a doc).
- **Conform, don't invent.** When code needs a control, class, helper, or
  doc section, use the one the repo already has. Never introduce a new
  style or abstraction to fix an old one.

## Step 1 — scope

Argument forms (`/cleanup <arg>`):

| arg          | scope                                              |
|--------------|----------------------------------------------------|
| *(none)*     | commits on this branch not on `main` (`main..HEAD`); if that is empty, the last 5 commits; if it is more than ~15 commits, the commits since the newest one whose message contains "cleanup" (long-lived `dev` accumulates) |
| `N`          | the last N commits (`HEAD~N..HEAD`)                |
| `<a>..<b>`   | that range                                         |
| `tree`       | uncommitted changes only (`git diff HEAD`)         |

```bash
git log --oneline main..HEAD          # or the chosen range
git diff --stat <range>
git diff <range>                       # read all of it; it is the input
```

Read the diff in full before judging anything. Note every file touched and
which `docs/dev/*.md` covers each area (the map is in `CLAUDE.md`); read
those docs too — they define what "the existing way" is.

## Step 2 — the five checks

Work through all five and collect findings first. Then fix in Step 3.
Each finding is a line: `file:line — what — fix / proposal`.

### 1. Scattered or duplicated logic

- The same computation or rule in two places (two components, backend +
  frontend, two routers). Move it into one helper and call it from both.
  Exception: mirrors the docs declare on purpose (`textnorm.py` ↔
  `search/SearchPanel.jsx`/`pdf/PdfViewer.jsx`, `foldertags.py` ↔ `library/libraryUtils.js`) —
  those stay mirrored but must actually match.
- A feature spread across App.jsx state + a component + a util when one
  module would own it whole. Prefer the module the file map in CLAUDE.md
  already assigns to that concern.
- New helpers that duplicate an existing one under another name
  (`grep -rn "def <name>\|function <name>\|const <name>"` before keeping
  a new one).
- Copy-pasted branches that differ by one value — parameterize.

### 2. UI cleanliness

Reference: [docs/dev/ui-design.md](../../../docs/dev/ui-design.md) and
[docs/dev/settings.md](../../../docs/dev/settings.md).

- Controls use the unified classes (`uiBtn`, `uiClose`, `ctlBtn`,
  `aiKeyInput`, …) and settings panes use only `settingsKit` primitives
  with `MenuSelect`/`ActionMenu` for choices. A bespoke `<button style=…>`
  or a one-off `.myThingBtn` styled like a button is a finding.
- Bespoke CSS classes do layout only. Colors, radii, fonts, shadows come
  from the theme variables; a hard-coded `#hex` or `rgba(` in new CSS is a
  finding unless it is a documented exception.
- Dead CSS: for every selector added in the diff, grep `frontend/src` for
  the class name. No user → delete.
- Dead logic: state that is set but never read, props passed but unused,
  handlers wired to nothing, `useEffect`s whose deps can never change.
- Inline styles that repeat an existing class; `!important`; z-index
  guesses; duplicated media queries.
- Consistency with neighbors: same spacing scale, same icon set, same hover
  affordance pattern as the surrounding component (e.g. mdTools hover
  toolbars, menu rows). "Looks different from the panel next to it" is a
  finding even if it works.
- Do NOT restyle existing panels to a new taste. Cleaning means making the
  new part match the old parts, never the reverse.

### 3. Over-engineering

- Abstractions with one caller (a factory, registry, or base class used
  once). Inline it.
- Options, flags, or config knobs nothing sets. Remove the knob and the
  branch. Repo rule: no new env vars for things a GUI setting or a
  hardcoded default covers.
- Defensive branches for states the types or the caller make impossible.
- Generic utilities built for hypothetical reuse; premature caching or
  memoization without a measured reason; a new dependency where 20 lines
  would do.
- Indirection layers (wrapper → wrapper → impl) that exist only so the
  code "could" be swapped later.
- Backend: new tables or columns nothing reads; endpoints with no frontend
  caller (check `grep -rn "/api/<path>" frontend/src extension`).

### 4. Documentation prose

Applies to `docs/dev/*.md`, `README`, `desktop/docs/*`, and the CLAUDE.md
lines that changed. The docs are reference material for someone who reads
them once and then works; they are not a changelog and not marketing.

Remove or rewrite:

- Praise and filler adjectives: *robust, seamless, elegant, powerful,
  clean, simple, comprehensive, carefully, gracefully, intuitive*.
- Narration of the writing process: "we then decided…", "this was tricky
  because…", "as before", "now", "previously", "no longer". State what IS.
  History belongs in git.
- Throat-clearing: "Note that", "It is worth mentioning", "Importantly",
  "In order to", "Basically", "Simply".
- Hedged or doubled statements ("essentially the same, more or less").
- Sentences over ~25 words; chains joined by em-dashes or semicolons.
  Split them.
- Bullets that are paragraphs. One or two sentences per bullet.
- Repetition of what the code or CLAUDE.md already says nearby.
- Headings that announce sections nobody needs ("Overview", "Summary",
  "Conclusion").

Keep: exact names (files, functions, flags, endpoints), the reason behind
a non-obvious decision (one sentence), invariants, gotchas.

Also check the docs are TRUE after the commits: every file, function,
endpoint, and setting a doc names must exist (`grep`), and every new
endpoint, setting, tool, or file the diff adds must appear in the doc that
covers its area (api.md, settings.md, ai_tools.md, ui-design.md's file
map, …).

### 5. Unfinished work

Signals, in rough order of reliability:

- `TODO`, `FIXME`, `XXX`, `HACK`, `WIP`, `later`, `for now` added by the
  diff (`git diff <range> | grep -n "^+.*\(TODO\|FIXME\|XXX\|HACK\|WIP\|for now\)"`).
- Commit messages with "wip", "part 1", "start", "draft", "todo".
- Commented-out code; `console.log`/`print()` debugging (`logbuf.log` is
  the only backend log surface).
- Stubs: functions that `pass`/`return null`/throw `NotImplemented`;
  handlers that only `preventDefault`; empty `catch`.
- One half of a pair: backend endpoint without a caller, frontend call
  without a route, a setting stored but never read, a pref key in
  `app/prefs.js` with no UI, a migration without a reader.
- Docs describing behavior the code doesn't have yet, or code the docs
  don't mention.
- Tests: a backend change under `gamma/routers` or `gamma/*.py` with no
  test touched — note it (adding a test is in scope when cheap).
- Keyboard shortcuts, menu entries, or settings mentioned in the UI text
  that do nothing.

## Step 3 — apply

Fix everything from checks 1–5 that is behavior-preserving and local.
Order: delete dead things → dedupe → simplify → conform UI → rewrite docs.

- Keep each edit minimal. A cleanup that rewrites a file wholesale is
  itself a finding.
- When you move logic, update every caller and the doc that names its
  location.
- When you delete a helper, class, endpoint, or setting, grep once more
  for its name across `backend/`, `frontend/src`, `extension/`,
  `desktop/`, and `docs/`.
- Update `docs/dev/*.md` for every structural change you make (the docs
  must describe the tree as it is after the cleanup).

Do NOT apply: anything that changes visible behavior, removes a feature,
changes an API shape, or that you are unsure is dead. Those go in the
report as proposals with a one-line reason.

## Step 4 — verify

```bash
cd backend && venv/Scripts/python.exe -m pytest tests -q
# when frontend/src changed (node is fnm-managed, not on the tool-shell PATH):
export PATH="$HOME/AppData/Roaming/fnm/aliases/default:$PATH"
cd frontend && npm run build
```

Two vector-math tests fail under the conda `python`; use the venv one.
Pre-existing failures that the scoped commits didn't cause are reported,
not fixed. For UI changes beyond class swaps, run the `verify` skill and
look at the result.

## Step 5 — report

One message, structured as:

1. **Scope**: the commits covered.
2. **Applied**: bullets grouped by check (1–5), each `file — what changed`.
3. **Proposals**: behavior-affecting or uncertain items, each with the
   one-line reason it was not applied.
4. **Unfinished**: the check-5 list, as concrete next tasks.
5. **Verification**: test and build results, verbatim on failure.

Do not commit. Do not pad the report with things that were already fine.
