import assert from "node:assert/strict";
import { test } from "node:test";
import { setSessionScope, loadSession, saveSession, clearSession } from "../src/sessionState.js";

test("reading state is isolated by account and workspace, including delayed saves", async (t) => {
  const data = new Map();
  t.mock.method(globalThis, "setTimeout", (fn) => { pending = fn; return 1; });
  t.mock.method(globalThis, "clearTimeout", () => { pending = null; });
  let pending = null;
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  t.after(() => { setSessionScope("", ""); delete globalThis.localStorage; });
  data.set("gamma-session", JSON.stringify({ focusedBlockId: "old-account" }));
  assert.deepEqual(loadSession(), {});
  setSessionScope("alice", "team");
  saveSession({ focusedBlockId: "alice-page", pdfScale: 1.5 });
  pending();
  setSessionScope("bob", "team");
  assert.deepEqual(loadSession(), {});
  saveSession({ focusedBlockId: "bob-page" });
  setSessionScope("alice", "team");
  assert.equal(pending, null, "switching cancels the previous account's pending save");
  assert.equal(loadSession().focusedBlockId, "alice-page");
  setSessionScope("alice", "personal");
  assert.deepEqual(loadSession(), {});
  setSessionScope("alice", "team");
  clearSession();
  assert.deepEqual(loadSession(), {});
});
