import test from "node:test";
import assert from "node:assert/strict";
import { assetUrlInScope } from "../src/shared/lib/assetUrl.js";

const native = `/api/assets/${"a".repeat(64)}.png`;
const upload = `/api/uploads/${"b".repeat(64)}.ink`;

test("browser-issued native asset URLs carry the workspace", () => {
  // <img src>, <audio src> and the replay loader bypass the fetch wrapper, so
  // the library has to be named in the query or a non-default workspace 404s.
  assert.equal(assetUrlInScope(native, { workspace: "personal-7Qk2" }), `${native}?ws=personal-7Qk2`);
  assert.equal(assetUrlInScope(native), native, "no workspace known (share boot) leaves the URL alone");
  assert.equal(assetUrlInScope(native, { workspace: "" }), native);
});

test("the share token is added the same way, and only once", () => {
  assert.equal(assetUrlInScope(native, { share: "tok en" }), `${native}?share=tok%20en`);
  assert.equal(assetUrlInScope(`${native}?ws=w`, { share: "t" }), `${native}?ws=w&share=t`);
  assert.equal(assetUrlInScope(`${native}?share=t`, { workspace: "w", share: "t" }), `${native}?share=t&ws=w`);
});

test("upstream upload URLs keep their existing scoping", () => {
  assert.equal(assetUrlInScope(upload, { workspace: "w" }), `${upload}?ws=w`);
  assert.equal(assetUrlInScope(`${upload}?ws=w`, { workspace: "w" }), `${upload}?ws=w`, "an existing scope is not duplicated");
  assert.equal(assetUrlInScope(upload, { share: "t" }), `${upload}?share=t`);
});

test("only same-origin asset paths are ever rewritten", () => {
  for (const url of ["https://example.com/api/assets/x.png", "data:image/png;base64,AAA", "//example.com/x.png", "ink.png", "", null, undefined]) {
    assert.equal(assetUrlInScope(url, { workspace: "w", share: "t" }), url);
  }
  assert.equal(assetUrlInScope("/api/blocks/root/children", { workspace: "w" }), "/api/blocks/root/children");
});
