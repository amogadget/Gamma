// The page session's transport logic over fakes for HTTP, the socket and
// timers: ordering of acks and socket batches, same-block reconciliation,
// retries, navigation during a save, presence and the caret throttle. No
// React, no DOM — collaboration/usePageCollab.js is a thin wrapper around this; browser behaviour
// is the e2e collab scenario.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps } from "../src/shared/model/blockOps.js";
import { MAX_RETRIES, RETRY_MS, createCollabSession } from "../src/collaboration/collabSession.js";

const ME = "this-client";
const block = (id, content = id, properties = {}) => ({ id, content, properties, children: [], position: "a0" });
const batch = (seq, ops, client = "other") => ({ seq, ops, client });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// A session over fakes; `api(path, init)` answers the HTTP calls. Timers
// never fire on their own: h.fire() runs whatever is armed.
function setup(t, api, { canWrite = true, connect = true } = {}) {
  const h = { calls: [], remote: [], reloads: [], status: [], keepalive: [], sockets: [], timers: new Map(), peers: [], me: null };
  let timerId = 0;
  const options = {
    pageId: "page-a", canWrite,
    onRemoteOps: (ops, page, pos) => { h.remote.push(...ops); h.tree = applyOps(h.tree, ops, page, pos); },
    onReload: (page) => h.reloads.push(page),
    onStatus: (text) => h.status.push(text),
  };
  h.session = createCollabSession({
    clientId: ME,
    api: (path, init) => { h.calls.push({ url: path, body: init?.body ? JSON.parse(init.body) : null }); return api(path, init); },
    openSocket: () => {
      const ws = { readyState: 1, sent: [], closed: false, send(m) { ws.sent.push(JSON.parse(m)); }, close() { ws.closed = true; } };
      h.sockets.push(ws);
      return ws;
    },
    keepalivePost: (path, body) => h.keepalive.push({ path, body: JSON.parse(body) }),
    opts: () => options,
    onPeers: (p) => { h.peers = p; },
    onMe: (m) => { h.me = m; },
    timers: { set: (fn, ms) => { h.timers.set(++timerId, { fn, ms }); return timerId; }, clear: (id) => h.timers.delete(id) },
  });
  h.options = options;
  h.socket = () => h.sockets[h.sockets.length - 1];
  h.message = (msg) => h.socket().onmessage({ data: JSON.stringify(msg) });
  h.ops = (msg) => h.message({ t: "ops", ...msg });
  h.fire = () => { const due = [...h.timers.values()]; h.timers.clear(); for (const { fn } of due) fn(); };
  h.load = (page, tree) => { options.pageId = page; h.tree = tree; h.session.commit(tree, { isLoad: true, seq: 0 }); };
  h.edit = (tree) => { h.tree = tree; h.session.commit(tree); };
  h.load("page-a", [block("a"), { ...block("b"), position: "a1" }]);
  if (connect) h.session.connect("page-a");
  t.after(() => h.session.disconnect());
  return h;
}

test("recovery includes old-page in-flight writes and is detached from live trees", async (t) => {
  const ack = deferred();
  const h = setup(t, () => ack.promise);
  h.edit([block("a", "unsaved old page")]);
  h.load("page-b", [block("c")]);
  h.edit([block("c", "unsaved new page")]);
  const recovery = h.session.recoverySnapshot();
  assert.equal(recovery.complete, true);
  assert.deepEqual(recovery.pages.map(p => p.pageID).sort(), ["page-a", "page-b"]);
  assert(recovery.pages.find(p => p.pageID === "page-a").ops.some(op => op.content === "unsaved old page"));
  recovery.pages[0].tree[0].content = "mutated export";
  assert.notEqual(h.session.recoverySnapshot().pages[0].tree[0].content, "mutated export");
  ack.resolve({ seq: 0, ops: [] });
  await h.session.flush();
});

test("permanent save refusals stay recoverable after the normal queue is emptied", async (t) => {
  const h = setup(t, async () => { throw Object.assign(Error("permission lost"), {status:403}); });
  h.edit([block("a", "must not disappear")]);
  await h.session.flush();
  assert.equal(h.session.hasPending(), false);
  const recovery = h.session.recoverySnapshot();
  assert.equal(recovery.complete, true);
  assert.equal(recovery.rejected[0].pageID, "page-a");
  assert(recovery.rejected[0].ops.some(op => op.content === "must not disappear"));
});

