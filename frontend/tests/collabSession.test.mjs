// Exercise the real hook with controlled HTTP, sockets and timers. React's
// render layer is stubbed; these tests cover transport ordering, not DOM work.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applyOps } from "../src/blockOps.js";

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const react = moduleUrl(`
  export const useRef = (current) => ({current});
  export const useCallback = (fn) => fn;
  export const useEffect = (fn) => globalThis.__collabTest.effects.push(fn);
  export const useState = (value) => [value, (next) => { value = typeof next === 'function' ? next(value) : next; }];
`);
const utils = moduleUrl(`
  export const API = '/api';
  export const apiJson = (...args) => globalThis.__collabTest.api(...args);
  export const makeId = () => 'this-client';
  export const withShare = (url) => url;
  export const withWorkspace = (url) => url;
`);
const source = (await readFile(new URL("../src/collab.js", import.meta.url), "utf8"))
  .replace('from "react"', `from "${react}"`)
  .replace('from "./utils"', `from "${utils}"`)
  .replace('from "./blockOps"', `from "${new URL("../src/blockOps.js", import.meta.url)}"`);
const { usePageCollab, CLIENT_ID } = await import(moduleUrl(source));
const block = (id, content = id, properties = {}) => ({ id, content, properties, children: [], position: "a0" });
const batch = (seq, ops, client = "other") => ({ seq, ops, client });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function setup(t, api) {
  const h = { effects: [], timers: new Map(), api, calls: [], remote: [], reloads: [] };
  let timerId = 0;
  globalThis.__collabTest = h;
  t.mock.method(globalThis, "setTimeout", (fn, ms) => { h.timers.set(++timerId, { fn, ms }); return timerId; });
  t.mock.method(globalThis, "clearTimeout", (id) => h.timers.delete(id));
  globalThis.window = { location: { protocol: "http:", host: "gamma.test" }, addEventListener() {}, removeEventListener() {} };
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    constructor() { h.socket = this; }
    send() {}
    close() {}
  };
  h.api = (url, options) => { h.calls.push({ url, body: options?.body && JSON.parse(options.body) }); return api(url, options); };
  const opts = { pageId: "page-a", enabled: true, canWrite: true,
    onRemoteOps: (ops, page, pos) => { h.remote.push(...ops); h.tree = applyOps(h.tree, ops, page, pos); },
    onReload: (page) => h.reloads.push(page),
  };
  h.hook = usePageCollab(opts);
  h.load = (page, tree) => { opts.pageId = page; h.tree = tree; h.hook.commit(tree, { isLoad: true, seq: 0 }); };
  h.edit = (tree) => { h.tree = tree; h.hook.commit(tree); };
  h.load("page-a", [block("a"), { ...block("b"), position: "a1" }]);
  const cleanups = h.effects.map((fn) => fn());
  h.message = (msg) => h.socket.onmessage({ data: JSON.stringify({ t: "ops", ...msg }) });
  t.after(() => {
    for (const cleanup of cleanups) cleanup?.();
    delete globalThis.__collabTest; delete globalThis.window; delete globalThis.WebSocket;
  });
  return h;
}

test("HTTP ack catches up missing remote edits before advancing the sequence", async (t) => {
  const remote = batch(1, [{ op: "set", id: "b", content: "remote b" }]);
  const own = batch(2, [{ op: "set", id: "a", content: "my a" }], CLIENT_ID);
  const h = setup(t, async (url) => url.includes("?since=") ? { seq: 2, batches: [remote, own] } : own);
  h.edit([block("a", "my a"), block("b")]);
  await h.hook.flush();
  assert.ok(h.calls.some((c) => c.url.endsWith("?since=0")));
  assert.equal(h.tree.find((b) => b.id === "b").content, "remote b");
  assert.equal(h.hook.hasPending(), false);
});

test("out-of-order socket batches wait for missing operations", async (t) => {
  const log = deferred();
  const h = setup(t, () => log.promise);
  const first = batch(1, [{ op: "set", id: "a", content: "first" }]);
  const second = batch(2, [{ op: "set", id: "a", content: "second" }]);
  h.message(second);
  assert.equal(h.tree[0].content, "a");
  log.resolve({ seq: 2, batches: [first, second] });
  await settle();
  assert.deepEqual(h.remote.map((op) => op.content), ["first", "second"]);
});

