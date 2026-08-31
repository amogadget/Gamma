import assert from "node:assert/strict";
import test from "node:test";

import { SLASH_COMMANDS, filterSlashCommands } from "./slashCommands.js";

function command(name) {
  return SLASH_COMMANDS.find((item) => item.name === name);
}

function context(value, start = value.indexOf("/"), cursor = value.length) {
  const calls = [];
  return {
    calls,
    value,
    start,
    cursor,
    refOpened: false,
    imagePicked: false,
    setText(...args) { calls.push(args); },
    openRefPopup() { this.refOpened = true; },
    pickImage() { this.imagePicked = true; },
  };
}

test("heading commands replace an existing line prefix instead of stacking", () => {
  const ctx = context("# /h2Existing", 2, 5);
  command("h2").run(ctx);
  assert.deepEqual(ctx.calls[0], ["## Existing", 3, 3]);
});

test("block commands move to a fresh line and preserve caret selection", () => {
  const ctx = context("before /code", 7, 12);
  command("code").run(ctx);
  assert.deepEqual(ctx.calls[0], ["before \n```\n\n```", 12, 12]);

  const table = context("/table", 0, 6);
  command("table").run(table);
  assert.equal(table.calls[0][0].startsWith("| Column 1 |"), true);
  assert.deepEqual(table.calls[0].slice(1), [2, 10]);
});

test("link and image commands remove the trigger before opening side effects", () => {
  const link = context("/link", 0, 5);
  command("link").run(link);
  assert.deepEqual(link.calls[0], ["[[", 2, 2]);
  assert.equal(link.refOpened, true);

  const image = context("prefix /image", 7, 13);
  command("image").run(image);
  assert.deepEqual(image.calls[0], ["prefix ", 7, 7]);
  assert.equal(image.imagePicked, true);
});

test("slash filtering ranks prefix matches and supports keywords", () => {
  assert.equal(filterSlashCommands("equ")[0].name, "equation");
  assert.equal(filterSlashCommands("checkbox")[0].name, "todo");
  assert.equal(filterSlashCommands("upload")[0].name, "image");
  assert.equal(filterSlashCommands("definitely-missing").length, 0);
});
