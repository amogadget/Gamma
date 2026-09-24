# Offline files on iPad

**Two separate modes:** the standalone **On this iPad** library needs no server
or login; see [LOCAL_LIBRARY.md](LOCAL_LIBRARY.md). This document describes
cached **server** libraries, whose identity and synchronization rules still
apply. A local PDF is not silently uploaded when connecting a server.

## Product behavior

- Local files belong to one Gamma **library** (workspace) as well as one server and
  account. The sign-in screen and the download manager both name the library, and a
  cache cannot be opened without one: files carrying another workspace's identity are
  refused, not uploaded.
- An intentional download stays on the iPad until the user explicitly removes downloaded files. There is no storage budget, automatic eviction, or separate pin toggle.
- Preparing a document includes its original PDF, current notes and editable handwriting, and recordings. These components have separate readiness indicators; a remote audio URL is not an offline audio file.
- Recordings usually originate on this iPad. Valid existing local segments are reused, not downloaded again. Only missing segments with remote assets are downloaded. Local unuploaded, active, interrupted and recovery data are protected; a corrupt existing file is reported rather than overwritten.
- The login screen offers existing local account/server/library caches without additional local authentication. This selects local data only: it does not establish a server session. Full Gamma and remote operations require sign-in. Offline edits remain in the same account's and library's outbox.
- A cache written before Gamma had libraries is listed as "Workspace unknown" but
  cannot be opened offline: without a server the app cannot prove which library it
  belongs to. Sign in online once and it is attached to the account's default
  workspace; nothing is moved otherwise.
- Local-file removal never deletes Gamma documents or remote assets. Snapshot/outbox data is retained. Removal is conservative: pending work, recovery data and ambiguous provenance can prevent deletion.

## Workflow

From Full Gamma, choose **Downloads** to open download management directly, without changing the Web workspace or entering the PDF editor. Choose **Select**, select documents, then **Download selected**. The native library also provides download selection and a download-management button. Handwriting and recording controls belong only to an opened PDF, not to the library or Downloads page.

After a successful sign-in, relaunch restores the same server/account/library from a device-only Keychain session record. It opens the cached library immediately and validates `/api/session` before remote reads or writes. Valid sessions need no password prompt. A timeout, DNS failure, brief connection loss, or temporary server outage is not a logout: an eight-second grace period avoids changing the UI for short interruptions; longer outages use local files while reconnecting with bounded backoff (2–30 seconds). The foreground path monitor and scene-active entry resume probes. Native outbox synchronization resumes only after the same account and selected library's writer role are verified. Web navigation is not reset on a brief interruption.

A 401 or signed-out session requires explicit login; wrong-account responses stop synchronization. A 403, missing membership, or viewer role stops synchronization without selecting the default library. Cached documents and pending changes remain untouched. **Sign in to sync** is for expired/revoked sessions or explicitly selected local-only accounts, not ordinary network recovery. Cancel or failed authentication keeps the local workspace intact. Other cached accounts remain available under **Open files on this iPad**.

Switching libraries in the native header is refused while anything is pending
(`canSwitchWorkspace`). Sync a library before switching to it.

## Session storage and installation boundaries

`GammaSessionStore.swift` writes one atomic Keychain record containing only the canonical HTTPS server, verified username, selected workspace/name and `session` cookies (including session-only cookies). Accessibility is `AfterFirstUnlockThisDeviceOnly`, with iCloud synchronization disabled. Native URLSession cookie jars remain ephemeral and isolated; validated cookies are supplied to WebKit through `GammaWebSession`. No Apple/account password, cookie or other session secret is written to UserDefaults. Workspace/server/name preferences are non-secret hints only. Failed login/role verification never replaces the saved session. Explicit sign-out clears the Keychain session and runtime cookies; it retains documents and queued local edits.

