# Full local Gamma runtime (implementation in progress)

The target is the same complete Gamma used by the desktop app, running inside
the iPad app, **plus** native Pencil & Audio. It is not the standalone native
PDF list and is not a partial Swift replacement for the API.

## Architecture

- Bundle the existing backend Python modules and complete built frontend.
- Embed CPython in the iOS process: iOS does not use desktop's subprocess sidecar.
- Run the actual FastAPI/ASGI app on a dedicated interpreter thread and a
  capability-protected loopback listener. HTTP, static assets, downloads/ranges,
  WebSockets and the actual backend business logic remain present.
- Keep the real Gamma users/workspace SQLite databases, uploads and keys in a
  stable app-private Application Support directory. Native Pencil & Audio uses
  those same workspace routes/assets, not a parallel local note database.
- Keep the remote-server option. Import prior standalone local files only through
  explicit, validated migration to the real local backend; never discard originals.

`gamma_ios_runtime.py` implements the Python worker entry point and bootstrap.
It receives data/static paths before importing Gamma, seeds a real non-guest local
owner, establishes actual server session rows, and supplies native code with
session plus high-entropy per-runtime capability cookies. Tokens are not logged.
All loopback requests, including WebSocket handshakes, must pass host/origin and
capability checks. Native WKWebView and URLSession transport must be configured
for this runtime specifically; remote HTTPS validation must not be weakened.

## Native dependency gates

Use CPython 3.13 iOS frameworks and exact backend dependency versions. Real iOS
extensions are required for pydantic-core, bcrypt, cryptography, CFFI and rpds-py.
A macOS arm64 wheel is not an iOS simulator wheel. Native binaries must have the
proper SDK platform load command, be packaged as signed frameworks and load
inside an actual iOS interpreter. No older crypto version or successful stub API
is an acceptable substitute for the current backend contract.

The first pydantic-core 2.46.2 simulator wheel has cross-compiled on the Mac and
its ARM64/LC_BUILD_VERSION iOS-simulator platform was checked. An actual iOS 27
simulator test now imports that extension in embedded CPython 3.13 and verifies
SchemaValidator/SchemaSerializer plus SQLite FTS5 and JSON queries (one XCTest,
zero failures). The official Python testbed needed iOS17 deployment settings,
ad-hoc simulator framework signing, and a scene delegate for the Xcode27 SDK.
This proves the first interpreter/native-extension gate, not the full backend or
device slice.

PDFKit/CoreGraphics adaptation lives in `native/GammaEmbeddedPDF.*` and
`gamma_ios_pdf.py`. It must cover backend PDF text/count/geometry/rendering,
Logseq area-image exports and PDF note-placement occupancy. Existing Python PDF
writers remain. Raster occupancy is an explicit conservative provider strategy,
not bit-identical PDFium object bounds; real rendering tests are still required.

## Status and verification boundaries

The real-backend host test `ipad/scripts/test_embedded_runtime.py` passed with
actual account/session creation, full route assembly, PDF import/notes/search,
HTTP/WebSocket gates, restart persistence and shutdown. Beyond that host test,
an actual iOS 27 interpreter test now boots the full backend and bundled frontend,
loads bcrypt/cryptography/CFFI/rpds/Pydantic, validates real local account/session
and all registered routes, creates a PDF through the real HTTP API, and stops
the HTTP worker. The native PDF provider also passes actual iOS text/raster
checks at all four crop rotations, occupancy bounds and concurrent calls.
These are meaningful engine tests, but full product UI/lifecycle/data-migration
acceptance remains separate. The existing backend mirror scheduler is process-owned;
a proper iOS foreground/background integration still needs to account for it.

Further integration has now built the actual Gamma iPad application with the
full signed-framework dependency closure. Simulator tests exercise the real
native workspace creating a PDF in the embedded backend, saving PencilKit data
through its native endpoints, and loading that same PDF/ink in bundled Full Gamma
inside WKWebView. After layout settles, return-to-Web page2/30% remains exact.
The same run checks native loopback transport isolation (7 tests, zero failures).
A separate real-backend retained-source migration suite passes 7 tests, including
PDF/Pencil/AAC preservation; a later concurrent-migration refinement still needs
its own final run.

Remaining gates include complete product lifecycle and background/foreground
recovery, broad UI/end-to-end feature checks, final concurrent migration testing,
physical-device slice signing/runtime qualification, final privacy declarations,
and verifying no old standalone-only entry or build path is mistaken for the
full embedded release.
The feature must not be reported complete until those gates pass.

Network-dependent features (external AI providers, DOI downloads, remote sync)
still need network access, just as on desktop. iOS suspension does not permit a
promise of an always-running background server. No downloaded executable Python
or JS modules, JIT, background-mode abuse or fake offline API successes.
