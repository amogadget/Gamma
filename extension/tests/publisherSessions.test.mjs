import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REFRESH_AFTER, RETRY_AFTER, ageText, connectPublisher, cookiesForHost, describeSession,
  publisherHost, publisherRoot, secureServer, shouldAutoRefresh,
} from "../publisherSessions.js";

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

test("automatic refresh: only a connected host, once stale, throttled per host", () => {
  const now = 1_800_000_000;
  const iso = (secondsAgo) => new Date((now - secondsAgo) * 1000).toISOString();
  const session = (secondsAgo) => ({ host: "journals.aps.org", updated_at: iso(secondsAgo), expires_at: now + 20 * 3600 });
  assert.equal(publisherRoot("journals.aps.org", ["nature.com", "aps.org"]), "aps.org");
  assert.equal(publisherRoot("aps.org.evil.test", ["aps.org"]), "");
  // A host that was never connected by hand is never imported on its own.
  assert.equal(shouldAutoRefresh({ session: null, now }), false);
  // A fresh snapshot is kept — it is only re-read once it is an hour old.
  assert.equal(shouldAutoRefresh({ session: session(REFRESH_AFTER - 1), now }), false);
  assert.equal(shouldAutoRefresh({ session: session(REFRESH_AFTER), now }), true);
  // One try per host per RETRY_AFTER, whatever the outcome.
  assert.equal(shouldAutoRefresh({ session: session(5 * 3600), attempts: { "journals.aps.org": now - RETRY_AFTER + 1 }, now }), false);
  assert.equal(shouldAutoRefresh({ session: session(5 * 3600), attempts: { "journals.aps.org": now - RETRY_AFTER }, now }), true);
  assert.equal(shouldAutoRefresh({ session: session(5 * 3600), attempts: { "www.nature.com": now }, now }), true);
  // A snapshot without a parsable timestamp counts as stale.
  assert.equal(shouldAutoRefresh({ session: { host: "journals.aps.org", updated_at: "", expires_at: now + 10 }, now }), true);
});

test("session status text", () => {
  const now = 1_800_000_000;
  assert.equal(ageText(20), "just now");
  assert.equal(ageText(5 * 60), "5 min");
  assert.equal(ageText(3 * 3600 + 100), "3 h");
  assert.equal(ageText(2 * 86400), "2 d");
  const s = { host: "www.nature.com", updated_at: new Date((now - 3 * 3600) * 1000).toISOString(), expires_at: now + 21 * 3600 };
  assert.equal(describeSession(s, now), "refreshed 3 h ago · expires in 21 h");
  assert.equal(describeSession({ ...s, updated_at: new Date(now * 1000).toISOString() }, now), "refreshed just now · expires in 21 h");
  assert.equal(describeSession({ ...s, expires_at: now - 1 }, now), "refreshed 3 h ago · expired");
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
