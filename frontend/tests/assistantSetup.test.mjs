import test from "node:test";
import assert from "node:assert/strict";
import { claudeConnectCommand, claudePluginInstallCommands } from "../src/settings/assistantSetup.js";

test("Claude connection uses the current server URL and user scope on either platform", () => {
  for (const platform of ["windows", "unix"]) {
    assert.equal(claudeConnectCommand("http://localhost:9001/mcp", platform),
      "claude mcp add --transport http --scope user gamma 'http://localhost:9001/mcp'");
    assert.equal(claudeConnectCommand("https://new.example/mcp", platform, { replace: true }),
      "claude mcp remove gamma --scope user\nclaude mcp add --transport http --scope user gamma 'https://new.example/mcp'");
  }
});

test("Claude server URLs remain shell literals", () => {
  const url = "https://example/mcp'$(whoami)`&\"";
  assert(claudeConnectCommand(url, "windows").endsWith("'https://example/mcp''$(whoami)`&\"'"));
  assert(claudeConnectCommand(url, "unix").endsWith("'https://example/mcp'\"'\"'$(whoami)`&\"'"));
});

test("plugin installation is independent of a user's server address and credentials", () => {
  assert.equal(claudePluginInstallCommands,
    "claude plugin marketplace add ./gamma-marketplace\nclaude plugin install gamma@gamma-local --scope user");
});
