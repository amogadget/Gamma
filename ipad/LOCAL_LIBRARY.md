# On this iPad: standalone library

This mode stores documents, editable PencilKit handwriting, notes, highlights,
recordings and replay metadata in the iPad app's own storage. It needs no Gamma
server, account or login. It is distinct from downloaded server workspaces.

## Workflow

- Fresh installations open **On this iPad**. Import a PDF from Files with
  **Import PDF**; a durable copy is made before it appears in the library.
- Open a local PDF and use the existing handwriting, note, highlight, recording
  and replay controls. Writes are local primary saves, not pending uploads.
- Imported originals remain unchanged. Duplicate imports have independent note
  identities while identical PDF bytes may share an immutable source file.
- On relaunch, the chosen library and its saved documents remain available.
- In 1.1 the native chrome has **Disconnect → Disconnect server · On this iPad**,
  including while Full Gamma displays its login or home page. No PDF needs to
  have been opened, and no restart is required. Active/failed native saves must
  finish first; a background session probe and durable native upload queue do
  not trap the app in server mode.
- The matching Web bridge first flushes edits, browser ink and current/old-page
  collaboration queues. On failure it requires confirmation: a bounded recovery
  snapshot is saved in the original server cache before disconnecting. Missing
  or incomplete recovery is explicitly warned about, never claimed as a sync.
- Disconnect forgets the active server session and opens the local library. Saved
  server caches, recordings and native outboxes are retained under their original
  identity; local PDFs are never moved into or uploaded to that account.
- Server sign-in remains optional. A saved server session can be resumed without
  treating local files as belonging to that server. Existing server outboxes stay
  with their original account/workspace while viewing the local library.

## Storage and safeguards

`GammaCache.local` uses `Application Support/GammaLocalLibrary`, separate from
`GammaCache`'s hashed server/account/workspace directories. The local cache has
an explicit local flag, no fake server URL or username, and no account identity
file. It cannot be used as a remote API session.

An import holds Files-provider security-scoped access through a coordinated read.
The exact PDF bytes, initial page snapshot and descriptive metadata are saved
before an atomic library-index update publishes the document. Failed imports do
not delete existing data; they may leave harmless unreferenced files. Locked,
unreadable and empty PDFs are rejected rather than flattened or silently replaced.

Local mutations reuse the native snapshot model. A local save may remove a
network-shaped mutation record only after validating that the entire change is
represented in the primary snapshot. Missing state, foreign identity and
unsupported derivatives are errors, not permission to discard work. Recordings
use the same segment files, interrupted-session recovery and audio-clock replay
as the native reader; a missing audio file is not substituted by a remote URL.

Pending/failed PencilKit saves prevent reader/library changes. Exact drawing
retries continue through the existing reader mechanism in both library modes.
The first failed **standalone-library** primary transaction is retained in memory against its original
cache; **Retry save** must durably commit it before an unrelated newer change
can replace it. This also covers failed note/highlight/new-ink creation where
there is no dirty canvas to retry. Force-quitting during a storage failure can
still lose unpersisted work; keep the reader open until saving succeeds.
Connecting a server does not clear local data or convert it into that account's
outbox.

## Boundaries

- This is app-container storage, not an iCloud Drive synchronization feature.
  Deleting the app can delete its local library; no backup guarantee is implied.
- Server upload of local documents and merging local/server libraries are not
  implemented by the mode switch.
- Large PDF import currently performs coordinated reading, validation and hashing
  synchronously; large or cloud-backed files can take time. Data integrity is
  prioritized over deleting incomplete import remnants.
- Device deletion/garbage collection and password unlocking are not added here.

## Verification

Added XCTest coverage in `GammaLocalLibraryTests` and `GammaWorkspaceLocalTests`
for isolated storage, imports, failed writes, cold reopen, saved drawing/audio
metadata and local-versus-server boundaries. Byte fixtures do not prove audible
playback or microphone behavior.

Portable source checks: `python3 ipad/scripts/test_native_workspace_contract.py`
and `python3 ipad/scripts/test_native_local_ui_contract.py`. These are structural
checks, **not** an iOS build or execution of UIKit/PencilKit/AVFoundation.
Portable checks: **26 workspace/Swift-structure checks and 8 local UI/source
checks passed**, with clean whitespace checks.

After the user authorized Mac access, Xcode 27 compiled this implementation and
ran it in an isolated iPad iOS 27 simulator application identity. Final full
suite: **202 passed, 6 opt-in/environment-dependent skips, 0 failed**
(`LocalMode-All-3.xcresult`). The 16 new local storage/workspace cases passed.
Four additional tests now cover actual AAC and actual rendered local UI:

- `GammaLocalReplayTests`: silent generated PCM is encoded to valid AAC, finalized,
  decoded and played/paused through AVFoundation. Cold reopening and paused seeks
  across two segments verify hidden/partial/full ink and page navigation, with
  unchanged source bytes and zero API factory calls. Missing and corrupt local
  audio fail without network fallback or rewriting media. These tests do not
  open a microphone, prove speaker output, or test autonomous playback-clock drift.
- `GammaLocalUIIntegrationTests`: hosts the real fresh root view, saves its rendered
  screenshot and uses on-device text recognition to assert **On this iPad** and
  **Import PDF** are visible, **Sign in** is absent, and no API/session monitor was
  started. The captured screenshot was also visually inspected.

Full regression exposed a server-mode retry interaction with newly retained local
transactions. The retention latch is now explicitly local-only, preserving the
existing server-cache merge of later recording events with original stroke times;
that existing regression passes unchanged. One earlier run stalled in Xcode's
simulator diagnostic collection. Subsequent runs used bounded test timeouts and
`-collect-test-diagnostics never`; test failures were still reported normally.
The suite reports existing synchronous AVAudioSession activation/deactivation
warnings; this is not a latency or physical-device acceptance claim.

Real Files-provider/iCloud interactions, microphone/Pencil hardware, autonomous
playback-clock behavior, and process-kill recovery still need device validation.
No physical iPad installation, App Store upload, commit or push was performed
as part of this verification.
