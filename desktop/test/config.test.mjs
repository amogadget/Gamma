// Settings persistence. The cases that matter are the ones where a bad or
// missing file must land the user back on the chooser rather than starting the
// wrong mode silently.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const config = require("../config.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gamma-cfg-"));
}

test("a bare host gets a scheme, and the trailing slash goes", () => {
  assert.equal(config.normalizeServerUrl("gamma.example.com"), "https://gamma.example.com");
  assert.equal(config.normalizeServerUrl("  https://a.test/  "), "https://a.test");
  assert.equal(config.normalizeServerUrl("http://127.0.0.1:9001"), "http://127.0.0.1:9001");
  // A path prefix is kept — someone may host Gamma under a subpath.
  assert.equal(config.normalizeServerUrl("https://a.test/gamma/"), "https://a.test/gamma");
  // …but a query or fragment is not part of an origin to point a window at.
  assert.equal(config.normalizeServerUrl("https://a.test/x?y=1#z"), "https://a.test/x");
});

test("things that are not usable addresses are rejected", () => {
  for (const bad of ["", "   ", "file:///etc/passwd", "javascript:alert(1)", "https://"]) {
    assert.equal(config.normalizeServerUrl(bad), "", `should reject ${JSON.stringify(bad)}`);
  }
});

test("roundtrip", () => {
  const dir = tmpdir();
  config.write(dir, { mode: "remote", serverUrl: "annotation.example.com" });
  const got = config.read(dir);
  assert.equal(got.mode, "remote");
  assert.equal(got.serverUrl, "https://annotation.example.com");
  assert.deepEqual(got.recentServers, ["https://annotation.example.com"]);
});

test("recent servers accumulate, most recent first, without duplicates", () => {
  const dir = tmpdir();
  config.write(dir, { mode: "remote", serverUrl: "a.test" });
  config.write(dir, { mode: "remote", serverUrl: "b.test" });
  config.write(dir, { mode: "remote", serverUrl: "a.test" });
  assert.deepEqual(config.read(dir).recentServers, ["https://a.test", "https://b.test"]);
});

test("switching to local keeps the servers you have used", () => {
  const dir = tmpdir();
  config.write(dir, { mode: "remote", serverUrl: "a.test" });
  const saved = config.write(dir, { mode: "local" });
  assert.equal(saved.mode, "local");
  assert.deepEqual(saved.recentServers, ["https://a.test"]);
});

test("no file means no choice has been made", () => {
  assert.equal(config.read(tmpdir()), null);
});

test("a corrupt file means no choice has been made", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, config.FILE), "{ not json");
  assert.equal(config.read(dir), null, "the chooser should reappear, not a guess");
});

test("remote with no address is not a choice we can act on", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, config.FILE), JSON.stringify({ mode: "remote" }));
  assert.equal(config.read(dir), null);
});

test("an unknown mode is not honoured", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, config.FILE), JSON.stringify({ mode: "cloud" }));
  assert.equal(config.read(dir), null);
});

test("a half-written file cannot be observed", () => {
  // write() renames into place, so a reader either sees the old file or the new
  // one. Assert the temp file is not left behind to be read as settings.
  const dir = tmpdir();
  config.write(dir, { mode: "local" });
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("the environment can override without touching the saved file", () => {
  assert.equal(config.fromEnv({}), null);
  assert.equal(config.fromEnv({ GAMMA_DESKTOP_MODE: "local" }).mode, "local");
  const remote = config.fromEnv({
    GAMMA_DESKTOP_MODE: "remote",
    GAMMA_DESKTOP_SERVER: "x.test",
  });
  assert.equal(remote.serverUrl, "https://x.test");
  // remote without an address falls through to the normal path
  assert.equal(config.fromEnv({ GAMMA_DESKTOP_MODE: "remote" }), null);
});
