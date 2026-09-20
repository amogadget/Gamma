# Onboarding: tours and contextual guides

**Status: the engine, first-run tour and AI chat guide
are built.** The welcome page, synced `onboarding` pref, first-sign-in
invitation, checklist and standalone hints are still design.
What exists: `frontend/src/guide/` (registry,
event bus, `useGuide`, `GuideOverlay`, `tours/firstRun.js`), six `data-guide`
anchors in the topbar, one `popover.opened` emit point in App, the node test
`tests/guide.test.mjs` and the e2e step `scenarios/guide.mjs`. A tour starts
only from the account menu's **Tours** submenu; the first
tour is a welcome card, the add-a-paper demo, then the user's own highlight
on that paper, a typed note demonstration, an `llm` label demonstration, and a final spotlight
on the Home button. Returning to the library emits `home.opened`, shows Done,
and completes the tour automatically; Finish can also close it. Progress is a localStorage key
(`gamma-guide:<tourId>`), not yet the synced pref. The seeded welcome page in
`gamma/seed.py` is unchanged (guest workspaces only, hard-coded block tuples).

## Manual tours (implemented)

The account menu's **Tours** submenu lists **Your first paper** and **AI chat**.
Chat focus, page load, and `?guide=` URLs never start or offer a tour. The chat
header has no guide button. Cards use short titles, without body paragraphs.

AI chat starts in the message box and types `summarize the paper for me`, then
points to voice input. Existing drafts are restored after the example; an
empty composer keeps the example ready to edit. The tour never submits a
message or starts recording. If the current page carries a PDF and its window
is visible, it demonstrates Ctrl-drag and points to the resulting image in
chat context. Hidden PDFs, notes pages, and phone chat omit those steps.

The paper tour frames the actual attention equation, types a note through
CodeMirror without replacing existing writing, adds the `llm` label through
the normal label field, and ends at Home. Successful user actions briefly
show Done before advancing automatically.

## Demo steps

A step with `do: [...]` acts on the UI itself instead of asking the user to.
The first tour's second step clicks Add, types the arXiv link of *Attention
Is All You Need*, presses Enter, waits for the page to open and moves on; the
user's first task is then a highlight on a real paper rather than a menu.
If the link identifies a paper with a PDF already in the library, Add opens
that saved copy without resolving or downloading the source again. Reopening
the current paper also emits `page.opened`, so replaying the tour completes.

Before the user's highlight step, `{previewHighlight: true}` demonstrates a
drag across visible, rendered PDF text and points to the real colour palette.
It clears its temporary selection on completion or dismissal, never saving a
highlight or note. It waits for text to render, skips after 15 seconds on a
scan without selectable text, and respects reduced motion. The text-layer
and colour anchors may repeat; the preview chooses a visible passage and the
first colour. The user's own highlight is still what completes the next step.
For the demo paper it prefers the abstract sentence beginning “We propose a
new simple network architecture”, matching across text spans and line breaks
and scrolling the passage into view. Other papers use a visible passage.

The next demo, `{previewArea: true}`, uses the PDF's real Ctrl+pointer-drag
handler to draw a rectangle, with a Ctrl badge beside the animated cursor.
It cancels the drag before release, so it creates no snapshot or annotation.
The user then draws their own rectangle and chooses a colour. The
`highlight.created` event carries `kind: "text" | "area"`, so each practice
step completes only for its matching type.

- Actions: `{click: anchor}`, `{type: anchor, text, speed?}`,
  `{press: "Enter", on?: anchor}`, `{waitFor: {event, match?}, timeout?}`,
  `{wait: ms}`. Click and type move the spotlight and a drawn pointer to the
  element first, pause a beat, then act; typing goes through the native value
  setter plus an `input` event so React-controlled inputs see it; keys are
  dispatched as `KeyboardEvent`s (the engine's own hotkeys ignore untrusted
  events). Events that fire during the step are buffered, so a `waitFor` after
  a fast action still catches its result.
- `{name}` in typed text is filled from the tour's `vars`, which the
  localStorage key `gamma-guide-vars` overrides — how the browser suite points
  the demo at an uploaded PDF instead of the network.
- From the demo's initial pause through its final action, the sheet swallows
  clicks, the card shows "watch", and Back/Next are hidden. Arrow and Enter
  navigation is paused too; the close button and Esc still leave the tour.
  After the actions, a step without `advanceOn` advances by itself, one with
  it hands over to the user. A failed action (anchor never appeared, event
  timed out) leaves the card up with "couldn't finish" and Skip; the tour is
  never stuck.
- `placement` on a step names the card's preferred side so it does not cover
  what the demo is about to open (the Add step sits to the left of the
  button; its popover opens below).

