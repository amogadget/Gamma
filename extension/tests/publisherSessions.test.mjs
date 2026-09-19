import assert from "node:assert/strict";
import { test } from "node:test";
import { connectPublisher, cookiesForHost, publisherHost, secureServer } from "../publisherSessions.js";

const cookie = { name: "session", value: "test-secret", domain: ".aps.org", path: "/", hostOnly: false };

test("publisher and transport boundaries", () => {
  assert.equal(publisherHost("https://journals.aps.org/paper", ["aps.org"]), "journals.aps.org");
  for (const url of ["http://journals.aps.org", "https://aps.org.evil.test", "https://login.stanford.edu"]) {
    assert.equal(publisherHost(url, ["aps.org"]), "");
  }
  for (const url of ["https://gamma.example", "http://localhost:9001", "http://127.0.0.1:9001", "http://[::1]:9001"]) {
    assert.equal(secureServer(url), true);
  }
  assert.equal(secureServer("http://192.168.1.5:9001"), false);
  assert.equal(secureServer("http://localhost.evil.test"), false);
});

test("only applicable, unpartitioned publisher cookies are transferred", () => {
  const cookies = cookiesForHost([
    cookie,
    { ...cookie, domain: "login.aps.org", hostOnly: true },
    { ...cookie, domain: ".stanford.edu" },
    { ...cookie, partitionKey: { topLevelSite: "https://aps.org" } },
    { ...cookie, domain: "journals.aps.org", hostOnly: true, httpOnly: true, expirationDate: 2000000000 },
  ], "journals.aps.org");
  assert.equal(cookies.length, 2);
  assert.equal(cookies[1].expirationDate, 2000000000);
  assert.equal(cookies[1].value, "test-secret");
});

test("connect transfers to the displayed account and server using the tab's cookie store", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: url.href, init });
    return new Response(JSON.stringify({ host: "journals.aps.org" }), { headers: { "Content-Type": "application/json" } });
  });
  globalThis.chrome = {
    tabs: { get: async () => ({ url: "https://journals.aps.org/paper" }) },
    cookies: {
      getAllCookieStores: async () => [{ id: "normal", tabIds: [42] }, { id: "other", tabIds: [7] }],
      getAll: async (filter) => {
        assert.deepEqual(filter, { domain: "aps.org", storeId: "normal" });
        return [cookie];
      },
    },
    storage: { sync: { get: async () => ({ server: "https://gamma.example" }) } },
  };
  const args = { tabId: 42, host: "journals.aps.org", root: "aps.org", user: "alice", origin: "https://gamma.example" };
  await connectPublisher(args);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gamma.example/api/publisher-sessions");
  assert.equal(calls[0].init.headers["X-Gamma-User"], "alice");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), { host: "journals.aps.org", cookies: [cookie] });

  chrome.storage.sync.get = async () => ({ server: "https://changed.example" });
  await assert.rejects(connectPublisher(args), /server changed/);
  assert.equal(calls.length, 1);

  chrome.tabs.get = async () => ({ url: "https://journals.aps.org/paper", incognito: true });
  await assert.rejects(connectPublisher(args), /incognito/);
  chrome.tabs.get = async () => ({ url: "https://other.example" });
  await assert.rejects(connectPublisher(args), /tab changed/);
  assert.equal(calls.length, 1);
  delete globalThis.chrome;
});
