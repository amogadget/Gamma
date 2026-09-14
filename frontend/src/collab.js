// The page's live session: ONE hook per open page that
//   - turns the block tree's transitions into ops (blockOps.diffTrees) and
//     sends them in debounced batches to POST /api/pages/{id}/ops — the
//     HTTP response is the ack (positions the server re-keyed come back
//     in it); HTTP saves continue when the socket drops, and a closing tab
//     attempts a keepalive flush (queued edits are not durable offline);
//   - holds the page's websocket (/api/ws/page/{id}): incoming `ops`
//     batches from other clients are applied to the tree through
//     onRemoteOps, `reload` refetches, presence (`join` / `leave` /
//     `cursor`) lands in `peers`, and our own cursor goes out throttled —
//     except while we have unflushed edits: then the caret rides on the
//     batch itself (`cursor` on the POST, echoed on the fan-out), so the
//     others place it against the text it belongs to instead of an older
//     copy (offsets past the typed text would land it a few characters
//     off, and stay off once the batch mapped it further);
//   - reconciles concurrent edits of one block: a remote content `set`
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

function pageSession(pageId = "") {
  return {
    pageId, base: [], pos: new Map(), queue: [], timer: null, sending: null,
    inflight: new Map(), deferred: new Map(), retries: 0, seq: 0,
    pending: new Map(), catchingUp: null, reloading: false,
  };
}

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
    session: pageSession(),   // queued writes retain their page after navigation
    sessions: new Set(),      // pages with queued or unacknowledged writes
    ws: null,
    wsPage: "",
    backoff: 1000,
    closed: false,
  });
  const [peers, setPeers] = useState([]);       // other clients on the page
  const [me, setMe] = useState({ client: CLIENT_ID, color: 0, connected: false });
  const receiveRef = useRef(null);

  // --- presence out: state ---------------------------------------------------

  // latest: the caret as last reported by the editor (what a batch carries);
  // last: the caret the others were last told about (standalone or on a
  // batch); pending: a standalone send waiting for the throttle / a flush.
  const cursorRef = useRef({ latest: null, last: null, pending: null, timer: null });

  const sameCursor = (a, b) => !!a && !!b && a.block === b.block && a.anchor === b.anchor && a.head === b.head;

  // The throttled standalone send. While a batch is queued or in flight the
  // caret waits: the batch carries it, and a standalone message could
  // overtake the batch and be read against text the others don't have yet.
  const armCursor = useCallback(() => {
    const c = cursorRef.current;
    if (c.timer || !c.pending) return;
    c.timer = setTimeout(() => {
      c.timer = null;
      const s = st.current;
      const p = c.pending;
      if (!p) return;
      if (s.session.queue.length || s.session.sending) return; // re-armed once the batch is acked
      c.pending = null;
      if (sameCursor(p, c.last)) return;
      if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;
      c.last = p;
      try { s.ws.send(JSON.stringify({ t: "cursor", ...p })); } catch {}
    }, CURSOR_THROTTLE_MS);
  }, []);

  // A peer's caret that came with its batch: the positions are in the text
  // the batch produced, so the editor places them fresh (the `rev` bump)
  // rather than mapping an older caret through the change.
  const placePeer = useCallback((client, cursor) => {
    if (!client || !cursor) return;
    setPeers((prev) => prev.map((p) => (p.client === client
      ? { ...p, block: cursor.block || "", anchor: cursor.anchor ?? -1, head: cursor.head ?? -1, rev: (p.rev || 0) + 1 }
      : p)));
  }, []);

  // --- outgoing ops ----------------------------------------------------------

  const send = useCallback(async (s = st.current.session) => {
    if (s.sending || !s.queue.length) return s.sending;
    const page = s.pageId;
    const ops = s.queue;
    s.queue = [];
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    // Our caret in the text this batch produces, for the page it belongs to.
    const c = cursorRef.current;
    const cursor = s === st.current.session && c.latest ? c.latest : null;
    const p = (async () => {
      let saved = false;
      try {
        const res = await apiJson(`${API}/pages/${encodeURIComponent(page)}/ops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client: CLIENT_ID, ops, ...(cursor ? { cursor } : {}) }),
        });
        s.retries = 0;
        if (cursor && s === st.current.session) c.last = cursor;
        // The ack: final positions, and the deferred remote sets decided.
        for (const op of res.ops || []) {
          if ((op.op === "insert" || op.op === "move") && op.position) s.pos.set(op.id, op.position);
        }
        const ackSeq = res.seq || 0;
        // An ack proves only that this batch committed; earlier remote
        // batches may still be missing. Use the same ordered inbox as WS.
        if (s === st.current.session) await receiveRef.current?.({ ...res, client: CLIENT_ID });
        const late = [], lateCursors = [];
        for (const op of ops) {
          if (op.op !== "set" || op.content === undefined) continue;
          const n = (s.inflight.get(op.id) || 1) - 1;
          if (n > 0) { s.inflight.set(op.id, n); continue; }
          s.inflight.delete(op.id);
          const d = s.deferred.get(op.id);
          s.deferred.delete(op.id);
          if (d && d.seq > ackSeq) { // theirs is newer: it wins
            late.push(d.op);
            if (d.cursor) lateCursors.push(d);
          }
        }
        if (late.length && s === st.current.session) {
          s.base = applyOps(s.base, late, page, s.pos);
          o.current.onRemoteOps?.(late, page, s.pos);
          for (const d of lateCursors) placePeer(d.client, d.cursor);
        }
        saved = true;
      } catch (err) {
        const status = err?.status || 0;
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          // The server refused the batch (stale ids, a permission change):
          // resync rather than loop on it.
          o.current.onStatus?.(`Save rejected: ${err.message}`);
          s.queue = [];
          s.inflight.clear();
          s.deferred.clear();
          if (s === st.current.session) o.current.onReload?.(page);
        } else if (s.retries < MAX_RETRIES) {
          s.retries += 1;
          o.current.onStatus?.(`Save failed: ${err.message} — retrying…`);
          // Put the ops back in front of anything queued since.
          s.queue = [...ops, ...s.queue];
          s.timer = setTimeout(() => { s.timer = null; send(s); }, RETRY_MS);
        } else {
          o.current.onStatus?.(`Save failed: ${err.message}`);
          s.queue = [...ops, ...s.queue]; // preserve for an explicit flush / pagehide
          return false;
        }
      } finally {
        s.sending = null;
        if (!s.queue.length) st.current.sessions.delete(s);
      }
      if (s.queue.length && !s.timer) send(s);
      else armCursor(); // a caret move held back while the batch was out
      return saved;
    })();
    s.sending = p;
    return p;
  }, []);

  const enqueue = useCallback((ops, now = false) => {
    const s = st.current.session;
    st.current.sessions.add(s);
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
    s.timer = setTimeout(() => { s.timer = null; send(s); }, delay);
  }, [send]);

  // Called by the tree's transition effect. `isLoad`: the transition was a
  // load (or a remote apply) — the tree becomes the new base, nothing is
  // sent; `seq` says which op-log position a fetched tree reflects, so the
  // socket can catch up on what landed between the fetch and its hello.
  // `now`: skip the typing debounce (an editor closed).
  const commit = useCallback((tree, { isLoad = false, now = false, seq = null } = {}) => {
    let s = st.current.session;
    const page = o.current.pageId;
    if (!page) return [];
    if (page !== s.pageId) {
      // A new page: its tree is the base, positions come from the server.
      send(s);
      s = st.current.session = pageSession(page);
      const cursor = cursorRef.current;
      clearTimeout(cursor.timer);
      cursor.latest = cursor.last = cursor.pending = cursor.timer = null;
      s.seq = seq || 0;
      seedPositions(tree, s.pos);
      s.base = tree;
      return [];
    }
    if (isLoad) {
      seedPositions(tree, s.pos);
      s.base = tree;
      if (seq != null) {
        s.seq = Math.max(s.seq, seq);
        for (const n of s.pending.keys()) if (n <= s.seq) s.pending.delete(n);
        s.reloading = false;
        receiveRef.current?.({ seq: s.seq });
      }
      return [];
    }
    if (!o.current.canWrite) { s.base = tree; return []; }
    const ops = diffTrees(s.base, tree, page, s.pos);
    s.base = tree;
    if (ops.length) enqueue(ops, now);
    return ops;
  }, [enqueue, send]);

  // Drain queued and in-flight batches, stopping on failure so the normal
  // retry policy takes over. hasPending() reports edits still unsaved.
  const flush = useCallback(async () => {
    await Promise.all([...st.current.sessions].map(async (s) => {
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      let saved = await (s.sending || send(s));
      // send() may start the next queued batch before the first promise
      // resolves. Wait for that batch too, even though its queue is now empty.
      while (saved !== false && (s.sending || s.queue.length)) {
        if (s.timer) { clearTimeout(s.timer); s.timer = null; }
        saved = await (s.sending || send(s));
      }
    }));
  }, [send]);

  const hasPending = useCallback(() => {
    return [...st.current.sessions].some((s) => s.queue.length > 0 || !!s.sending);
  }, []);

  // Tab closing / reloading: a keepalive POST of what is still queued.
  useEffect(() => {
    const onHide = () => {
      for (const s of st.current.sessions) {
        if (!s.queue.length) continue;
        const body = JSON.stringify({ client: CLIENT_ID, ops: s.queue });
        const page = s.pageId;
        s.queue = [];
        try {
          fetch(withShare(`${API}/pages/${encodeURIComponent(page)}/ops`), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body, keepalive: true, credentials: "include",
          }).catch(() => {});
        } catch {}
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // --- incoming ---------------------------------------------------------------

  const applyRemoteBatch = useCallback((msg) => {
    const s = st.current.session;
    const page = s.pageId;
    if (msg.seq > s.seq) s.pending.set(msg.seq, msg);
    while (!s.reloading && s.pending.has(s.seq + 1)) {
      const msg = s.pending.get(++s.seq);
      s.pending.delete(s.seq);
      if (msg.client === CLIENT_ID) continue;
      const now = [];
      let held = false;
      for (const op of msg.ops || []) {
        if (op.op === "reload") { s.reloading = true; o.current.onReload?.(page); return; }
        if (op.op === "set" && op.content !== undefined && s.inflight.has(op.id)) {
          // Defer only competing content. Every property patch still applies.
          s.deferred.set(op.id, { op: { op: "set", id: op.id, content: op.content },
            seq: msg.seq, client: msg.client, cursor: msg.cursor || null });
          if (op.props) now.push({ op: "set", id: op.id, props: op.props });
          held = true;
          continue;
        }
        now.push(op);
      }
      if (now.length) {
        s.base = applyOps(s.base, now, page, s.pos);
        o.current.onRemoteOps?.(now, page, s.pos);
      }
      // Place the caret against the text from this batch; held content's
      // caret waits with it until our write is acknowledged.
      if (msg.cursor && !held) placePeer(msg.client, msg.cursor);
    }
  }, [placePeer]);

  // After a reconnect: what did we miss?
  const catchUp = useCallback(async () => {
    const s = st.current.session;
    const page = s.pageId;
    if (!page) return;
    if (s.catchingUp) return s.catchingUp;
    s.catchingUp = (async () => {
      try {
        const d = await apiJson(`${API}/pages/${encodeURIComponent(page)}/ops?since=${s.seq}`);
        if (st.current.session !== s) return;
        for (const b of d.batches || []) applyRemoteBatch(b);
        // A newer socket batch may have arrived while this snapshot of the
        // log was being fetched. Recover that gap too.
        if (s.pending.size && !s.reloading) queueMicrotask(() => catchUp());
      } catch (err) {
        if (st.current.session === s) o.current.onReload?.(page);
      } finally {
        s.catchingUp = null;
      }
    })();
    return s.catchingUp;
  }, [applyRemoteBatch]);

  receiveRef.current = (msg) => {
    applyRemoteBatch(msg);
    const s = st.current.session;
    if (s.pending.size && !s.reloading) return catchUp();
  };

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
    const open = () => {
      if (s.closed) return;
      try { ws = new WebSocket(socketUrl(pageId)); } catch { return; }
      s.ws = ws;
      s.wsPage = pageId;
      ws.onopen = () => { s.backoff = 1000; };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const session = s.session;
        if (session.pageId !== pageId && msg.t !== "hello") return;
        switch (msg.t) {
          case "hello": {
            setMe({ client: msg.client, color: msg.color, connected: true });
            setPeers((msg.peers || []).filter((p) => p.client !== msg.client));
            // The tree was fetched before the socket opened (its seq came
            // with it); anything that landed in between is in the log.
            if (session.pageId === pageId && (msg.seq || 0) > session.seq) catchUp();
            // A (re)join starts with empty presence on the server: tell
            // the room where we are.
            const c = cursorRef.current;
            c.last = null;
            if (c.latest) { c.pending = c.latest; armCursor(); }
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
              ? { ...p, block: msg.block, anchor: msg.anchor, head: msg.head, rev: (p.rev || 0) + 1 } : p)));
            break;
          case "ops":
            receiveRef.current(msg);
            break;
          case "reload":
            if (msg.seq) receiveRef.current({ ...msg, ops: [{ op: "reload" }] });
            else { session.reloading = true; o.current.onReload?.(pageId); }
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
  }, [pageId, enabled, applyRemoteBatch, catchUp, armCursor]);

  // --- presence out -----------------------------------------------------------

  const sendCursor = useCallback((cur) => {
    const c = cursorRef.current;
    const next = { block: cur?.block || "", anchor: cur?.anchor ?? -1, head: cur?.head ?? -1 };
    c.latest = next;
    if (sameCursor(next, c.last) && !c.pending) return;
    c.pending = next;
    armCursor();
  }, [armCursor]);

  return { commit, flush, hasPending, peers, me, sendCursor };
}
