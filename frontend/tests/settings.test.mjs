import test from "node:test";
import assert from "node:assert/strict";
import { permissionPreset, presetPermissions, toolsForKind } from "../src/chatSettings.js";
import { resolveSettingsPane, searchSettings } from "../src/settingsNavigation.js";

test("permission presets preserve explicit restrictions and the applicable tools for each chat kind", () => {
  for (const kind of ["folder", "pdf", "notes"]) {
    const read = presetPermissions(kind, "read");
    assert.equal(permissionPreset(kind, read), "read");
    assert.equal(read.block_edit, false);
    assert.equal(read.read, true);
    assert.deepEqual(Object.keys(read), toolsForKind(kind));
    assert.equal(permissionPreset(kind, { ...read, read: false }), "custom");
    assert.equal(permissionPreset(kind, presetPermissions(kind, "edit")), "edit");
    assert.equal(permissionPreset(kind, {}), "edit", "legacy omitted permissions remain allowed");
  }
  assert.equal(presetPermissions("folder", "read").rename, false);
  assert.equal(presetPermissions("pdf", "edit").rename, undefined);
});

test("settings search finds controls on nested AI pages without exposing inaccessible management pages", () => {
  const allowed = ["appearance", "reading", "library", "ai", "assistant", "ai-advanced", "prompts", "account", "maintenance", "diagnostics"];
  assert.equal(searchSettings("translation concurrency", allowed)[0].label, "Parallel requests");
  assert.equal(searchSettings("  FLIP colors  ", allowed)[0].pane, "appearance");
  assert.equal(searchSettings("password", allowed).some((item) => item.pane === "users"), false);
  assert.equal(searchSettings("password", [...allowed, "users"]).some((item) => item.pane === "users"), true);
  assert.deepEqual(searchSettings("   ", allowed), []);
  assert.deepEqual(searchSettings("no-such-setting", allowed), []);
});

test("legacy settings destinations resolve to the reorganized pages", () => {
  for (const old of ["notes", "viewer", "search"]) assert.equal(resolveSettingsPane(old), "reading");
  assert.equal(resolveSettingsPane("context"), "ai-advanced");
  for (const id of ["assistant", "prompts", "ai-advanced"]) assert.equal(resolveSettingsPane(id), id);
  assert.equal(resolveSettingsPane("general"), "appearance");
  assert.equal(resolveSettingsPane("workspace"), "workspaces");
  assert.equal(resolveSettingsPane("advanced"), "diagnostics");
  assert.equal(resolveSettingsPane("account"), "account");
});