test("a gap arriving during catch-up triggers a second log read", async (t) => {
  const firstRead = deferred();
  const updates = [1, 2, 3, 4].map((seq) => batch(seq, [{ op: "set", id: "a", content: String(seq) }]));
  let reads = 0;
  const h = setup(t, () => ++reads === 1 ? firstRead.promise : Promise.resolve({ seq: 4, batches: updates.slice(2) }));
  h.message(updates[1]);
  h.message(updates[3]);
  firstRead.resolve({ seq: 2, batches: updates.slice(0, 2) });
  await settle();
  assert.equal(reads, 2);
  assert.equal(h.tree[0].content, "4");
});

test("deferred content preserves every remote property patch", async (t) => {
  const ack = deferred();
  const h = setup(t, () => ack.promise);
  h.edit([block("a", "mine"), block("b")]);
  const saving = h.hook.flush();
  h.message(batch(1, [{ op: "set", id: "a", content: "theirs 1", props: { color: "red" } }]));
  h.message(batch(2, [{ op: "set", id: "a", content: "theirs 2", props: { folder: "lab" } }]));
  assert.deepEqual(h.tree[0].properties, { color: "red", folder: "lab" });
  assert.equal(h.tree[0].content, "mine");
  ack.resolve(batch(3, [{ op: "set", id: "a", content: "mine" }], CLIENT_ID));
  await saving;
  assert.equal(h.tree[0].content, "mine");
});

test("network retries keep local content protected until it is acknowledged", async (t) => {
  let attempts = 0;
  const h = setup(t, async () => {
    if (++attempts === 1) throw new Error("offline");
    return batch(2, [{ op: "set", id: "a", content: "mine" }], CLIENT_ID);
  });
  h.edit([block("a", "mine"), block("b")]);
  await h.hook.flush();
  h.message(batch(1, [{ op: "set", id: "a", content: "theirs" }]));
  assert.equal(h.tree[0].content, "mine");
  await h.hook.flush();
  assert.equal(h.tree[0].content, "mine");
  assert.equal(h.hook.hasPending(), false);
});

test("retry exhaustion retains unsaved work for a later flush", async (t) => {
  let offline = true;
  const h = setup(t, async () => {
    if (offline) throw new Error("offline");
    return batch(1, [{ op: "set", id: "a", content: "mine" }], CLIENT_ID);
  });
  h.edit([block("a", "mine"), block("b")]);
  for (let i = 0; i < 9; i++) await h.hook.flush();
  assert.equal(h.hook.hasPending(), true);
  offline = false;
  await h.hook.flush();
  assert.equal(h.hook.hasPending(), false);
  assert.equal(h.calls.at(-1).body.ops[0].content, "mine");
});

test("flush waits for edits queued behind an outstanding save", async (t) => {
  const first = deferred(), second = deferred();
  let posts = 0;
  const h = setup(t, () => ++posts === 1 ? first.promise : second.promise);
  h.edit([block("a", "a1"), block("b")]);
  let finished = false;
  const saving = h.hook.flush().then(() => { finished = true; });
  h.edit([block("a", "a2"), block("b")]);
  first.resolve(batch(1, [{ op: "set", id: "a", content: "a1" }], CLIENT_ID));
  await settle();
  assert.equal(posts, 2);
  assert.equal(finished, false);
  second.resolve(batch(2, [{ op: "set", id: "a", content: "a2" }], CLIENT_ID));
  await saving;
  assert.equal(finished, true);
});

test("navigating during a slow save keeps each page's queued ops separate", async (t) => {
  const firstAck = deferred();
  let first = true;
  const h = setup(t, async (url, options) => {
    if (first) { first = false; return firstAck.promise; }
    return batch(url.includes("page-a") ? 2 : 1, JSON.parse(options.body).ops, CLIENT_ID);
  });
  h.edit([block("a", "a1"), block("b")]);
  const initialSave = h.hook.flush();
  h.edit([block("a", "a2"), block("b")]);
  h.load("page-b", [block("c")]);
  h.edit([block("c", "c1")]);
  const allSaved = h.hook.flush();
  firstAck.resolve(batch(1, [{ op: "set", id: "a", content: "a1" }], CLIENT_ID));
  await initialSave; await allSaved; await settle();
  assert.equal(h.calls.length, 3);
  for (const { url, body } of h.calls) {
    assert.ok(body.ops.every((op) => url.includes("page-a") ? op.id === "a" : op.id === "c"));
  }
  assert.equal(h.tree[0].content, "c1");
  assert.equal(h.hook.hasPending(), false);
});
