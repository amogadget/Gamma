// The workspace registry. The cases that matter are the ones where getting it
// wrong costs someone their notes: the delete guard, and the migration from
// the single-mode configuration the shell used before workspaces existed.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const registry = require("../lib/registry.js");

function profile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gamma-reg-"));
  registry.init(dir);
  return dir;
}

test("a bare host gets a scheme; junk is refused", () => {
  assert.equal(registry.normalizeUrl("gamma.example.com"), "https://gamma.example.com");
  assert.equal(registry.normalizeUrl("  https://a.test/  "), "https://a.test");
  assert.equal(registry.normalizeUrl("http://127.0.0.1:9001"), "http://127.0.0.1:9001");
  assert.equal(registry.normalizeUrl("https://a.test/gamma/"), "https://a.test/gamma");
  assert.equal(registry.normalizeUrl("https://a.test/x?y=1#z"), "https://a.test/x");
  for (const bad of ["", "   ", "file:///etc/passwd", "javascript:alert(1)", "https://"]) {
    assert.equal(registry.normalizeUrl(bad), "", `should refuse ${JSON.stringify(bad)}`);
  }
});

test("local and remote workspaces round-trip", () => {
  profile();
  const local = registry.addLocal("Papers");
  const remote = registry.addRemote("", "annotation.example.com");
  assert.equal(local.type, "local");
  assert.ok(fs.existsSync(local.dataDir), "the library directory is created");
  assert.equal(remote.type, "remote");
  assert.equal(remote.url, "https://annotation.example.com");
  assert.equal(remote.name, "annotation.example.com", "an unnamed server is named after its host");
  assert.deepEqual(
    registry.load().workspaces.map((w) => w.name),
    ["Papers", "annotation.example.com"],
  );
});

test("the same server cannot be added twice", () => {
  profile();
  registry.addRemote("One", "https://a.test");
  assert.throws(() => registry.addRemote("Two", "a.test/"), /already a workspace/);
});

test("renaming needs a name", () => {
  profile();
  const ws = registry.addLocal("Papers");
  assert.equal(registry.rename(ws.id, "  Notes  ").name, "Notes");
  assert.throws(() => registry.rename(ws.id, "   "), /needs a name/);
  assert.throws(() => registry.rename("nope", "x"), /gone/);
});