The survey behind these choices is [docs/research/onboarding.md](../research/onboarding.md).

## Goals

1. A new account reaches the "aha" (a highlight that became a note block under
   an open paper) in under two minutes without reading docs.
2. The guide points at the real UI, not at screenshots. What it teaches is
   done in place, and the guide notices when it was done.
3. Moving, renaming or removing a control never silently breaks the guide.
   The failure mode is a named test failure, never a card pointing at nothing.
4. Adding or changing a step is editing data in one file, not React code.
5. Nothing is forced. Every surface is dismissable, everything can be reopened
   from one place, and the share view never shows any of it.

## Three layers

Onboarding is three independent surfaces over one shared engine. Each can be
edited or switched off without the others.

| Layer | What it is | Driven by | Where the content lives |
|---|---|---|---|
| **Welcome page** | A real page in the new workspace ("Welcome to Gamma"), with its own sample PDF attached, so every tour step has something to act on | Seeding | `backend/gamma/onboarding/welcome.md` (imported through the `.md` parser at seed time, not Python tuples) |
| **Tours** | Sequential coach marks: a spotlight on one control plus a card. Task-driven: a step advances when the user does the thing, or on Next | The guide engine | `frontend/src/guide/tours/*.js`, one declarative script per tour |
| **Checklist + hints** | "Getting started" checklist with progress (persists until done or dismissed), plus one-off contextual hints on first contact with a feature | State, not sequence | `frontend/src/guide/checklist.js`, `frontend/src/guide/hints.js` |

The order matters for reconfigurability: content (the welcome page) changes
most often and costs nothing to change; tours change when the UI changes and
are protected by tests; the engine changes rarely.

## Anchors: the contract between UI and guide

The one rule that makes the guide survive UI changes: **the guide never
selects by class name, text or DOM position.** It selects by anchor id.

- An anchor is a `data-guide="<id>"` attribute on the element the guide should
  point at. Ids are dotted and named by meaning, not by look:
  `header.attach`, `header.share`, `header.search`, `home.import`,
  `home.newPage`, `page.focusedBlock`, `pdf.textLayer`, `dock.chat`,
  `dock.notes`, `row.handle`, `account.menu`, `settings.ai`.
- `frontend/src/guide/anchors.js` is the registry: every id with a one-line
  description, the view it lives in (`home` / `page` / `pdf` / `any`) and, for
  anchors inside a settings pane or a menu, the `open` path the engine must
  perform first (see below). Adding an attribute in JSX without registering it,
  or referencing an unregistered id from a tour, fails `npm test`.
- Dev inspector: `/?guide=inspect` outlines every anchor currently in the DOM
  with its id, the way Figma's inspect overlay labels layers. This is how you
  re-point a tour after a redesign: open the inspector, read the id, edit the
  step.
- Anchors move with the JSX they decorate. When a control is deleted, delete
  its registry row; the tests then name every step that referenced it.

Because App.jsx is still being decomposed ([frontend-refactor.md](frontend-refactor.md)),
anchors are the only thing the guide needs from it. No guide code imports App
state directly; App passes the few facts the engine needs (view mode, whether
the page has a PDF, whether an AI provider is configured) through one
`useGuide()` call.

## Tour scripts

A tour is data. `frontend/src/guide/tours/firstRun.js`:

```js
export default {
  id: "first-run",
  version: 2,                 // bump to re-offer the tour to everyone who finished v1
  title: "Your first paper",
  estimate: "2 min",
  when: { signedIn: true, shareMode: false, readOnly: false },
  steps: [
    {
      id: "open-welcome",
      anchor: "home.card.welcome",   // the seeded page's card
      title: "Every paper is a page",
      body: "Notes and highlights live on the page that carries the PDF. Open the welcome paper.",
      advanceOn: { event: "page.opened", match: { seeded: "welcome" } },
      fallback: { action: "navigate", to: { page: "welcome" } },  // Next does it for you
    },
    {
      id: "highlight",
      anchor: "pdf.textLayer",
      placement: "left",
      title: "Select text to highlight it",
      body: "Drag over a sentence in the PDF. The highlight becomes a block in your notes.",
      advanceOn: { event: "highlight.created" },
      requires: { view: "page", hasPdf: true },
    },
    {
      id: "outline",
      anchor: "page.focusedBlock",
      title: "Notes are an outline",
      body: "Enter makes a sibling, Tab indents, Shift+Tab outdents.",
      advanceOn: { event: "block.indented" },
    },
    { id: "search", anchor: "header.search", body: "Ctrl+F searches this paper's notes, the PDF text and the whole library.", advanceOn: { event: "search.opened" } },
    { id: "chat", anchor: "dock.chat", requires: { aiConfigured: true }, skipWhenUnmet: true, body: "Ask about the open paper. Answers cite pages you can click.", advanceOn: { event: "chat.sent" } },
    { id: "chat-setup", anchor: "dock.chat", requires: { aiConfigured: false }, skipWhenUnmet: true, body: "Chat needs an AI key. Add one under Settings → AI.", advanceOn: { event: "settings.opened", match: { pane: "ai" } } },
    { id: "share", anchor: "header.share", body: "Share the page as a link. Viewers see your highlights; editors can add their own.", advanceOn: { event: "share.opened" } },
  ],
};
```

