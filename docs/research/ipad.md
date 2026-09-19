# The iPad client: native app or installed web app?

Survey from 2026-09-18, when the upstream feature study
([todos/upstream-feature-study-2026-09-18.md](../../todos/upstream-feature-study-2026-09-18.md))
ranked upstream's native iPad app first. Findings only; what was built is
in [dev/ipad.md](../dev/ipad.md).

## What upstream's app delivers

`amogadget/Gamma` ships `ipad/`: a SwiftUI app (iPadOS 17+, built from
source with Xcode and XcodeGen, no App Store release) whose reader is
PDFKit for text selection and PencilKit for drawing, with a `WKWebView`
hosting the ordinary web app for everything else ("Full Gamma") and a
bridge that hands a document to the native reader and back. Its own
parity matrix (`ipad/WEB_PARITY.md`) lists what is native: Pencil drawing,
audio recording and note replay; everything else — editor, math,
outliner, search, AI, settings, import/export — is the web app in the
web view. The native reader costs what
[handwriting.md](handwriting.md) already describes: PencilKit's opaque
`PKDrawing` as the source of truth, PNG previews and per-stroke rasters,
a raw-SQL endpoint family with revisions and an outbox.

So the "native iPad app" is, in feature terms, two things: **(a)** an
installed, full-screen, home-screen entry into the web app, and **(b)** a
PencilKit drawing surface for one document at a time.

## What the browser already gives on an iPad

Measured against (b), Safari on iPadOS delivers through Pointer Events
what the ink layer uses: `pointerType: "pen"`, pressure, tilt, 120/240 Hz
moves without coalescing, Pencil hover as a buttonless pen pointer, and
`touchType: "stylus"` on the touch events the layer cancels to stop native
panning. Palm rejection while a pen is down is the layer's own rule. What
Safari does not expose: the Pencil's double-tap and squeeze gestures, and
`getCoalescedEvents` / `getPredictedEvents` (a latency nicety, Chromium
only). PencilKit's remaining advantages are its rendering latency (the
layer's `desynchronized` canvas is the web equivalent) and its stroke look,
which the handwriting research chose perfect-freehand over.

Measured against (a), iPadOS has supported "Add to Home Screen" web apps
with `display: standalone` since iOS 11.3, with a separate cookie jar per
installed app, `theme-color` painting the status bar (iOS 15+) and
`env(safe-area-inset-*)` for the home indicator. Installability needs no
service worker on iOS (Chromium requires one only for its install-prompt
heuristics, not for the manifest to work).

## Decision

Build (a) and keep (b) as the existing browser layer:

- The pen quality gap is small and the format cost of closing it with
  PencilKit is the one the handwriting research already rejected.
- A Swift app cannot be built, signed or run from this repository's
  Windows/Linux toolchain or CI; upstream needs a Mac per user and a
  build agent. The web app is the product on every other platform too
  (the desktop is an Electron shell over it).
- A `WKWebView` wrapper is a later distribution decision (App Store,
  share sheet), not a feature one; it would be built like the desktop
  shell, treating Gamma as a black box.

The concrete additions this implied — manifest, full-bleed icons from the
brand mark, the status-bar colour following the theme, standalone-mode
overscroll and safe-area rules — are in [dev/ipad.md](../dev/ipad.md).
