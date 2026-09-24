// usePageCollab: the page's live session (collabSession.js — the state
// machine: op batches out, remote ops and presence in, same-block
// reconciliation, catch-up) wired to the app. ONE hook per open page. This
// file owns only what needs the browser or React: the fetch wrapper, the
// socket URL (share token / workspace), the keepalive POST on pagehide, and
// `peers` / `me` as React state.
import { useEffect, useRef, useState } from "react";
import { API, apiJson, getLinkName, makeId, withShare, withWorkspace } from "../shared/lib/utils";
import { createCollabSession } from "./collabSession";

export const CLIENT_ID = makeId().slice(0, 10); // one per tab

function socketUrl(pageId) {
  // A share view carries its token (the share names the workspace); a
  // member's socket carries ?ws= — the handshake has no headers to inject.
  const base = `${API}/ws/page/${encodeURIComponent(pageId)}?client=${CLIENT_ID}`;
  let path = withShare(base) === base ? withWorkspace(base) : withShare(base);
  // A visitor without an account joins under its display name (presence).
  if (path !== base && getLinkName()) path += `&name=${encodeURIComponent(getLinkName())}`;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

// opts (read through a ref, so callers may pass fresh closures):
//   pageId        — the open page (root block id); "" / null → idle
//   enabled       — false on the home library
//   canWrite      — false in a read-only share view (presence only)
//   onRemoteOps(ops, pageId, pos) — apply a batch from another client to the
//                 tree (pos: the shared id → position map blockOps needs)
//   onReload(pageId)          — refetch the tree (a change ops can't express)
//   onStatus(text)            — the status line
// Returns the session's commit/flush/hasPending/sendCursor, `peers`, `me`,
// and `reconnect` (reopen the socket — after a display-name change, since the
// name travels in the handshake).
export function usePageCollab(opts) {
  const o = useRef(opts);
  o.current = opts;
  const { pageId, enabled } = opts;
  const [peers, setPeers] = useState([]);       // other clients on the page
  const [me, setMe] = useState({ client: CLIENT_ID, color: 0, connected: false });

  const ref = useRef(null);
  if (!ref.current) {
    ref.current = createCollabSession({
      clientId: CLIENT_ID,
      api: (path, init) => apiJson(`${API}${path}`, init),
      openSocket: (id) => new WebSocket(socketUrl(id)),
      keepalivePost: (path, body) => {
        fetch(withShare(`${API}${path}`), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body, keepalive: true, credentials: "include",
        }).catch(() => {});
      },
      opts: () => o.current,
      onPeers: setPeers,
      onMe: setMe,
      // a clone's sync pill (MirrorPopover) marks local edits as not pushed yet
      onQueued: () => window.dispatchEvent(new CustomEvent("gamma:local-edit")),
    });
  }
  const session = ref.current;

  // Tab closing / reloading: a keepalive POST of what is still queued.
  useEffect(() => {
    const onHide = () => session.pagehide();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [session]);

  useEffect(() => {
    if (!enabled || !pageId) { session.disconnect({ clearPresence: true }); return; }
    session.connect(pageId);
    return () => session.disconnect();
  }, [session, pageId, enabled]);

  return {
    commit: session.commit, flush: session.flush, hasPending: session.hasPending,
    recoverySnapshot: session.recoverySnapshot, peers, me,
    sendCursor: session.sendCursor,
    reconnect: () => { if (enabled && pageId) session.connect(pageId); },
  };
}