test("deleting data only ever touches libraries the shell created", () => {
  const dir = profile();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gamma-elsewhere-"));
  fs.writeFileSync(path.join(outside, "users.db"), "not really a database");

  const adopted = registry.addLocal("Adopted", { dataDir: outside });
  const result = registry.remove(adopted.id, { deleteData: true });
  assert.equal(result.removed, true);
  assert.equal(result.deleted, false, "a library from elsewhere is never deleted");
  assert.ok(fs.existsSync(path.join(outside, "users.db")), "and its files are still there");

  const owned = registry.addLocal("Owned");
  fs.writeFileSync(path.join(owned.dataDir, "users.db"), "x");
  assert.equal(registry.remove(owned.id, { deleteData: true }).deleted, true);
  assert.equal(fs.existsSync(owned.dataDir), false);
  assert.equal(registry.load().workspaces.length, 0);
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("removing without deleting keeps the files", () => {
  profile();
  const ws = registry.addLocal("Keep");
  fs.writeFileSync(path.join(ws.dataDir, "users.db"), "x");
  assert.equal(registry.remove(ws.id).deleted, false);
  assert.ok(fs.existsSync(path.join(ws.dataDir, "users.db")));
});

test("a corrupt registry is treated as empty rather than fatal", () => {
  const dir = profile();
  fs.writeFileSync(path.join(dir, registry.FILE), "{ not json");
  assert.deepEqual(registry.load().workspaces, []);
  // …and writing over it works, so the app is usable again.
  registry.addLocal("Fresh");
  assert.equal(registry.load().workspaces.length, 1);
});

test("entries that cannot be acted on are dropped on read", () => {
  const dir = profile();
  fs.writeFileSync(
    path.join(dir, registry.FILE),
    JSON.stringify({
      workspaces: [
        { id: "1", name: "no type" },
        { id: "2", name: "local without a dir", type: "local" },
        { id: "3", name: "remote without a url", type: "remote" },
        { id: "4", name: "fine", type: "remote", url: "https://a.test" },
      ],
    }),
  );
  assert.deepEqual(registry.load().workspaces.map((w) => w.id), ["4"]);
});

test("a half-written registry cannot be observed", () => {
  const dir = profile();
  registry.addLocal("One");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("settings, last-opened and window bounds persist", () => {
  profile();
  const ws = registry.addLocal("One");
  assert.equal(registry.settings().openLastOnLaunch, true);
  registry.setSettings({ openLastOnLaunch: false, lastTheme: "light" });
  assert.equal(registry.settings().openLastOnLaunch, false);
  assert.equal(registry.settings().lastTheme, "light");

  assert.equal(registry.lastOpened(), null);
  registry.markOpened(ws.id);
  assert.equal(registry.lastOpened().id, ws.id);
  assert.ok(registry.get(ws.id).lastOpenedAt, "and when");

  registry.setWindowBounds({ x: 10, y: 20, width: 1200, height: 800, maximized: false });
  assert.equal(registry.windowBounds().width, 1200);
});

test("removing the open workspace clears last-opened", () => {
  profile();
  const ws = registry.addLocal("One");
  registry.markOpened(ws.id);
  registry.remove(ws.id);
  assert.equal(registry.load().lastOpened, null);
});

// --- the migration -----------------------------------------------------------

test("the pre-workspaces local library is adopted, not abandoned", () => {
  const dir = profile();
  // The old shell kept one library in the platform's app-support directory.
  const oldLibrary = fs.mkdtempSync(path.join(os.tmpdir(), "gamma-oldlib-"));
  fs.writeFileSync(path.join(oldLibrary, "users.db"), "the user's actual notes");
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ mode: "local", serverUrl: "", recentServers: ["https://vps.test"] }),
  );

  const openId = registry.migrateFromSingleMode({ defaultDataDir: oldLibrary });
  const state = registry.load();
  const local = state.workspaces.find((w) => w.type === "local");
  assert.ok(local, "a local workspace exists");
  assert.equal(local.dataDir, oldLibrary, "pointing at the library that already had the notes");
  assert.equal(openId, local.id, "and it is the one that opens");
  assert.ok(
    state.workspaces.some((w) => w.type === "remote" && w.url === "https://vps.test"),
    "servers from the old recents list come across too",
  );

  // The adopted library must never be deletable: the user did not put it under
  // our directory and may have it in a backup set.
  assert.equal(registry.remove(local.id, { deleteData: true }).deleted, false);
  assert.ok(fs.existsSync(path.join(oldLibrary, "users.db")));
  fs.rmSync(oldLibrary, { recursive: true, force: true });
});

test("a remote-mode configuration migrates to that server", () => {
  const dir = profile();
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ mode: "remote", serverUrl: "https://vps.test", recentServers: ["https://vps.test"] }),
  );
  const openId = registry.migrateFromSingleMode({ defaultDataDir: null });
  const state = registry.load();
  assert.equal(state.workspaces.length, 1, "no phantom local library");
  assert.equal(state.workspaces[0].url, "https://vps.test");
  assert.equal(openId, state.workspaces[0].id);
});

test("migration runs once and leaves the old file behind for inspection", () => {
  const dir = profile();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ mode: "remote", serverUrl: "https://a.test" }));
  assert.ok(registry.migrateFromSingleMode({ defaultDataDir: null }));
  assert.equal(fs.existsSync(path.join(dir, "settings.json")), false);
  assert.ok(fs.existsSync(path.join(dir, "settings.json.migrated")), "kept, so a bad migration is reversible");
  assert.equal(registry.migrateFromSingleMode({ defaultDataDir: null }), null, "and does not run again");
  assert.equal(registry.load().workspaces.length, 1);
});

test("nothing to migrate is not an error", () => {
  profile();
  assert.equal(registry.migrateFromSingleMode({ defaultDataDir: "/nowhere" }), null);
});

test("dirSize adds up a library", () => {
  profile();
  const ws = registry.addLocal("Sized");
  fs.mkdirSync(path.join(ws.dataDir, "users", "local"), { recursive: true });
  fs.writeFileSync(path.join(ws.dataDir, "users.db"), Buffer.alloc(1000));
  fs.writeFileSync(path.join(ws.dataDir, "users", "local", "pages.db"), Buffer.alloc(2000));
  assert.equal(registry.dirSize(ws.dataDir), 3000);
  assert.equal(registry.dirSize("/definitely/not/here"), 0);
});
