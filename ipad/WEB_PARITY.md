# Full Gamma Web workspace in the iPad app

## Architecture

After native sign-in, the app opens the actual Gamma Web application in an isolated WKWebView—not a rewrite of individual tools. It receives the native session cookies through WebKit's HTTP cookie store. The server therefore supplies the same React editor, Markdown/math renderer, search, AI, settings and transfer UI as browsers/Desktop.

On an open Web PDF, **Pencil & Audio** flushes queued Web block edits and waits for active saves before handing off the Gamma page/document IDs. The native side checks main-frame origin and deployment path, revalidates the current cookie's user with `/api/session`, and fetches the page to verify its identity. It then opens the existing PDFKit/PencilKit/recording/Replay workspace.

**Full Gamma** returns to the existing Web session after the native outbox drains. It reloads the Web document to avoid saving an old subtree over newly created native blocks. A pending/conflicted native queue blocks return to the Web editor until resolved. Web input is frozen after its final handoff save and unfreezes through reload on return/failure. No cross-platform library duplication or password persistence is introduced.

If a native account has unsynced cached changes at sign-in, the app stays in its native recovery/library view rather than opening a stale Web editor. Use Retry/resolve conflicts, then Full Gamma.

## Feature matrix — reuse versus verified behavior

| Feature | How it is available | Verification boundary |
|---|---|---|
| Markdown editor, headings/lists/tasks/code/tables | Existing Web editor in WKWebView | Same frontend code; composition/IME/touch acceptance remains device-specific |
| Inline/display math, block refs/embeds | Existing Web renderer/editor | Existing Web tests; not a new native renderer |
| Text selection, highlights, figure annotations | Existing Web PDF viewer; also native Text mode with PDFKit selection/color toolbar | Native selection → ordinary Gamma block covered by tests |
| Outliner nesting/reordering, labels/folders/library | Existing Web UI | Drag/keyboard ergonomics may differ on iPad |
| Search, AI chat/model/provider settings, metadata/citations | Existing Web UI/server | Availability depends on server/user permissions and configured providers; no paid AI calls made by tests |
| Import | Web file inputs via WKWebView/system document picker | Individual provider/cloud file behavior requires device testing |
| Export | Same-origin downloads/blob exports routed through WKDownload and system Share/Save to Files | Native handler implemented; each export format still needs device acceptance |
| Pencil, audio recording and Note Replay | Native workspace via Pencil & Audio | Existing native tests; hardware acceptance caveats remain |
| Desktop local Python server/process management | Not available on iPad | Electron's local runtime is desktop-specific; use a Gamma HTTPS server |
| Browser extension install | Separate Connector, not embedded in iOS app | Desktop browser capability, not portable by rendering the Web UI |

This is broad code reuse, not a claim that every browser API and gesture has been tested on iPad. In particular, Web speech recording, OAuth flows opening external browsers, downloads, pop-up handling and clipboard permissions can differ from desktop Chromium. The native recording path remains available.

## Security

The WK datastore is nonpersistent and recreated per native login session. The native message handler accepts only the configured HTTPS origin, matching effective port/deployment path and main frame. External HTTP(S) navigation opens the system browser; arbitrary file/javascript navigation is blocked. Popup dialogs are handled natively. The message handler uses a weak proxy and is removed on teardown. Native session validation, not the message's `user` string, determines account identity.

## Testing

- Real WebKit fixture test exercises script message receipt, rejects embedded-frame handoff and confirms the datastore is nonpersistent.
- Pure origin/payload tests cover origin/port/path boundaries, bounded fields and invalid messages.
- PDFKit selection test converts a real text selection into page-relative Web highlight coordinates and persists a stable UUID block/outbox entry.
- Backend highlight tests cover idempotent creation, ordinary block compatibility, preservation of later Web edits, invalid geometry and authentication.
- Frontend native handoff tests cover identity and bounded Unicode titles; existing frontend builds/tests continue to run.

Live account data, AI calls and full touch flows are not fabricated as tested results. Consult VALIDATION.md for actual runs and deployment status.
