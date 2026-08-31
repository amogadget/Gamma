import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = {
  fetch: globalThis.fetch.bind(globalThis),
  dispatchEvent() {},
};

const { isEnterCommit } = await import("./utils.js");

test("isEnterCommit accepts an ordinary Enter key", () => {
  assert.equal(isEnterCommit({ key: "Enter", keyCode: 13 }), true);
});

test("isEnterCommit rejects React synthetic IME Enter", () => {
  assert.equal(
    isEnterCommit({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: true } }),
    false,
  );
});

test("isEnterCommit rejects native CodeMirror IME Enter", () => {
  assert.equal(isEnterCommit({ key: "Enter", keyCode: 13, isComposing: true }), false);
});

test("isEnterCommit rejects legacy IME keyCode and non-Enter keys", () => {
  assert.equal(isEnterCommit({ key: "Enter", keyCode: 229 }), false);
  assert.equal(isEnterCommit({ key: "Tab", keyCode: 9 }), false);
});