test("HTTP ack catches up missing remote edits before advancing the sequence", async (t) => {
  const remote = batch(1, [{ op: "set", id: "b", content: "remote b" }]);
  const own = batch(2, [{ op: "set", id: "a", content: "my a" }], ME);
  const h = setup(t, async (url) => (url.includes("?since=") ? { seq: 2, batches: [remote, own] } : own));
  h.edit([block("a", "my a"), block("b")]);
  await h.session.flush();
  assert.ok(h.calls.some((c) => c.url.endsWith("?since=0")));
  assert.equal(h.tree.find((b) => b.id === "b").content, "remote b");
  assert.equal(h.session.hasPending(), false);
});

test("out-of-order socket batches wait for missing operations", async (t) => {
  const log = deferred();
  const h = setup(t, () => log.promise);
  const first = batch(1, [{ op: "set", id: "a", content: "first" }]);
  const second = batch(2, [{ op: "set", id: "a", content: "second" }]);
  h.ops(second);
  assert.equal(h.tree[0].content, "a");
  log.resolve({ seq: 2, batches: [first, second] });
  await settle();
  assert.deepEqual(h.remote.map((op) => op.content), ["first", "second"]);
});

test("deferred content preserves every remote property patch", async (t) => {
  const ack = deferred();
  const h = setup(t, () => ack.promise);
  h.edit([block("a", "mine"), block("b")]);
  const saving = h.session.flush();
  h.ops(batch(1, [{ op: "set", id: "a", content: "theirs 1", props: { color: "red" } }]));
  h.ops(batch(2, [{ op: "set", id: "a", content: "theirs 2", props: { folder: "lab" } }]));
  assert.deepEqual(h.tree[0].properties, { color: "red", folder: "lab" });
  assert.equal(h.tree[0].content, "mine");
  ack.resolve(batch(3, [{ op: "set", id: "a", content: "mine" }], ME));
  await saving;
  assert.equal(h.tree[0].content, "mine");
});

test("a remote edit ordered after our ack wins, with its caret", async (t) => {
  const ack = deferred();
  const h = setup(t, () => ack.promise);
  h.message({ t: "hello", client: ME, color: 0, seq: 0, peers: [{ client: "p2", color: 1 }] });
  h.edit([block("a", "mine"), block("b")]);
  const saving = h.session.flush();
  ack.resolve(batch(1, [{ op: "set", id: "a", content: "mine" }], ME));
  await settle();
  // Arrives after ours in the log (seq 2 > ack 1) while ours is still in flight.
  h.ops({ ...batch(2, [{ op: "set", id: "a", content: "theirs" }], "p2"), cursor: { block: "a", anchor: 6, head: 6 } });
  await saving;
  assert.equal(h.tree[0].content, "theirs");
  assert.deepEqual(h.peers.map((p) => [p.client, p.block, p.anchor]), [["p2", "a", 6]]);
});

test("network retries keep local content protected until it is acknowledged", async (t) => {
  let attempts = 0;
  const h = setup(t, async () => {
    if (++attempts === 1) throw new Error("offline");
    return batch(2, [{ op: "set", id: "a", content: "mine" }], ME);
  });
  h.edit([block("a", "mine"), block("b")]);
  await h.session.flush();
  assert.match(h.status[0], /retrying/);
  h.ops(batch(1, [{ op: "set", id: "a", content: "theirs" }]));
  assert.equal(h.tree[0].content, "mine");
  await h.session.flush();
  assert.equal(h.tree[0].content, "mine");
  assert.equal(h.session.hasPending(), false);
});

