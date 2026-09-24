# Native embedded runtime host

This is opt-in integration, not a replacement backend or a bundled placeholder.
The existing project, AppRoot, workspace views and GammaAPI are unchanged.

## Public contract

- `GammaEmbeddedRuntime.shared()` is the one native process owner. Main-queue
  `start(dataRoot:completion:)` returns secret JSON data or a sanitized NSError;
  `stop(completion:)` acknowledges termination or reports a 12-second timeout.
  `didExitHandler` notifies every serve return on main, before stop completions.
- `@MainActor GammaEmbeddedRuntimeController.shared.start(dataRoot:) async throws`
  returns `GammaEmbeddedBootstrap`. Its states are stopped, starting, running,
  stopping and failed. `stop() async` clears its bootstrap immediately. A timeout
  leaves stopping, not stopped; a later native exit transitions to stopped.
- Data must be a descendant of this app's Application Support directory, not its
  root, and the canonical path is pinned for the process lifetime. Native resolves
  symlinks before checking containment. Python owns directory creation, migrations,
  ownership checks and actual data access. No document-picker/security-scoped URL
  is accepted as a runtime data root.
- Bootstrap account/workspace, session cookie, capability cookie/header/value
  remain in memory. These types intentionally are not Codable. Their descriptions
  and mirrors are redacted. Never place them in preferences, logs, JS or URL queries.
- A bootstrap URL must be HTTP `127.0.0.1`, port 1024–65535, path empty or `/`,
  without userinfo, query or fragment. Both cookies are host-only, session-only,
  HttpOnly, SameSite=Strict and non-Secure because transport is loopback HTTP.
  `httpCookie(origin:)` parses a Set-Cookie without a Domain attribute.
- Consumer integration must install BOTH cookies into a **nonpersistent**
  WKWebsiteDataStore before navigation, reject every foreign origin or port,
  clear that store on stop and avoid redirects to foreign origins. Native HTTP
  clients must send the session and capability and apply equivalent redirect
  restrictions. `permits(_:)` compares the exact origin/port. This host does not
  yet change GammaAPI or create a WebView/cookie store.

## Interpreter and lifecycle

One dedicated NSThread runs `Py_InitializeFromConfig` with isolated configuration,
no signal handlers, no site import and no bytecode writes. Before initialization
it registers `_gamma_ios_host` and, with `GAMMA_EMBEDDED_PDF=1`, `_gamma_ios_pdf`.
The runtime calls the full `gamma_ios_runtime.serve(RuntimeConfig(Path, Path),
ready, threading.Event)` contract. The C ready callable holds a generation token,
uses `dataclasses.asdict`/JSON only in memory and copies at most 64 KiB to native.
Main-queue generation/cancellation checks prevent a stale ready from binding UI.

After serve returns the owner releases the GIL and waits on an NSCondition.
Restart reuses the interpreter, thread and same paths. There is **no finalization**,
thread cancellation, signal installation or process termination. Stop never
acquires the GIL on main: it sets the Python event from a utility queue, or the
owner observes cancellation after initialization. Initialization/import cannot
be forcibly interrupted. A hung C extension can hold the GIL beyond the stop
bound; no second server/interpreter is launched to work around that.

Existing backend daemon/scheduler threads remain process-owned after a listener
stops. App suspension should request stop and use an appropriate finite UIKit
background task in the app integration; this host makes no promise of continued
execution after iOS suspends the process. That scene wiring remains a separate
integration step.

Raw Python exception values/tracebacks are discarded; even exception strings can
contain credentials. Native errors use fixed diagnostic messages. Python stdout,
stderr and their original stream aliases are replaced before Gamma imports by a
content-discarding sink with a saturating 1024-write counter. No raw lines or
partial lines are retained. This is intentionally stricter than token redaction.
Native extension direct writes to OS file descriptors are outside that Python
stream boundary and must independently avoid credential logging. Startup before
stream installation has no bootstrap credentials.

## Required packaging

Generate `project.embedded.yml` with **real** environment values:

- `GAMMA_PYTHON_XCFRAMEWORK`: actual signed-compatible CPython 3.13 XCFramework
  with appropriate simulator/device slices, named Python.framework.
- `GAMMA_EMBEDDED_BUNDLE_SCRIPT`: actual official packaging script, invoked by
  `/bin/bash` in an Xcode prebuild phase. No fallback implementation is provided.

The script receives the normal Xcode environment plus:

- `GAMMA_EMBEDDED_SOURCE_ROOT=$SRCROOT/EmbeddedBackend`
- `GAMMA_EMBEDDED_RESOURCE_ROOT=$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/EmbeddedGamma`

It must place the complete compiled frontend and Python closure at:

```
EmbeddedGamma/
  frontend/index.html                  # actual frontend dist, all assets
  app/gamma_ios_runtime.py
  app/gamma_ios_pdf.py
  app/gamma/                           # actual complete backend
  app_packages/                        # complete dependency closure
  python/lib/python3.13/                # actual stdlib, including encodings
  python/lib/python3.13/lib-dynload/
```

Those final four Python directories (`lib/python3.13`, its `lib-dynload`, `app`,
`app_packages`) are the entire configured module search path. Packaging must
handle iOS signed extension-framework relocation/loaders for every binary module;
copying desktop wheels or raw executable dylibs into resources is not sufficient.
The overlay embeds CPython and compiles the PDF builtin with ARC. Its explicit
Python header paths assume Xcode's Python XCFramework intermediate naming; verify
against the actual packaging product. Packaging code signing, extension framework
embedding and architecture selection belong to the official script/build setup.
Missing resource files fail the prebuild; there is no downloaded runtime or dummy
framework. Deployment target and signing remain inherited from the main project.

## Validation

`tests/GammaEmbeddedRuntimeContractTests.swift` is included only by the overlay.
It tests bootstrap URL restrictions, redacted descriptions, exact-port gating
and session/non-Secure/HttpOnly cookie construction. These are candidate Apple
unit tests; they have not been executed on this Linux worker.

Parent macOS/device validation must compile the ObjC bridge and Swift controller,
run those tests and exercise actual start, ready, stop during initialization,
stop after ready, repeated stop, timeout and late exit, same-path restart,
other-path rejection, malformed bootstrap, missing dependency, and unexpected
serve exit. Verify the main run loop stays responsive, credentials never appear
in device logs, and the retained interpreter can serve a second fresh-capability
session. Package/build and real iOS execution are not implied by source checks.
