# GammaWebWorkspace

`GammaWebWorkspace` is the reusable iPad web surface. It creates an isolated,
non-persistent `WKWebsiteDataStore`, installs the caller's authenticated cookies
before loading `serverURL`, and exposes the exact bridge `gammaNative`.

```swift
GammaWebWorkspace(serverURL: url, cookies: cookies, sessionID: accountID,
  reloadToken: reloadID,
  onOpenPDF: { request, currentCookies in /* verify server session, then switch */ },
  onError: { message in /* present app error */ })
```

The `openPDF` bridge accepts only a main-frame message from the configured
scheme/host/effective port and deployment-path prefix. `pageID`, `docID`,
`title`, and `user` are bounded strings. The `user` field is display metadata,
not authentication: the parent must verify the server session using the returned
current cookies before opening a native reader. `sessionID` is an identity token
for the parent to use with SwiftUI `.id(sessionID)` when changing accounts;
that recreates the isolated web session. When returning from native editing,
flush the native outbox and change `reloadToken`; this reloads the existing web
view without destroying its cookies or non-persistent storage, preventing a
stale web subtree from deleting newly created native blocks.

Same-origin navigation remains in the web view. Other HTTP(S) links open in the
system browser; other schemes are rejected. Non-showable responses and web
exports are downloaded to a uniquely named temporary file and presented through
the system share sheet (including Save to Files). JavaScript alert, confirm, and
prompt use native alert controllers. `window.__GAMMA_IPAD__` is set at document
start so the frontend may offer native PDF opening.

The workspace never persists or extracts passwords, does not weaken TLS, and
does not allow arbitrary `file:`, `data:`, or `javascript:` navigation. The
parent remains responsible for cookie acquisition, account/session verification,
and deciding whether an `openPDF` request is authorized. Temporary download
files are owned by the share sheet and should be cleaned up by the OS.
