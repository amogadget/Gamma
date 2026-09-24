// The page's live session as a plain state machine — no React, no globals:
// the hook in collaboration/usePageCollab.js wires it to the app (fetch, WebSocket, React state)
// and the node tests drive it with fakes. One session per tab; it
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
import { applyOps, diffTrees, pushOp, seedPositions } from "../shared/model/blockOps.js";

export const TYPING_DEBOUNCE_MS = 350;
export const STRUCTURAL_DEBOUNCE_MS = 80;
export const CURSOR_THROTTLE_MS = 80;
export const RETRY_MS = 3000;
export const MAX_RETRIES = 8;
const SOCKET_OPEN = 1; // WebSocket.OPEN

function pageSession(pageId = "") {
  return {
    pageId, base: [], pos: new Map(), queue: [], timer: null, sending: null,
    inflight: new Map(), deferred: new Map(), retries: 0, seq: 0,
    pending: new Map(), catchingUp: null, reloading: false,
  };
}

const sameCursor = (a, b) => !!a && !!b && a.block === b.block && a.anchor === b.anchor && a.head === b.head;

// deps:
//   clientId              — this tab's id (goes on every batch and the socket URL)
//   api(path, init)       — JSON call under /api; rejects with err.status on
//                           an HTTP error (utils.apiJson)
//   openSocket(pageId)    — a WebSocket-like object for the page's room
//                           (onopen/onmessage/onclose/onerror, send, close,
//                           readyState)
//   keepalivePost(path, body) — fire-and-forget POST while the tab closes
//   opts()                — the live options, read on every use so callers
//                           may pass fresh closures:
//       pageId                        the open page (root block id); "" → idle
//       canWrite                      false in a read-only share view (presence only)
//       onRemoteOps(ops, pageId, pos) apply a batch from another client to the
//                                     tree (pos: the shared id → position map)
//       onReload(pageId)              refetch the tree (a change ops can't express)
//       onStatus(text)                the status line
//   onPeers(peers), onMe(me) — presence changes (the hook's React state)
//   onQueued()                — a local edit was queued (the clone's sync pill shows it as pending)
//   timers                — {set(fn, ms) → id, clear(id)}; default the globals
export function createCollabSession({ clientId, api, openSocket, keepalivePost, opts, onPeers, onMe, onQueued, timers }) {
  const later = timers?.set || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const cancel = timers?.clear || ((id) => globalThis.clearTimeout(id));
  const o = () => opts();

  const st = {
    session: pageSession(),   // queued writes retain their page after navigation
    sessions: new Set(),      // pages with queued or unacknowledged writes
    ws: null,
    wsPage: "",
    backoff: 1000,
    closed: true,
    reconnectTimer: null,
  };
  let peers = [];       // other clients on the page
  let me = { client: clientId, color: 0, connected: false };
  const setPeers = (next) => {
    peers = typeof next === "function" ? next(peers) : next;
    onPeers?.(peers);
  };
  const setMe = (next) => {
    const v = typeof next === "function" ? next(me) : next;
    if (v === me) return;
    me = v;
    onMe?.(me);
  };

  // --- presence out: state ---------------------------------------------------

  // latest: the caret as last reported by the editor (what a batch carries);
  // last: the caret the others were last told about (standalone or on a
  // batch); pending: a standalone send waiting for the throttle / a flush.
  const cursor = { latest: null, last: null, pending: null, timer: null };

  // The throttled standalone send. While a batch is queued or in flight the
  // caret waits: the batch carries it, and a standalone message could
  // overtake the batch and be read against text the others don't have yet.
  function armCursor() {
    const c = cursor;
    if (c.timer || !c.pending) return;
    c.timer = later(() => {
      c.timer = null;
      const p = c.pending;
      if (!p) return;
      if (st.session.queue.length || st.session.sending) return; // re-armed once the batch is acked
      c.pending = null;
      if (sameCursor(p, c.last)) return;
      if (!st.ws || st.ws.readyState !== SOCKET_OPEN) return;
      c.last = p;
      try { st.ws.send(JSON.stringify({ t: "cursor", ...p })); } catch {}
    }, CURSOR_THROTTLE_MS);
  }

  // A peer's caret that came with its batch: the positions are in the text
  // the batch produced, so the editor places them fresh (the `rev` bump)
  // rather than mapping an older caret through the change.
  function placePeer(client, cur) {
    if (!client || !cur) return;
    setPeers((prev) => prev.map((p) => (p.client === client
      ? { ...p, block: cur.block || "", anchor: cur.anchor ?? -1, head: cur.head ?? -1, rev: (p.rev || 0) + 1 }
      : p)));
  }

  // Rejected writes remain exportable even after the ordinary resync drops
  // their queue. Never call a disconnect clean merely because a 403 emptied it.
  const rejectedRecovery = [];
  let recoveryOverflow = false;
  function recoverySnapshot() {
    const pages = [...st.sessions].filter(s => s.queue.length || s.sending).map(s => ({
      pageID: s.pageId, ops: [...(s.outgoingOps || []), ...s.queue], tree: s.base,
    }));
    const text = JSON.stringify({ complete: !recoveryOverflow, pages, rejected: rejectedRecovery });
    if (text.length > 8 * 1024 * 1024) return { complete: false, reason: "recovery-too-large", pages: [], rejected: [] };
    return JSON.parse(text);
  }

  // --- outgoing ops ----------------------------------------------------------

  function send(s = st.session) {
    if (s.sending || !s.queue.length) return s.sending;
    const page = s.pageId;
    const ops = s.queue;
    s.outgoingOps = ops;
    s.queue = [];
    if (s.timer) { cancel(s.timer); s.timer = null; }
    // Our caret in the text this batch produces, for the page it belongs to.
    const c = cursor;
    const cur = s === st.session && c.latest ? c.latest : null;
    const p = (async () => {
      let saved = false;
      try {
        const res = await api(`/pages/${encodeURIComponent(page)}/ops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client: clientId, ops, ...(cur ? { cursor: cur } : {}) }),
        });
        s.retries = 0;
        // What the others were told: the caret as the server stored it (it
        // is remapped when a merge moved the text under it).
        if (cur && s === st.session) c.last = res.cursor && res.cursor.block ? res.cursor : cur;
        // The ack: final positions, the text the server actually stored
        // for each content set (a merge onto someone else's change comes
        // back different from what we sent), and the deferred remote sets
        // decided.
        const stored = new Map();
        for (const op of res.ops || []) {
          if ((op.op === "insert" || op.op === "move") && op.position) s.pos.set(op.id, op.position);
          if (op.op === "set" && op.content !== undefined) stored.set(op.id, op.content);
        }
        const ackSeq = res.seq || 0;
        // An ack proves only that this batch committed; earlier remote
        // batches may still be missing. Use the same ordered inbox as WS.
        if (s === st.session) await receive({ ...res, client: clientId });
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
          } else if (stored.has(op.id) && stored.get(op.id) !== op.content) {
            // The server merged our change onto text someone else wrote
            // since our base: their spans and ours both survive. Lands
            // like a remote op — only now that no newer set of ours for the
            // block is queued or in flight (that one's base is the text we
            // sent, so the server patches it onto the merge and its ack
            // brings the whole result).
            late.push({ op: "set", id: op.id, content: stored.get(op.id) });
          }
        }
        if (late.length && s === st.session) {
          s.base = applyOps(s.base, late, page, s.pos);
          o().onRemoteOps?.(late, page, s.pos);
          for (const d of lateCursors) placePeer(d.client, d.cursor);
        }
        saved = true;
      } catch (err) {
        const status = err?.status || 0;
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          // The server refused THIS batch for good (stale ids, a permission
          // change, or a native restore its bounded provenance no longer
          // recognises): resync rather than loop on it. What the user queued
          // WHILE it was out is a separate change and must not go down with it,
          // so the self-contained `set` ops among those are re-queued — a
          // structural op was computed against the tree this reload replaces, so
          // it is reported instead of replayed blind. (Silent loss is the one
          // outcome a refusal must not produce.)
          const rejected = { pageID: page, ops: [...ops, ...s.queue], tree: s.base };
          const size = JSON.stringify([...rejectedRecovery, rejected]).length;
          if (size <= 8 * 1024 * 1024) rejectedRecovery.push(JSON.parse(JSON.stringify(rejected)));
          else recoveryOverflow = true;
          const later = s.queue;
          const kept = later.filter((op) => op.op === "set");
          const dropped = later.length - kept.length;
          s.queue = [];
          s.inflight.clear();
          s.deferred.clear();
          o().onStatus?.(`Save rejected: ${err.message}`
            + (kept.length ? ` — keeping ${kept.length} later edit${kept.length === 1 ? "" : "s"}` : "")
            + (dropped ? ` (${dropped} later structural change${dropped === 1 ? "" : "s"} could not be kept)` : ""));
          if (s === st.session) o().onReload?.(page);
          if (kept.length) enqueue(kept, true, s);
        } else if (s.retries < MAX_RETRIES) {
          s.retries += 1;
          o().onStatus?.(`Save failed: ${err.message} — retrying…`);
          // Put the ops back in front of anything queued since.
          s.queue = [...ops, ...s.queue];
          s.timer = later(() => { s.timer = null; send(s); }, RETRY_MS);
        } else {
          o().onStatus?.(`Save failed: ${err.message}`);
          s.queue = [...ops, ...s.queue]; // preserve for an explicit flush / pagehide
          return false;
        }
      } finally {
        s.sending = null;
        s.outgoingOps = null;
        if (!s.queue.length) st.sessions.delete(s);
      }
      if (s.queue.length && !s.timer) send(s);
      else armCursor(); // a caret move held back while the batch was out
      return saved;
    })();
    s.sending = p;
    return p;
  }

  // `target` defaults to the page on screen; a rejected batch is re-queued on
  // ITS OWN session, which may be a page the user has already left.
  function enqueue(ops, now = false, target = st.session) {
    const s = target;
    st.sessions.add(s);
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
    if (s.timer) cancel(s.timer);
    s.timer = later(() => { s.timer = null; send(s); }, delay);
    onQueued?.();
  }

  // Called by the tree's transition effect. `isLoad`: the transition was a
  // load (or a remote apply) — the tree becomes the new base, nothing is
  // sent; `seq` says which op-log position a fetched tree reflects, so the
  // socket can catch up on what landed between the fetch and its hello.
  // `now`: skip the typing debounce (an editor closed).
  function commit(tree, { isLoad = false, now = false, seq = null } = {}) {
    let s = st.session;
    const page = o().pageId;
    if (!page) return [];
    if (page !== s.pageId) {
      // A new page: its tree is the base, positions come from the server.
      send(s);
      s = st.session = pageSession(page);
      if (cursor.timer) cancel(cursor.timer);
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
        receive({ seq: s.seq });
      }
      return [];
    }
    if (!o().canWrite) { s.base = tree; return []; }
    const ops = diffTrees(s.base, tree, page, s.pos);
    s.base = tree;
    if (ops.length) enqueue(ops, now);
    return ops;
  }

  // Drain queued and in-flight batches, stopping on failure so the normal
  // retry policy takes over. hasPending() reports edits still unsaved.
  async function flush() {
    await Promise.all([...st.sessions].map(async (s) => {
      if (s.timer) { cancel(s.timer); s.timer = null; }
      let saved = await (s.sending || send(s));
      // send() may start the next queued batch before the first promise
      // resolves. Wait for that batch too, even though its queue is now empty.
      while (saved !== false && (s.sending || s.queue.length)) {
        if (s.timer) { cancel(s.timer); s.timer = null; }
        saved = await (s.sending || send(s));
      }
    }));
  }

  function hasPending() {
    return [...st.sessions].some((s) => s.queue.length > 0 || !!s.sending);
  }

  // Tab closing / reloading: a keepalive POST of what is still queued.
  function pagehide() {
    for (const s of st.sessions) {
      if (!s.queue.length) continue;
      const body = JSON.stringify({ client: clientId, ops: s.queue });
      const page = s.pageId;
      s.queue = [];
      try { keepalivePost(`/pages/${encodeURIComponent(page)}/ops`, body); } catch {}
    }
  }

  // --- incoming ---------------------------------------------------------------

  function applyRemoteBatch(msg) {
    const s = st.session;
    const page = s.pageId;
    if (msg.seq > s.seq) s.pending.set(msg.seq, msg);
    while (!s.reloading && s.pending.has(s.seq + 1)) {
      const m = s.pending.get(++s.seq);
      s.pending.delete(s.seq);
      if (m.client === clientId) continue;
      const now = [];
      let held = false;
      for (const op of m.ops || []) {
        if (op.op === "reload") { s.reloading = true; o().onReload?.(page); return; }
        if (op.op === "set" && op.content !== undefined && s.inflight.has(op.id)) {
          // Defer only competing content. Every property patch still applies.
          s.deferred.set(op.id, { op: { op: "set", id: op.id, content: op.content },
            seq: m.seq, client: m.client, cursor: m.cursor || null });
          if (op.props) now.push({ op: "set", id: op.id, props: op.props });
          held = true;
          continue;
        }
        now.push(op);
      }
      if (now.length) {
        s.base = applyOps(s.base, now, page, s.pos);
        o().onRemoteOps?.(now, page, s.pos);
      }
      // Place the caret against the text from this batch; held content's
      // caret waits with it until our write is acknowledged.
      if (m.cursor && !held) placePeer(m.client, m.cursor);
    }
  }

  // After a reconnect: what did we miss?
  function catchUp() {
    const s = st.session;
    const page = s.pageId;
    if (!page) return;
    if (s.catchingUp) return s.catchingUp;
    s.catchingUp = (async () => {
      try {
        const d = await api(`/pages/${encodeURIComponent(page)}/ops?since=${s.seq}`);
        if (st.session !== s) return;
        for (const b of d.batches || []) applyRemoteBatch(b);
        // A newer socket batch may have arrived while this snapshot of the
        // log was being fetched. Recover that gap too.
        if (s.pending.size && !s.reloading) queueMicrotask(() => catchUp());
      } catch (err) {
        if (st.session === s) o().onReload?.(page);
      } finally {
        s.catchingUp = null;
      }
    })();
    return s.catchingUp;
  }

  // The one ordered inbox for HTTP acks and socket batches.
  function receive(msg) {
    applyRemoteBatch(msg);
    const s = st.session;
    if (s.pending.size && !s.reloading) return catchUp();
  }

  // --- the socket -------------------------------------------------------------

  // Open the page's room (closing any other page's first); reconnects with
  // backoff until disconnect().
  function connect(pageId) {
    disconnect();
    st.closed = false;
    const open = () => {
      if (st.closed) return;
      let ws;
      try { ws = openSocket(pageId); } catch { return; }
      st.ws = ws;
      st.wsPage = pageId;
      ws.onopen = () => { st.backoff = 1000; };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const session = st.session;
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
            cursor.last = null;
            if (cursor.latest) { cursor.pending = cursor.latest; armCursor(); }
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
            receive(msg);
            break;
          case "reload":
            if (msg.seq) receive({ ...msg, ops: [{ op: "reload" }] });
            else { session.reloading = true; o().onReload?.(pageId); }
            break;
          default:
        }
      };
      ws.onclose = () => {
        if (st.ws === ws) st.ws = null;
        setMe((m) => (m.connected ? { ...m, connected: false } : m));
        setPeers([]);
        if (st.closed) return;
        st.reconnectTimer = later(open, st.backoff);
        st.backoff = Math.min(st.backoff * 2, 15000);
      };
      ws.onerror = () => {};
    };
    open();
  }

  // Close the socket and stop reconnecting. `clearPresence`: the page went
  // away (home library, read-only nothing) — the peer list empties now
  // rather than at the next hello.
  function disconnect({ clearPresence = false } = {}) {
    st.closed = true;
    if (st.reconnectTimer) { cancel(st.reconnectTimer); st.reconnectTimer = null; }
    if (st.ws) { st.ws.onclose = null; st.ws.close(); st.ws = null; st.wsPage = ""; }
    if (clearPresence) {
      setPeers([]);
      setMe((m) => (m.connected ? { ...m, connected: false } : m));
    }
  }

  // --- presence out -----------------------------------------------------------

  function sendCursor(cur) {
    const c = cursor;
    const next = { block: cur?.block || "", anchor: cur?.anchor ?? -1, head: cur?.head ?? -1 };
    c.latest = next;
    if (sameCursor(next, c.last) && !c.pending) return;
    c.pending = next;
    armCursor();
  }

  return {
    commit, flush, hasPending, recoverySnapshot, sendCursor, pagehide, connect, disconnect,
    get peers() { return peers; },
    get me() { return me; },
  };
}
