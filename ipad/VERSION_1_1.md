# Gamma iPad 1.1

## Fixes

- **Pencil & Audio → Full Gamma:** capture the actual top-visible PDF page and
  normalized displayed-crop X/Y anchor at the return-button press. Identity is
  scoped to the verified account, workspace, page and PDF. Reload installs a
  one-navigation boot request, and the Web reader restores after layout without
  the previous saved position taking over. Superseded or cancelled requests
  cannot later navigate or move the viewport. Restore failures remain explicit
  with a retry action.
- **Disconnect server → On this iPad:** always expose the server/local control,
  without requiring an open PDF. Logged-out Web pages can disconnect. An active
  background reconnect probe is cancelled rather than disabling the control
  indefinitely. Local preflight and recovery writes precede credential clearing;
  server caches and native outboxes are not deleted or reassigned.
- **Unsaved Web edits:** flush collaboration, browser ink and direct page/block
  mutations. Retain refused/failed requests for recovery even if the ordinary
  collaboration queue dropped a permanent 4xx request. Unsupported/failed/incomplete
  flushes require explicit consent before disconnecting. Recovery is opaque JSON,
  bounded and stored in the original server cache, not automatically reapplied.

## Verification

- Mac simulator full suite: **220 passed, 6 skipped, 0 failed**
  (`Version11-2.xcresult`).
- Final WebKit lifecycle + PDF position + disconnect tests and an isolated,
  anonymous live-server login-page probe: **22 passed, 1 skipped, 0 failed**
  (`Version11-LiveBridge.xcresult`). The live probe used no account cookies and
  verified the deployed bridge can flush/disconnect without a PDF or login.
- Frontend full unit suite: **218 passed**. Chrome native handoff/control suite:
  **17 checks passed**, including exact retained/reloaded anchors, cancellation
  during both subtree-fetch stages, no-PDF/logged-out controls and failed-write
  recovery.
- Production Web patch was separately backported onto the live server's existing
  frontend baseline: **161 unit tests** and the native browser suite passed.
  Deployment changes static Web files only. Backend source hash and schema
  version **7** were verified unchanged; no database migration was performed.
- Data-protection class assertions remain enabled on physical iOS. Simulator
  filesystems do not expose that attribute; recovery bytes and scope are still
  tested there. Existing AVAudioSession synchronous-call warnings remain.

## Delivery state

Version **1.1**, build **3**, bundle **net.blitzbuild.gamma**, team **A436A36DDC**
has been archived and its signature verified. The native source matches the
passing simulator implementation. App Store Connect export/upload was attempted
but returned **Failed to Use Accounts** for this team; this is not proof that
Xcode's GUI account is signed out. The upload helper supports team API-key
credentials; no such configuration was available to this run. The user selected
manual Organizer delivery, and this exact **1.1 (3)** archive was opened for that
handoff. Successful upload/processing is still awaiting confirmation.

Do not call this build uploaded, processed, externally testable or published until
Apple provides corresponding evidence. No App Review submission or public release
was requested. No Git commit/push was performed for these changes.