test("retries stop after the limit; the edits stay for pagehide", async (t) => {
  const h = setup(t, async () => { throw new Error("offline"); });
  h.edit([block("a", "mine"), block("b")]);
  await h.session.flush();
  for (let i = 0; i < MAX_RETRIES; i++) {
    const [timer] = h.timers.values();
    assert.equal(timer.ms, RETRY_MS);
    h.fire();
    await settle();
  }
  assert.equal(h.status.filter((s) => /retrying/.test(s)).length, MAX_RETRIES);
  assert.equal(h.status[h.status.length - 1], "Save failed: offline");
  assert.equal(h.timers.size, 0, "no further retry armed");
  assert.equal(h.session.hasPending(), true);
  h.session.pagehide();
  assert.equal(h.keepalive.length, 1);
  assert.deepEqual(h.keepalive[0].body.ops.map((op) => [op.op, op.id, op.content]), [["set", "a", "mine"]]);
  assert.equal(h.session.hasPending(), false);
});

test("a rejected batch drops the queue and reloads the page", async (t) => {
  const h = setup(t, async () => { const e = new Error("no such block"); e.status = 404; throw e; });
  h.edit([block("a", "mine"), block("b")]);
  await h.session.flush();
  assert.match(h.status[0], /^Save rejected/);
  assert.deepEqual(h.reloads, ["page-a"]);
  assert.equal(h.session.hasPending(), false);
});

test("navigating during a slow save keeps each page's queued ops separate", async (t) => {
  const firstAck = deferred();
  let first = true;
  const h = setup(t, async (url, options) => {
    if (first) { first = false; return firstAck.promise; }
    return batch(url.includes("page-a") ? 2 : 1, JSON.parse(options.body).ops, ME);
  });
  h.edit([block("a", "a1"), block("b")]);
  const initialSave = h.session.flush();
  h.edit([block("a", "a2"), block("b")]);
  h.load("page-b", [block("c")]);
  h.edit([block("c", "c1")]);
  const allSaved = h.session.flush();
  firstAck.resolve(batch(1, [{ op: "set", id: "a", content: "a1" }], ME));
  await initialSave; await allSaved; await settle();
  assert.equal(h.calls.length, 3);
  for (const { url, body } of h.calls) {
    assert.ok(body.ops.every((op) => (url.includes("page-a") ? op.id === "a" : op.id === "c")));
  }
  assert.equal(h.tree[0].content, "c1");
  assert.equal(h.session.hasPending(), false);
});

test("a hello with a newer sequence catches up from the log", async (t) => {
  const h = setup(t, async (url) => {
    assert.ok(url.endsWith("?since=0"));
    return { seq: 1, batches: [batch(1, [{ op: "set", id: "b", content: "late" }])] };
  });
  h.message({ t: "hello", client: ME, color: 2, seq: 1, peers: [{ client: ME, color: 2 }, { client: "p2", color: 1 }] });
  assert.deepEqual(h.me, { client: ME, color: 2, connected: true });
  assert.deepEqual(h.peers.map((p) => p.client), ["p2"]);
  await settle();
  assert.equal(h.tree[1].content, "late");
});

test("a reload message refetches instead of applying, and the next load resumes", async (t) => {
  const h = setup(t, async () => ({ seq: 1, batches: [] }));
  h.message({ t: "reload", seq: 1 });
  assert.deepEqual(h.reloads, ["page-a"]);
  h.ops(batch(2, [{ op: "set", id: "b", content: "held" }]));
  assert.equal(h.tree[1].content, "b", "nothing applies while a reload is pending");
  h.tree = [block("a"), { ...block("b"), position: "a1" }];
  h.session.commit(h.tree, { isLoad: true, seq: 1 });
  assert.equal(h.tree[1].content, "held", "the batch after the fetched seq applies on load");
});

test("presence: join, leave, a standalone cursor and the caret on a batch", (t) => {
  const h = setup(t, async () => ({}));
  h.message({ t: "hello", client: ME, color: 0, seq: 0, peers: [] });
  h.message({ t: "join", peer: { client: "p2", color: 1 } });
  assert.deepEqual(h.peers.map((p) => p.client), ["p2"]);
  h.message({ t: "cursor", client: "p2", block: "a", anchor: 1, head: 1 });
  assert.equal(h.peers[0].block, "a");
  assert.equal(h.peers[0].rev, 1);
  h.ops({ ...batch(1, [{ op: "set", id: "b", content: "typed" }], "p2"), cursor: { block: "b", anchor: 5, head: 5 } });
  assert.equal(h.tree[1].content, "typed");
  assert.deepEqual([h.peers[0].block, h.peers[0].anchor, h.peers[0].rev], ["b", 5, 2]);
  h.message({ t: "leave", client: "p2" });
  assert.deepEqual(h.peers, []);
});

