import test from "node:test";
import assert from "node:assert/strict";
import { codexSetupCommand } from "../src/codexSetup.js";

test("setup commands download the release installer and pass this server", () => {
  for (const platform of ["windows", "unix"]) {
    const command = codexSetupCommand("https://gamma.example/mcp", platform);
    assert(command.includes("https://github.com/tim4431/Gamma/releases/latest/download/install-gamma-codex."));
    assert(command.endsWith("'https://gamma.example/mcp'" + (platform === "unix" ? ")" : "")));
    assert(!command.includes("GAMMA_TOKEN"));
    assert(!command.includes("| sh"), "OAuth must retain terminal stdin");
  }
});

test("server text is shell quoted rather than interpreted", () => {
  const value = "https://example/mcp'$(whoami)`&\"";
  assert(codexSetupCommand(value, "windows").endsWith("'https://example/mcp''$(whoami)`&\"'"));
  assert(codexSetupCommand(value, "unix").endsWith("'https://example/mcp'\"'\"'$(whoami)`&\"')"));
});
