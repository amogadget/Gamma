// The page's live session: ONE hook per open page that
//   - turns the block tree's transitions into ops (blockOps.diffTrees) and
//     sends them in debounced batches to POST /api/pages/{id}/ops — the
//     HTTP response is the ack (positions the server re-keyed come back
//     in it); a dropped socket never loses an edit, and a tab closing
//     flushes with a keepalive fetch;
//   - holds the page's websocket (/api/ws/page/{id}): incoming `ops`
//     batches from other clients are applied to the tree through
//     onRemoteOps, `reload` refetches, presence (`join` / `leave` /
//     `cursor`) lands in `peers`, and our own cursor goes out throttled;
//   - reconciles concurrent edits of ONE block Figma-style: a remote `set`
//     for a block we have an unacknowledged `set` in flight for is deferred,
//     then applied only if the server ordered it AFTER ours (its seq is
//     higher than our ack's) — otherwise ours is the newer value and it is
//     dropped;
//   - catches up after a reconnect from the op log (GET …/ops?since=), or
//     asks for a reload when the log no longer reaches back.
//
// The "base" tree is what the server is known to hold from this tab's point
// of view: every commit diffs against it and advances it; remote ops advance
// it too. Positions live in one Map shared with blockOps.
import { useCallback, useEffect, useRef, useState } from "react";
import { API, apiJson, makeId, withShare, withWorkspace } from "./utils";
import { applyOps, diffTrees, pushOp, seedPositions } from "./blockOps";

export const CLIENT_ID = makeId().slice(0, 10); // one per tab

const TYPING_DEBOUNCE_MS = 350;
const STRUCTURAL_DEBOUNCE_MS = 80;
const CURSOR_THROTTLE_MS = 80;
const RETRY_MS = 3000;
const MAX_RETRIES = 8;