Step fields:

- `anchor` (required), `placement` (auto by default; the positioner flips to
  fit), `title`, `body` (markdown, rendered by the app's markdown component so
  kbd marks and links work).
- `requires`: facts that must hold for the step to make sense. With
  `skipWhenUnmet` the step is dropped from this run; without it the engine
  shows a **detour card** instead: "This step needs an open paper", pointing at
  the anchor that gets you there (`fallback.action`). A step never blocks.
- `advanceOn`: an event from the catalog below, optionally with a `match` on
  its payload. Next always advances too; task-driven advancement is a
  convenience, not a gate. `advanceOn: null` means Next only.
- `open`: a path the engine performs before showing the step when the anchor
  is inside a closed surface, e.g. `["account.menu"]` clicks the account menu
  so `account.workspaces` becomes visible. Declared per anchor in the registry,
  overridable per step.

## The event catalog

The app emits a small number of named events; tours and checklist items
consume them. `frontend/src/guide/events.js` exports `guideEvents.emit(name,
payload)` and the catalog: `page.opened`, `pdf.attached`, `highlight.created`,
`block.created`, `block.indented`, `search.opened`, `chat.sent`,
`share.opened`, `settings.opened`, `import.done`, `ink.stroke`. Roughly ten,
each emitted at one instrumented point (the block tree's transition for
`block.*`, the highlight creation path for `highlight.created`, and so on).
A test asserts every `advanceOn` name is in the catalog.

Events are the seam that keeps tours out of App.jsx: instrumenting a new
event is one line at the point where the thing happens, and every future tour
can use it.

## The engine

`frontend/src/guide/useGuide.js` + `GuideOverlay.jsx`, mounted once in App.

State machine: `idle` → `offered` (the small invitation card) → `running
{tourId, stepIndex}` ↔ `waiting` (anchor not in the DOM yet) → `done` /
`dismissed`.

- **Finding the anchor**: `document.querySelector('[data-guide="id"]')`,
  retried on a `MutationObserver` for up to 3 s (the page may still be loading:
  the PDF skeleton, a lazily mounted dock). If it never appears the step is
  reported (`guideEvents.emit("guide.anchorMissing")` plus a `console.warn`)
  and the tour skips it rather than showing a card in the void. The e2e suite
  already fails on console errors; the scenario promotes this warning too.
- **Spotlight**: one fixed overlay with an SVG mask cut out around the anchor's
  rect (the Driver.js shape). The cutout passes pointer events through so the
  user acts on the real control; the dimmed area swallows clicks. Repositioned
  on scroll and resize via `ResizeObserver` + `requestAnimationFrame`; the
  anchor is scrolled into view first.
- **Card**: the app's popover look (same tokens as the account menu and the
  Share popover, per [ui-design.md](ui-design.md)): title, body, `step n of
  m`, Back / Next / Skip tour. On phone and iPad widths the card becomes a
  bottom sheet and the spotlight stays; touch targets follow [ipad.md](ipad.md).
  Esc dismisses. Focus stays where the user is working; the card is
  `aria-live="polite"`, never a focus trap.
- **No new dependency.** The positioner is about sixty lines (measure rect,
  pick side, clamp to viewport). The app already positions popovers without a
  library.

## Starting and replaying

Open **Account > Tours** and choose a tour. Every tour is manual and can be
replayed. AI chat opens its dock if needed; PDF-specific steps are included
only when the PDF is visible. Share views do not mount tours.

## Storage

One synced, account-wide pref `onboarding` (add it to `db.USER_PREF_KEYS`;
no schema step, the prefs KV already exists):

```json
{ "tours": { "first-run": { "version": 2, "step": 4, "state": "running" } },
  "checklist": { "highlight": "2026-09-18T10:00:00Z", "share": null },
  "hints": { "chat-empty": true },
  "dismissedAt": null }
```

localStorage (`gamma-onboarding:<user>`) is the instant-paint cache, server
wins, same rule as `appearance` ([settings.md](settings.md)). No per-workspace
scope: you learn the app once, not once per workspace.

## The welcome page and its sample PDF

