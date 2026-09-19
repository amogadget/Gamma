# Gamma for iPad

Native Gamma client for iPadOS 17+, Swift 5.9 / Xcode 15+, and XcodeGen 2.38+. **Sign in → the same Gamma library → the existing PDF page and Notes tree.** There is no Files-import library, local UUID document copy, or import sheet.

**[统一设计总纲](../docs/design/handwriting-recording-ipad.md)**：手写、录音、双端 Replay、混合工作区、持久化与安全的完整设计；历史讨论中的未实现设想与现状分别标注。

## Use

1. Enter your HTTPS Gamma server and account. The authenticated session stays alive while moving between library and reader. Only server URL and authenticated username are remembered; passwords/cookies are not persisted. Relaunch offers **Open files on this iPad** for existing local accounts without a network connection or additional local authentication. This is not a server session; sign in to the same server/account to sync pending edits.
2. After sign-in, **Full Gamma** opens the actual Web workspace inside the app: the existing Markdown/math editor, block tree, search, AI, settings and import/export UI. Open a PDF there and choose **Pencil & Audio** to switch that same document to PDFKit/PencilKit; the original cached PDF is downloaded without changing its Gamma identity. **Full Gamma** returns after pending native changes sync and reloads the Web tree. See `WEB_PARITY.md` for the feature matrix and platform limits.
3. In the native workspace, **Select text** enables PDFKit selection; long-press a passage, adjust the handles and choose a highlight color. It creates an ordinary Gamma highlight/note block. For handwriting, navigate to a PDF page and press **New Ink**. Multiple Pencil strokes belong to that one `pdf_ink` unified block, directly under the existing Gamma PDF page. New Ink is explicit; writing does not create one note per stroke.
4. The **Notes** tree stays next to the PDF. Select an Ink block to edit its strokes; all other ink is read-only background. Edit the annotation’s own content in **Annotation note**, and add ordinary child notes with **Add Child Note**. Selecting an annotation navigates to its PDF page.
5. **Saved on iPad / pending** is not a server success. The durable outbox retries every 15 seconds while signed in, on activation, and through **Retry Sync**. **Reload Notes** fetches the current remote subtree and editable sources. Revision conflicts stop that ink upload until explicitly choosing local or remote; choosing remote archives the old local source in the cache.

## Offline downloads

Choose **Downloads** from Full Gamma, then **Select → Download selected**. This opens download management directly, not the handwriting/recording workspace. The native library also offers downloads through selection or a document’s context menu. Downloads include PDF, notes/handwriting and recordings. Valid local recordings are reused; only missing remote audio is fetched. The download manager shows component readiness, per-document/total local size, cancellation/retry and explicit local-file removal.

Intentional downloads remain until you remove them. **No cache budget or automatic eviction** is imposed. Removing local files never deletes server documents, pending edits or recording recovery sources. See [OFFLINE.md](OFFLINE.md) for behavior and verification boundaries.

## Identity, storage, and synchronization

`GammaWorkspace` is the main-actor coordinator. Reader callbacks capture the configured annotation ID, not mutable selection; synchronous local snapshots persist before networking. Reader page indexes are zero-based; server `pdf_page` is one-based. A selection changes `contentRevision`, so the reader flushes old callbacks before reloading the selected annotation canvas.

**A request always names its library.** Upstream Gamma scopes every data path to a
workspace, resolved from `?ws=`, the `X-Gamma-Workspace` header, or the account's
default. This client never relies on the default: a workspace is chosen once from
`/api/session`, bound to the API client (which starts *unbound* and can only log
in), and sent on every request. The same workspace keys the local cache, stamps
every queued change and appears in the Web handoff. Choosing a different library
means building a new client, and it is refused while anything is pending — a
queued change belongs to the library it was written in. Read
[NATIVE_INTEGRATION.md](NATIVE_INTEGRATION.md) for the full model, the frontend
bridge contract and the migration rules.

`Library/Application Support/GammaCache/<SHA256(server + authenticated username + workspace)>/` contains:

- `identity.json`: non-secret canonical server, authenticated username and
  workspace id (plus its display name) for local library discovery.
- `offline.json`: persistent per-document preparation queue and component readiness.
- `library.json`: cached Gamma page IDs and document metadata.
- `source-<SHA256(doc_id)>.pdf`: immutable original PDF bytes.
- `page-<SHA256(page_id)>.json`: Gamma block tree, per-block PencilKit source archives, and durable pending mutations in one atomic snapshot.