An **in-place app update** with the unchanged app identity retains the app container and Keychain session. The older ephemeral-only release cannot recover a cookie it never persisted, so its first upgrade may require one sign-in. **Deleting the app is different**: cached documents can be deleted by iOS, Keychain survival is not a backup guarantee, and no client can guarantee an indefinitely valid cookie. Server expiration/revocation and password changes still apply (`SESSION_MAX_AGE` is currently 365 days); this feature does not change server policy. Device migration does not transfer this `ThisDeviceOnly` credential.

Coordinator entry points: root calls `restoreInitialLibrary()` to select local or server mode; only the server path calls `restoreSession()`. It then calls `sessionDidBecomeActive()` / `sessionDidEnterBackground()` for lifecycle; local mode does not start a session monitor or reconnect loop. `requiresLogin` is an explicit authentication/access failure, not connectivity. `restoringSession` lets the root avoid flashing an empty login form. `isOffline` selects the cached presentation without discarding Web state. A resumed native reader must not be switched to Web just because a background probe succeeds.

Tests inject `GammaSessionPersistence`, a temporary cache root and URLProtocol-backed API factory; they never access a real Keychain or server. `GammaSessionPersistenceTests` covers restoration, cookie isolation, exact-workspace role validation, 401/null-user, wrong account, viewer downgrade, timeout recovery, grace, logout retention, failed login atomicity and stale-generation responses. Swift tests require the parent's simulator build; source-contract checks do not substitute for device flight-mode validation.

## Safety and verification

Downloads must not switch the current reader, update recents, or start recording. Incomplete files must never be advertised as complete. Account, workspace and role changes and cancellation invalidate running work; restart retains queued work for a later authenticated session in the same library. A queued change stamped with another workspace is parked as a conflict and never uploaded where it does not belong. Failed preparation retains successfully downloaded components for retry.

Verification results and remaining hardware boundaries will be recorded below after execution; the statements above specify intended behavior, not a pre-marked acceptance report.

## Verification completed

- Full iPad simulator suite: **109 passed, 5 skipped, 0 failed** (114 total).
- Separately enabled disposable-backend integration: **3 passed, 0 failed**, covering native edits, AAC upload/reopen, offline remote audio acquisition/local audio reuse, and offline edits syncing to the same account.
- Queue tests cover duplicate requests, active cancellation, retry, persisted in-flight recovery, corrupt PDF, missing/local-only audio and account-generation invalidation.
- Workspace identity tests cover a cache per server/account/workspace, refusal of a
  snapshot or manifest naming another library, the legacy migration (only to a
  verified default workspace, never merging, rollback-safe), the outbox stamp, and
  the sync gate that parks a foreign-workspace change.
- `scripts/test_native_workspace_contract.py` re-checks those invariants in the
  sources and the structural soundness of the Swift files on a machine without a
  Swift toolchain.
- Local cold-entry test opens a cached PDF and plays locally created unuploaded audio without an API session; corruption tests preserve source bytes and invalidate visible readiness.
- These are historical focused results; see [VALIDATION.md](VALIDATION.md) for portable reproduction and the latest summarized regression. Installation/launch is not a flight-mode acceptance test.

### Remaining acceptance boundaries

Physical iPad flight-mode process relaunch, real Pencil/microphone interactions, OS suspension under memory pressure, disk exhaustion and large-library performance have not been hardware-validated. The live test seeds the PDF through a data request because the test-only URLProtocol bridge does not exercise URLSession download tasks; real-network PDF interruption remains a device acceptance boundary. No production accounts or user recordings were used. No commits were pushed.

### Direct sign-in UI correction

The offline header and download manager now provide an actual **Sign in to sync** button. Its same-account password sheet allows cancellation without sign-out and reconnects without closing the current reader. Simulator regression after this correction: **110 passed, 5 skipped, 0 failed**.

### Download navigation separation

Full Gamma’s **Downloads** action now presents the manager as a sheet and never closes the reader or switches into the native editor. The manager supports multi-selection directly. The library no longer carries a Pencil/Recording/Replay banner. Full simulator regression: **110 passed, 5 skipped, 0 failed**; additional download-manager isolation checks pass.