test("our caret goes out throttled, rides on a batch while edits are queued, and is not repeated", async (t) => {
  const h = setup(t, async (url, init) => batch(1, JSON.parse(init.body).ops, ME));
  h.message({ t: "hello", client: ME, color: 0, seq: 0, peers: [] });
  h.session.sendCursor({ block: "a", anchor: 1, head: 1 });
  assert.equal(h.socket().sent.length, 0, "throttled");
  h.fire();
  assert.deepEqual(h.socket().sent, [{ t: "cursor", block: "a", anchor: 1, head: 1 }]);
  h.session.sendCursor({ block: "a", anchor: 1, head: 1 });
  assert.equal(h.timers.size, 0, "an unchanged caret arms nothing");
  // With an edit queued the caret waits and rides on the batch instead.
  h.edit([block("a", "ax"), block("b")]);
  h.session.sendCursor({ block: "a", anchor: 2, head: 2 });
  h.fire();
  await settle();
  assert.equal(h.socket().sent.length, 1, "no standalone caret while the batch was queued or in flight");
  assert.deepEqual(h.calls[0].body.cursor, { block: "a", anchor: 2, head: 2 });
  h.fire(); // the send re-armed the throttle; the caret already went with the batch
  assert.equal(h.socket().sent.length, 1);
});

test("the socket reconnects with growing backoff until disconnect", (t) => {
  const h = setup(t, async () => ({}));
  h.message({ t: "hello", client: ME, color: 0, seq: 0, peers: [{ client: "p2", color: 1 }] });
  assert.equal(h.me.connected, true);
  h.socket().onclose();
  assert.equal(h.me.connected, false);
  assert.deepEqual(h.peers, []);
  assert.deepEqual([...h.timers.values()].map((x) => x.ms), [1000]);
  h.fire();
  assert.equal(h.sockets.length, 2);
  h.socket().onclose();
  assert.deepEqual([...h.timers.values()].map((x) => x.ms), [2000]);
  h.session.disconnect();
  assert.equal(h.timers.size, 0);
  assert.equal(h.sockets.length, 2);
});

test("a read-only session sends nothing", (t) => {
  const h = setup(t, async () => ({}), { canWrite: false });
  h.edit([block("a", "typed"), block("b")]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.session.hasPending(), false);
});

test("the ack of a set the server merged lands the stored text, with our base on the wire", async (t) => {
  const h = setup(t, async () => ({ ...batch(1, [{ op: "set", id: "a", content: "theirs mine" }], ME), cursor: { block: "a", anchor: 11, head: 11 } }));
  h.edit([block("a", "mine"), block("b")]);
  await h.session.flush();
  assert.equal(h.calls[0].body.ops[0].base, "a");
  assert.equal(h.tree[0].content, "theirs mine");
  assert.deepEqual(h.remote, [{ op: "set", id: "a", content: "theirs mine" }]);
  assert.equal(h.session.hasPending(), false);
});

test("a merged ack waits while a newer set of ours is queued; that set's ack brings the whole result", async (t) => {
  const first = deferred();
  let calls = 0;
  const h = setup(t, () => (++calls === 1 ? first.promise : Promise.resolve(batch(2, [{ op: "set", id: "a", content: "theirs mine more" }], ME))));
  h.edit([block("a", "mine"), block("b")]);
  h.fire(); // the typing debounce: the first batch goes out
  h.edit([block("a", "mine more"), block("b")]); // queued behind the in-flight batch
  first.resolve(batch(1, [{ op: "set", id: "a", content: "theirs mine" }], ME));
  await settle();
  assert.equal(h.tree[0].content, "mine more"); // the merge is not applied under queued keystrokes
  assert.deepEqual(h.remote, []);
  h.fire(); // the second batch
  await settle();
  assert.equal(h.calls[1].body.ops[0].base, "mine"); // the queued set's base is the text we sent
  assert.equal(h.tree[0].content, "theirs mine more");
  assert.equal(h.session.hasPending(), false);
});