Ink uploads preserve editable `.pkdrawing` source and a PNG preview via `POST /api/assets`, then update one permanent client-generated unified block ID with `PUT /api/blocks/{id}/ink`. The ID is an annotation ID on Gamma, not a separate local knowledge document. Annotation text and pre-existing ordinary notes use normal block content PUT. New child notes use canonical UUID `PUT /api/blocks/{id}/note` with `expected_revision`; exact retries are idempotent and divergent revisions conflict. Add Child is available on ink annotations and native-note descendants, not arbitrary unrelated blocks. Child note text changes use the same revision-checked endpoint.

Pending edits never disappear merely because a network request fails. Snapshot corruption throws rather than silently creating a blank source. Caches are isolated per server, account **and workspace**; sign-out preserves queued data, and retries only start after authenticating that same account and workspace. A cache file that names a different workspace than its directory is refused rather than uploaded. Credentials are never written into cache files. Atomic writes are not a guarantee against physical storage failure; keep backups. Cache files are private app data, not an export feature.

**Legacy data is preserved:** `NoteStore` and its tests remain for older `Application Support/Notes/<UUID>` bundles. Those files are neither deleted nor automatically uploaded. The app does not expose the old import-only library. See [VALIDATION.md](VALIDATION.md) for recorded regression results and the current acceptance boundaries.

Caches written before Gamma workspaces existed are kept at their old
`server + username` directory and listed on the sign-in screen as
"Workspace unknown". They are **not** opened offline (a client without a server
cannot prove which library they belong to) and are attached only to the account's
server-verified default workspace, by a single rename that is refused if the
target already exists or if re-stamping the identity fails. See
[NATIVE_INTEGRATION.md](NATIVE_INTEGRATION.md).

## Deployment

### 1. Run a matching Gamma server

Use the backend from **the same checkout** as this client. The native routes
(`/api/assets`, `/api/blocks/{id}/{ink,audio,note,highlight,replay-preview}`) come
from the native integration, not from upstream `tim/main` alone; a 405, a 501, or
an HTML body where JSON was expected means the server needs those routes — not that
pending notes should be discarded. The account must be a member with **editor or
owner** role in the workspace it opens: the native editor writes, and a viewer
workspace is refused with an explanation rather than failing at upload time.

```sh
# On your server, from the Gamma repository root:
docker build -t gamma:ipad .
docker run -d --name gamma -p 127.0.0.1:9001:9001 \
  -v gamma-data:/data gamma:ipad
docker logs gamma   # fresh installations print the initial admin password once
```

For an existing deployment, back up the data volume first, then rebuild/recreate the service using its **existing** volume and settings. Do not start a second container with a blank volume as an upgrade.

Expose the server through your HTTPS reverse proxy. For example, with Caddy running on the same host:

```caddyfile
gamma.example.com {
    reverse_proxy 127.0.0.1:9001
}
```

Configure DNS/TLS and confirm `https://gamma.example.com/api/health` works from the iPad. The app requires HTTPS; enter the server URL, not a URL ending in `/api`. Use a normal Gamma user account. For local development, provision trusted HTTPS rather than disabling transport security.

### 2. Generate and build the iPad project

Requirements: a Mac with full Xcode initialized, XcodeGen, an iPadOS 17+ device (or simulator), and a current `main` checkout containing `ipad/`. Apple SDKs cannot be built on Linux.

```sh
git clone https://github.com/amogadget/Gamma.git
cd Gamma
brew install xcodegen
cd ipad
xcodegen generate
open GammaIPad.xcodeproj
```

Choose target **GammaIPad → Signing & Capabilities**, enable automatic signing and choose your **Personal Team** or developer team. Use a unique bundle identifier if the default is unavailable. A paid developer membership is not required for personal device testing; free provisioning commonly needs renewing after seven days. Sign in to Apple locally—never put your Apple password in repository scripts.

To preserve machine-specific signing when regenerating, create ignored `ipad/project.local.yml`:

```yaml
include:
  - project.yml
settings:
  base:
    DEVELOPMENT_TEAM: YOUR_TEAM_ID
targets:
  GammaIPad:
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.yourname.gamma.ipad
```

Then use `xcodegen generate --spec project.local.yml`. Team IDs, local signing overrides, generated projects, build output and private keys must not be committed.

Connect/trust the iPad, enable Developer Mode, select it in Xcode and Run once; approve any necessary local development/keychain trust prompts. Allow microphone access when you first tap Record. Pencil drawing requires a compatible paired Apple Pencil.

### 3. Unattended builds over SSH (optional)

If direct SSH signing fails while local Xcode succeeds, use the manual desktop-session build agent. From the repository root **on the Mac**:

```sh
python3 ipad/scripts/install-mac-build-agent.py
launchctl kickstart gui/$(id -u)/com.gamma.ipad.agent-build
```

It uses the existing generated project and its signing settings. Check `gui-build/status` for `exit_code=0`; inspect `gui-build/stdout.log` and `stderr.log` on failure. Do not re-trigger a running build. A logged-in desktop session with an accessible signing key is required; no password or broad keychain ACL change is stored by this setup.

