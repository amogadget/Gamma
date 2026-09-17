import assert from "node:assert/strict";
import { test } from "node:test";
import { api, whoAmI } from "../api.js";

function settings(t, server) {
  const stored = { server };
  const writes = [];
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { storage: { sync: {
    get: async () => ({ ...stored }),
    set: async (patch) => { writes.push(patch); Object.assign(stored, patch); },
  } } };
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });
  return { stored, writes };
}

function response(url, data = { user: "alice" }) {
  const res = new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

test("account check remembers HTTPS before the guarded publisher-session request", async (t) => {
  const { stored, writes } = settings(t, "http://gamma.example");
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: url.href, init });
    if (url.pathname === "/api/session") return response("https://gamma.example/api/session");
    // Model Fetch rejecting the HTTP redirect for a pinned request.
    if (url.protocol === "http:" && init.redirect === "error") throw new TypeError("Failed to fetch");
    return response(url.href, { sessions: [], publisher_roots: ["aps.org"] });
  });

  const me = await whoAmI();
  assert.deepEqual(me, { user: "alice", origin: "https://gamma.example" });
  assert.equal(stored.server, me.origin);
  assert.deepEqual(writes, [{ server: me.origin }]);
  const data = await api("/publisher-sessions", { expectedUser: me.user, expectedOrigin: me.origin });
  assert.deepEqual(data.sessions, []);
  assert.equal(calls[1].url, "https://gamma.example/api/publisher-sessions");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[1].init.headers["X-Gamma-User"], "alice");
  assert.equal(calls[1].init.credentials, "include");
});

test("only an exact same-host HTTPS session upgrade is remembered", async (t) => {
  for (const [server, destination, expected] of [
    ["http://gamma.example:9001", "https://gamma.example:9001/api/session", "https://gamma.example:9001"],
    ["http://localhost:9001", "http://localhost:9001/api/session", "http://localhost:9001"],
    ["http://gamma.example", "https://other.example/api/session", "http://gamma.example"],
    ["http://gamma.example", "https://gamma.example:9001/api/session", "http://gamma.example"],
    ["http://gamma.example", "https://gamma.example/login", "http://gamma.example"],
    ["http://gamma.example", "https://gamma.example/api/session?redirect=1", "http://gamma.example"],
    ["https://gamma.example", "http://gamma.example/api/session", "https://gamma.example"],
  ]) {
    await t.test(`${server} -> ${destination}`, async (t) => {
      const { stored, writes } = settings(t, server);
      t.mock.method(globalThis, "fetch", async () => response(destination));
      assert.equal((await whoAmI()).origin, expected);
      assert.equal(stored.server, expected);
      assert.equal(writes.length, server === expected ? 0 : 1);
    });
  }
});

test("a signed-out session can discover HTTPS before login", async (t) => {
  const { stored } = settings(t, "http://gamma.example");
  t.mock.method(globalThis, "fetch", async () => response("https://gamma.example/api/session", { user: null }));
  assert.deepEqual(await whoAmI(), { user: null, origin: "https://gamma.example" });
  assert.equal(stored.server, "https://gamma.example");
});

test("an unrelated response does not rewrite the server", async (t) => {
  const { writes } = settings(t, "http://gamma.example");
  t.mock.method(globalThis, "fetch", async () => response("https://gamma.example/api/session", { detail: "not a session" }));
  assert.equal((await whoAmI()).origin, "http://gamma.example");
  assert.deepEqual(writes, []);
});

test("an in-flight session check does not overwrite a changed server", async (t) => {
  const { stored, writes } = settings(t, "http://gamma.example");
  t.mock.method(globalThis, "fetch", async () => {
    stored.server = "https://other.example";
    return response("https://gamma.example/api/session");
  });
  await assert.rejects(whoAmI(), /server changed/);
  assert.equal(stored.server, "https://other.example");
  assert.deepEqual(writes, []);
});

test("guarded requests still reject redirects without retrying or changing settings", async (t) => {
  const { writes } = settings(t, "https://gamma.example");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    assert.equal(init.redirect, "error");
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(api("/publisher-sessions", {
    json: { host: "journals.aps.org", cookies: [] },
    expectedUser: "alice", expectedOrigin: "https://gamma.example",
  }), /Can't reach/);
  assert.equal(calls, 1);
  assert.deepEqual(writes, []);
});