function socketUrl(pageId) {
  // A share view carries its token (the share names the workspace); a
  // member's socket carries ?ws= — the handshake has no headers to inject.
  const base = `${API}/ws/page/${encodeURIComponent(pageId)}?client=${CLIENT_ID}`;
  const path = withShare(base) === base ? withWorkspace(base) : withShare(base);
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
export function usePageCollab(opts) {
  const o = useRef(opts);
  o.current = opts;
  const { pageId, enabled } = opts;

  const st = useRef({
    pageId: "",
    base: [],                 // the tree the server is known to hold
    pos: new Map(),           // id → fractional key
    queue: [],                // ops not yet sent (for st.pageId)
    queuePage: "",
    timer: null,
    sending: null,            // the in-flight POST (promise)
    inflight: new Map(),      // id → count of unacked content sets
    deferred: new Map(),      // id → {op, seq}: remote sets held back while ours is in flight
    retries: 0,
    seq: 0,                   // last seq seen for st.pageId
    ws: null,
    wsPage: "",
    backoff: 1000,
    closed: false,
  });
  const [peers, setPeers] = useState([]);       // other clients on the page
  const [me, setMe] = useState({ client: CLIENT_ID, color: 0, connected: false });

  // --- outgoing ops ----------------------------------------------------------

  const send = useCallback(async () => {
    const s = st.current;
    if (s.sending || !s.queue.length) return s.sending;
    const page = s.queuePage;
    const ops = s.queue;
    s.queue = [];
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    const p = (async () => {
      try {
        const res = await apiJson(`${API}/pages/${encodeURIComponent(page)}/ops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client: CLIENT_ID, ops }),
        });
        s.retries = 0;
        // The ack: final positions, and the deferred remote sets decided.
        for (const op of res.ops || []) {
          if ((op.op === "insert" || op.op === "move") && op.position) s.pos.set(op.id, op.position);
        }
        const ackSeq = res.seq || 0;
        if (page === s.pageId && ackSeq > s.seq) s.seq = ackSeq;
        const late = [];
        for (const op of ops) {
          if (op.op !== "set" || op.content === undefined) continue;
          const n = (s.inflight.get(op.id) || 1) - 1;
          if (n > 0) { s.inflight.set(op.id, n); continue; }
          s.inflight.delete(op.id);
          const d = s.deferred.get(op.id);
          s.deferred.delete(op.id);
          if (d && d.seq > ackSeq) late.push(d.op); // theirs is newer: it wins
        }
        if (late.length && page === s.pageId) {
          s.base = applyOps(s.base, late, page, s.pos);
          o.current.onRemoteOps?.(late, page, s.pos);
        }
      } catch (err) {
        for (const op of ops) {
          if (op.op === "set" && op.content !== undefined) {
            const n = (s.inflight.get(op.id) || 1) - 1;
            if (n > 0) s.inflight.set(op.id, n); else s.inflight.delete(op.id);
          }
        }
        const status = err?.status || 0;
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          // The server refused the batch (stale ids, a permission change):
          // resync rather than loop on it.
          o.current.onStatus?.(`Save rejected: ${err.message}`);
          o.current.onReload?.(page);
        } else if (s.retries < MAX_RETRIES) {
          s.retries += 1;
          o.current.onStatus?.(`Save failed: ${err.message} — retrying…`);
          // Put the ops back in front of anything queued since.
          if (s.queuePage === page || !s.queue.length) {
            s.queuePage = page;
            s.queue = [...ops, ...s.queue];
          }
          s.timer = setTimeout(() => { s.timer = null; send(); }, RETRY_MS);
        } else {
          o.current.onStatus?.(`Save failed: ${err.message}`);
        }
      } finally {
        s.sending = null;
      }
      if (s.queue.length && !s.timer) send();
    })();
    s.sending = p;
    return p;
  }, []);

  const enqueue = useCallback((page, ops, now = false) => {
    const s = st.current;
    if (s.queue.length && s.queuePage !== page) {
      // Ops for a page we already left: send them first, on their own.
      send();
    }
    s.queuePage = page;
    for (const op of ops) {
      // inflight counts queued-or-sent set ops per block; a keystroke that
      // folds into the set already queued adds nothing (the ack decrements
      // once per op in the batch, so the two must agree).
      const merged = pushOp(s.queue, op);
      if (op.op === "set" && op.content !== undefined && !merged) {
        s.inflight.set(op.id, (s.inflight.get(op.id) || 0) + 1);
      }
    }
    const structural = ops.some((op) => op.op !== "set");
    const delay = now ? 0 : structural ? STRUCTURAL_DEBOUNCE_MS : TYPING_DEBOUNCE_MS;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; send(); }, delay);
  }, [send]);

  // Called by the tree's transition effect. `isLoad`: the transition was a
  // load (or a remote apply) — the tree becomes the new base, nothing is
  // sent; `seq` says which op-log position a fetched tree reflects, so the
  // socket can catch up on what landed between the fetch and its hello.
  // `now`: skip the typing debounce (an editor closed).
  const commit = useCallback((tree, { isLoad = false, now = false, seq = null } = {}) => {
    const s = st.current;
    const page = o.current.pageId;
    if (!page) return [];
    if (page !== s.pageId) {
      // A new page: its tree is the base, positions come from the server.
      s.pageId = page;
      s.pos = new Map();
      s.inflight.clear();
      s.deferred.clear();
      s.seq = seq || 0;
      seedPositions(tree, s.pos);
      s.base = tree;
      return [];
    }
    if (isLoad) {
      seedPositions(tree, s.pos);
      s.base = tree;
      if (seq != null && seq > s.seq) s.seq = seq;
      return [];
    }
    if (!o.current.canWrite) { s.base = tree; return []; }
    const ops = diffTrees(s.base, tree, page, s.pos);
    s.base = tree;
    if (ops.length) enqueue(page, ops, now);
    return ops;
  }, [enqueue]);

  // Send everything queued now; resolves when the batch is acknowledged.
  const flush = useCallback(async () => {
    const s = st.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (s.sending) await s.sending;
    if (s.queue.length) await send();
  }, [send]);

  const hasPending = useCallback(() => {
    const s = st.current;
    return s.queue.length > 0 || !!s.sending;
  }, []);

  // Tab closing / reloading: a keepalive POST of what is still queued.
  useEffect(() => {
    const onHide = () => {
      const s = st.current;
      if (!s.queue.length) return;
      const body = JSON.stringify({ client: CLIENT_ID, ops: s.queue });
      const page = s.queuePage;
      s.queue = [];
      try {
        fetch(withShare(`${API}/pages/${encodeURIComponent(page)}/ops`), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body, keepalive: true, credentials: "include",
        }).catch(() => {});
      } catch {}
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // --- incoming ---------------------------------------------------------------

  const applyRemoteBatch = useCallback((msg) => {
    const s = st.current;
    const page = s.pageId;
    if (msg.seq <= s.seq) return; // already have it (our own ack, a replay)
    s.seq = msg.seq;
    if (msg.client === CLIENT_ID) return;
    const now = [];
    for (const op of msg.ops || []) {
      if (op.op === "reload") { o.current.onReload?.(page); return; }
      if (op.op === "set" && op.content !== undefined && s.inflight.has(op.id)) {
        s.deferred.set(op.id, { op, seq: msg.seq });
        continue;
      }
      now.push(op);
    }
    if (!now.length) return;
    s.base = applyOps(s.base, now, page, s.pos);
    o.current.onRemoteOps?.(now, page, s.pos);
  }, []);

  // After a reconnect: what did we miss?
  const catchUp = useCallback(async () => {
    const s = st.current;
    const page = s.pageId;
    if (!page) return;
    try {
      const d = await apiJson(`${API}/pages/${encodeURIComponent(page)}/ops?since=${s.seq}`);
      if (s.pageId !== page) return;
      for (const b of d.batches || []) applyRemoteBatch(b);
      if (d.seq > s.seq) s.seq = d.seq;
    } catch (err) {
      if (s.pageId === page) o.current.onReload?.(page);
    }
  }, [applyRemoteBatch]);

  useEffect(() => {
    const s = st.current;
    s.closed = false;
    if (!enabled || !pageId) {
      if (s.ws) { s.ws.onclose = null; s.ws.close(); s.ws = null; s.wsPage = ""; }
      setPeers([]);
      setMe((m) => (m.connected ? { ...m, connected: false } : m));
      return;
    }
    let ws = null;
    let reconnectTimer = null;
    let first = true;
    const open = () => {
      if (s.closed) return;
      try { ws = new WebSocket(socketUrl(pageId)); } catch { return; }
      s.ws = ws;
      s.wsPage = pageId;
      ws.onopen = () => { s.backoff = 1000; };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (s.pageId !== pageId && msg.t !== "hello") return;
        switch (msg.t) {
          case "hello": {
            setMe({ client: msg.client, color: msg.color, connected: true });
            setPeers((msg.peers || []).filter((p) => p.client !== msg.client));
            // The tree was fetched before the socket opened (its seq came
            // with it); anything that landed in between is in the log.
            if (s.pageId === pageId && (msg.seq || 0) > s.seq) catchUp();
            first = false;
            break;
          }
          case "join":
            setPeers((prev) => [...prev.filter((p) => p.client !== msg.peer.client), msg.peer]);
            break;
          case "leave":
            setPeers((prev) => prev.filter((p) => p.client !== msg.client));
            break;
          case "cursor":
            setPeers((prev) => prev.map((p) => (p.client === msg.client
              ? { ...p, block: msg.block, anchor: msg.anchor, head: msg.head } : p)));
            break;
          case "ops":
            applyRemoteBatch(msg);
            break;
          case "reload":
            if (msg.seq && msg.seq > s.seq) s.seq = msg.seq;
            o.current.onReload?.(pageId);
            break;
          default:
        }
      };
      ws.onclose = () => {
        if (s.ws === ws) s.ws = null;
        setMe((m) => (m.connected ? { ...m, connected: false } : m));
        setPeers([]);
        if (s.closed) return;
        reconnectTimer = setTimeout(open, s.backoff);
        s.backoff = Math.min(s.backoff * 2, 15000);
      };
      ws.onerror = () => {};
    };
    open();
    return () => {
      s.closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { ws.onclose = null; ws.close(); }
      if (s.ws === ws) { s.ws = null; s.wsPage = ""; }
    };
  }, [pageId, enabled, applyRemoteBatch, catchUp]);

  // --- presence out -----------------------------------------------------------

  const cursorRef = useRef({ last: null, timer: null, pending: null });
  const sendCursor = useCallback((cur) => {
    const c = cursorRef.current;
    const next = { block: cur?.block || "", anchor: cur?.anchor ?? -1, head: cur?.head ?? -1 };
    const l = c.last;
    if (l && l.block === next.block && l.anchor === next.anchor && l.head === next.head) return;
    c.pending = next;
    if (c.timer) return;
    c.timer = setTimeout(() => {
      c.timer = null;
      const s = st.current;
      const p = c.pending;
      c.pending = null;
      if (!p || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
      c.last = p;
      try { s.ws.send(JSON.stringify({ t: "cursor", ...p })); } catch {}
    }, CURSOR_THROTTLE_MS);
  }, []);

  return { commit, flush, hasPending, peers, me, sendCursor };
}