- Content is `backend/gamma/onboarding/welcome.md`, a normal markdown outline,
  imported at seed time with the same parser as `POST /pages/from-file`, so
  what the importer supports the welcome page supports (callouts, math, images,
  tables). Editing copy is editing markdown.
- The page carries a PDF so "select text to highlight" has a target. The PDF is
  **rendered from the same markdown by the notes-as-PDF writer**
  (`pdf_notes.py`, [import_export.md](import_export.md)) at seed time and
  stored through the content-hash store like any upload. No binary asset in the
  repo, no licence question, always in step with the text, and it demonstrates
  the export feature. Images come from `frontend/public/media/` served by the
  same origin, not GitHub raw.
- Seeded into every new personal workspace's first creation
  (`workspaces.ensure_personal(..., welcome=True)` for a new account, in
  addition to the guest). Shared workspaces get nothing. The page has
  `properties.seeded: "welcome"` so tours can find its card
  (`home.card.welcome` is derived from that property) and so a re-seed can
  tell it apart from user pages. Deleting it is fine; the tour's detour card
  then says "Open any paper".
- The seeded blocks go through `commit_ops` like every other writer
  ([collab.md](collab.md)); the current raw-insert path in `seed.py` is
  replaced, not extended.

## Checklist and hints

- The checklist (`checklist.js`) is five items, each `{id, label, doneOn:
  event, tour: {id, step}}`: import or open a paper, make a highlight, indent a
  block, search, share. Completion is recorded from the same event bus, so
  doing the thing on your own counts even if you never ran the tour (the
  Linear pattern). Progress shows as a thin bar in the popover and a dot on the
  account button until done or dismissed.
- Hints (`hints.js`) are single cards bound to a state, not a sequence:
  `{id, anchor, when: {view, aiConfigured: false, ...}, once: true}`. First
  examples: the chat dock opened with no provider ("Add a key in Settings →
  AI"), the first PDF page shown on a stylus device ("Draw with the pen; tap
  the pen tool to change colour"), the first share link copied ("People with
  the link see it read-only; switch to Edit to let them annotate"). Empty
  states in the library and the notes column stay where they are; hints point
  at controls, empty states explain areas.

## Files

```
frontend/src/guide/
  anchors.js        registry: id → {description, view, open?}
  events.js         guideEvents bus + the catalog
  useGuide.js       state machine, anchor resolution, storage sync
  GuideOverlay.jsx  spotlight + card + bottom sheet, the inspector overlay
  checklist.js      items and their events
  hints.js          contextual hint definitions
  tours/firstRun.js one file per tour
  guide.css
backend/gamma/onboarding/welcome.md   the seeded page (and the sample PDF's source)
backend/gamma/seed.py                 imports it; renders the PDF; commit_ops
frontend/tests/guide.test.js          schema, anchor references, event names, unique ids
frontend/tests/e2e/scenarios/guide.mjs  every tour end to end, anchors present per view
```

## Validation

- `npm test`: every tour parses against the step schema; every `anchor` is in
  the registry; every `advanceOn`/`doneOn` event is in the catalog; ids are
  unique; `version` is an integer.
- `npm run e2e` (`guide.mjs`): for each view (`home`, `page`, `pdf`) every
  registry anchor declared for that view is in the DOM (after performing its
  `open` path); the first-run tour is driven end to end by performing each
  step's action and asserting the card moved to the next anchor; the detour
  card shows when a step's requirement is unmet; `?guide=` starts a tour; the
  share view mounts nothing; any `guide.anchorMissing` warning fails the run.
- Backend: seeding a personal workspace produces the welcome page with an
  attached PDF and a `seeded` property; the tuple-free seed path goes through
  `commit_ops`; a guest re-seed is idempotent.

## Build order

1. Anchors + registry + inspector + the node test. Decorate the roughly
   fifteen controls the first tour needs. No visible change.
2. Event bus + the ten emit points.
3. Engine + overlay, driven by a hard-coded two-step tour behind `?guide=`.
4. `firstRun.js` in full, the `onboarding` pref, the invitation card and the
   account-menu entry. E2e scenario.
5. Welcome page as markdown + rendered sample PDF, seeded for new accounts.
6. Checklist popover, then hints.

Steps 1 to 3 are invisible to users and safe to merge one at a time.

## Rules once this exists

- New control worth teaching: add `data-guide`, register it, done. Never point
  a step at a class.
- Renaming or removing a control: update the registry row; the tests name the
  affected steps.
- Copy changes: edit the tour file or `welcome.md`. Bump `version` only when a
  finished user should see the tour again.
- Keep this doc, [settings.md](settings.md) (the `onboarding` pref) and
  [api.md](api.md) (the prefs key list) in step.
