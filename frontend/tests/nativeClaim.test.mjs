import test from "node:test";
import assert from "node:assert/strict";
import { NATIVE_RESERVED, NATIVE_TYPES, isNativeClaim, nativeClaimKeys, nativeClaimKind } from "../src/native/nativeClaim.js";

// The mirror is only useful if it matches the server: these sets are copied
// from gamma/native_ink.py (`_INK_RESERVED`, `_AUDIO_RESERVED`,
// `_NOTE_RESERVED`, `NATIVE_TYPE_VALUES`), and the e2e scenario asserts the
// live server refuses a generic insert carrying them.
test("the reserved sets mirror the server's", () => {
  assert.deepEqual(NATIVE_RESERVED.ink.sort(), ["bounds", "coordinate_space", "crop_box", "ink_asset", "ink_revision", "pdf_page", "preview_asset", "replay_asset", "type"]);
  assert.deepEqual(NATIVE_RESERVED.audio.sort(), ["audio_revision", "audio_state", "duration", "replay_events", "segments", "type"]);
  assert.deepEqual(NATIVE_RESERVED.note.sort(), ["native_note", "note_revision"]);
  assert.deepEqual(NATIVE_TYPES, ["pdf_ink", "audio"]);
});

test("a block is native by its type or by claiming a payload", () => {
  assert.equal(nativeClaimKind({ type: "pdf_ink", ink_asset: "/api/assets/x.pkdrawing" }), "ink");
  assert.equal(nativeClaimKind({ type: "audio", segments: [] }), "audio");
  assert.equal(nativeClaimKind({ native_note: true, note_revision: 2 }), "note");
  assert.equal(nativeClaimKind({ type: "highlight", highlight_id: "h" }), null);
  assert.equal(nativeClaimKind({ ink_url: "/api/uploads/x.ink" }), null, "upstream's own ink is not a native payload");
  assert.equal(nativeClaimKind(null), null);

  // A plain-looking block that still carries a reserved key is refused by the
  // server, so the UI must treat it as native too.
  assert.equal(isNativeClaim({ preview_asset: "/api/assets/x.png" }), true);
  assert.equal(isNativeClaim({ type: "pdf_ink" }), true);
  assert.equal(isNativeClaim({ type: "note", content: "hello" }), false);
  assert.equal(isNativeClaim({ properties: { type: "audio" } }), true, "accepts a block as well as its properties");
});

test("the claimed keys are what the insert guard refuses", () => {
  assert.deepEqual(nativeClaimKeys({ type: "pdf_ink", ink_asset: "a", bounds: {}, pdf_page: 1 }), ["bounds", "ink_asset", "type"]);
  assert.deepEqual(nativeClaimKeys({ type: "audio", segments: [], duration: 3 }), ["duration", "segments", "type"]);
  assert.deepEqual(nativeClaimKeys({ native_note: true, note_revision: 1 }), ["native_note", "note_revision"]);
  // `pdf_page` alone is an ordinary property (upstream ink and highlights use
  // it), and a non-native `type` is not a claim.
  assert.deepEqual(nativeClaimKeys({ pdf_page: 2 }), []);
  assert.deepEqual(nativeClaimKeys({ type: "highlight", pdf_page: 2 }), []);
  assert.deepEqual(nativeClaimKeys({}), []);
});
