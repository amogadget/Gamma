# Offline files on iPad

## Product behavior

- An intentional download stays on the iPad until the user explicitly removes downloaded files. There is no storage budget, automatic eviction, or separate pin toggle.
- Preparing a document includes its original PDF, current notes and editable handwriting, and recordings. These components have separate readiness indicators; a remote audio URL is not an offline audio file.
- Recordings usually originate on this iPad. Valid existing local segments are reused, not downloaded again. Only missing segments with remote assets are downloaded. Local unuploaded, active, interrupted and recovery data are protected; a corrupt existing file is reported rather than overwritten.
- The login screen offers existing local account/server caches without additional local authentication. This selects local data only: it does not establish a server session. Full Gamma and remote operations require sign-in. Offline edits remain in the same account's outbox.
- Local-file removal never deletes Gamma documents or remote assets. Snapshot/outbox data is retained. Removal is conservative: pending work, recovery data and ambiguous provenance can prevent deletion.

## Workflow

From Full Gamma, choose **On this iPad** to open the native library. Choose **Select**, select documents, then **Download**. A document's context menu also offers download. The download button in the native library opens component status, retry/cancel controls and explicit local-file removal.

After restarting without a connection, choose a saved account under **Open files on this iPad**. Open prepared documents normally. To reconnect, tap **Sign in to sync** in the native workspace header or download manager. The sheet shows the current server/account and asks only for its password. Cancel or failed authentication keeps the local workspace intact; successful authentication syncs without closing the current reader. Pending changes are not sent using a different account.

## Safety and verification

Downloads must not switch the current reader, update recents, or start recording. Incomplete files must never be advertised as complete. Account changes and cancellation invalidate running work; restart retains queued work for a later authenticated session. Failed preparation retains successfully downloaded components for retry.

Verification results and remaining hardware boundaries will be recorded below after execution; the statements above specify intended behavior, not a pre-marked acceptance report.

## Verification completed

- Full iPad simulator suite: **109 passed, 5 skipped, 0 failed** (114 total).
- Separately enabled disposable-backend integration: **3 passed, 0 failed**, covering native edits, AAC upload/reopen, offline remote audio acquisition/local audio reuse, and offline edits syncing to the same account.
- Queue tests cover duplicate requests, active cancellation, retry, persisted in-flight recovery, corrupt PDF, missing/local-only audio and account-generation invalidation.
- Local cold-entry test opens a cached PDF and plays locally created unuploaded audio without an API session; corruption tests preserve source bytes and invalidate visible readiness.
- Download-manager portrait/landscape screenshots were exported and visually reviewed.
- Manual GUI LaunchAgent device-signing build completed with `exit_code=0`. Subsequently installed the signed update on the connected iPad Pro 11-inch (2nd generation) and successfully launched `com.gamma.pdfnotes.ipad` using devicectl; the app was not uninstalled and its data was not cleared. Installation/launch is not a flight-mode acceptance test.

### Remaining acceptance boundaries

Physical iPad flight-mode process relaunch, real Pencil/microphone interactions, OS suspension under memory pressure, disk exhaustion and large-library performance have not been hardware-validated. The live test seeds the PDF through a data request because the test-only URLProtocol bridge does not exercise URLSession download tasks; real-network PDF interruption remains a device acceptance boundary. No production accounts or user recordings were used. No commits were pushed.

### Direct sign-in UI correction

The offline header and download manager now provide an actual **Sign in to sync** button. Its same-account password sheet allows cancellation without sign-out and reconnects without closing the current reader. Simulator regression after this correction: **110 passed, 5 skipped, 0 failed**. The form screenshot was reviewed; the signed correction was installed and launched on the connected iPad without uninstalling or clearing its data.