Install the resulting app without asking Xcode to sign again:

```sh
xcrun devicectl list devices
xcrun devicectl device install app --device YOUR-DEVICE-ID \
  GUIBuildDerivedData/Build/Products/Debug-iphoneos/GammaIPad.app
xcrun devicectl device process launch --device YOUR-DEVICE-ID \
  com.yourname.gamma.ipad
```

Use the bundle identifier you selected. See `scripts/MAC_BUILD_AGENT.md` for removal and troubleshooting. The installer substitutes your checkout path into the plist template; do not bootstrap the unexpanded template directly.

### 4. Sign in and verify

Open Gamma, enter the HTTPS server and account, and open an existing PDF. Check ink persistence and sync, then create a new recording while writing and changing pages. Replay should synchronize audio and final surviving timed ink. Old recordings cannot gain timing retroactively. `RECORDING.md` and `NOTE_REPLAY.md` describe behavior and limitations.

### Simulator tests and icons

From `ipad/`, with a generated project:

```sh
xcodebuild -project GammaIPad.xcodeproj -scheme GammaIPad \
  -destination 'platform=iOS Simulator,id=YOUR-IPAD-SIMULATOR-UDID' \
  CODE_SIGNING_ALLOWED=NO test
```

The live-backend tests are opt-in; see `scripts/LIVE_TEST.md`. They discover the
test account's workspace from `/api/session` and bind to it, so a disposable
backend only has to have the account seeded. Other tests exercise cache isolation,
persistence, replay, recovery and UI fixtures without opening a microphone. Test
evidence and hardware caveats are in `VALIDATION.md`.

On any machine — including Linux, where no Swift toolchain exists — the workspace
identity invariants and the structural sanity of the Swift sources can be checked
with:

```sh
python3 ipad/scripts/test_native_workspace_contract.py
```

See [VALIDATION.md](VALIDATION.md) for the latest recorded simulator regression,
portable reproduction, opt-in test configuration and remaining physical-device
acceptance boundaries. Simulator results do not guarantee Pencil/microphone
behavior or migration against real device data.

Login branding and the app icon use the existing `desktop/assets/icon.png`, not a generated gamma character. Checked-in asset catalogs work without image tooling. To regenerate them after updating that source, run `python3 ipad/scripts/generate-icons.py` from the root with Pillow installed (the backend virtualenv already includes it).

## Acceptance checks (not pre-marked passed)

- Log in to two accounts/servers; libraries, original files, drawings, and outboxes must never cross accounts.
- Log in to one account with two writable workspaces: the chrome names the library in
  use, a switch is refused while anything is pending, and after switching, edits and
  downloads land in the second library only.
- Hand a PDF to Pencil mode from Web in a **non-default** workspace; the native
  editor must open that same library (not the account default), and the returned
  Web tab must still be in it.
- Sign in with a workspace whose role is `viewer`; the app must refuse to open it
  for native editing and say why, without discarding anything.
- New Ink on page 2, draw several strokes, add an annotation note and child note: verify exactly one `pdf_ink` block under the existing Gamma page, with a normal child block.
- Create another Ink on the same page; selecting either edits only that annotation, including after zoom/navigation, immediate Library exit, and reopen.
- Reopen on a second client: hydrated editable source and PNG preview agree; original PDF bytes remain unchanged.
- Disconnect network while drawing/editing Notes; pending status must stay visible. Restore network, retry, relaunch and verify no duplicate annotation or child notes.
- Change the same Ink remotely, then sync local edits: require a visible conflict and explicit version choice; never silently overwrite.
- Test expired sessions, corrupt cache/source, asset download failures and disk-full failures; do not replace unreadable sources with blank drawings.
- Generate `python3 scripts/make-coordinate-fixture.py /tmp/gamma-coordinate-fixture.pdf`, upload it to Gamma, and check every crosshair on rotated/cropped/mixed-size pages with real Pencil input, zoom, pan, background/relaunch, and Split View.

Phase 3 recording is integrated: microphone control in the reader toolbar, segmented recording with pause/continue/stop, local recovery, audio-block synchronization and sequential playback. See `RECORDING.md` for usage and verified limits. Backgrounding/leaving the document pauses recording; continuous background capture is not enabled.

Phase 5A Note Replay is integrated for newly recorded sessions: audio-clock stroke/page timing, progressive final-surviving-ink playback, cross-page seek and tap-ink-to-audio. See `NOTE_REPLAY.md`. Older recordings remain audio-only because timestamps cannot be invented retroactively.

Phase 5B historical erase/undo/redo replay, flattened PDF export, automatic conflict merging, persisted Keychain session, and automatic legacy-library migration are not implemented.
