// Which blocks carry a NATIVE (iPad) payload — the client-side mirror of
// `gamma/native_ink.py`'s rule (`native_kind`, `reserved_keys`,
// `native_claim_keys`). One definition, so the UI can tell which controls a
// generic block write may not touch BEFORE a 409 comes back.
//
// Why the UI has to know: a generic insert that carries any of the reserved
// keys, or `type: "pdf_ink"` / `"audio"`, is refused by the block writer
// (`guard_generic_insert`) — copying an annotation is a native write (a new
// UUID, the same assets, its own revision). The collab session treats the 4xx
// as a permanent refusal: it clears the queue, reports "Save rejected: …" and
// RESYNCS the page. So an offered-but-refused control does not wedge the
// session, but it does silently drop the user's action — which is why the
// controls that would do it are disabled instead of left to fail.
//
// Undoing a DELETION is the one supported generic path (the server records what
// it removed and accepts an insert that reproduces it exactly), so delete stays
// offered; see `isNativeClaim` callers.

// `_INK_RESERVED` / `_AUDIO_RESERVED` / `_NOTE_RESERVED` (native_ink.py).
export const NATIVE_RESERVED = {
  ink: ["type", "ink_asset", "preview_asset", "replay_asset", "ink_revision", "bounds", "crop_box", "coordinate_space", "pdf_page"],
  audio: ["type", "audio_revision", "audio_state", "segments", "duration", "replay_events"],
  note: ["native_note", "note_revision"],
};

// `NATIVE_TYPE_VALUES`.
export const NATIVE_TYPES = ["pdf_ink", "audio"];

// The keys a generic insert may not introduce on a block that is not already
// native: the reserved sets minus `type` and `pdf_page`, both of which are
// ordinary properties for other kinds of block.
const RESERVED_INSERT = [...new Set(Object.values(NATIVE_RESERVED).flat())]
  .filter((key) => key !== "type" && key !== "pdf_page");

// "ink" | "audio" | "note" | null — what this properties dict IS (native_kind).
export function nativeClaimKind(props) {
  if (!props || typeof props !== "object") return null;
  if (props.native_note === true) return "note";
  if (props.type === "pdf_ink") return "ink";
  if (props.type === "audio") return "audio";
  return null;
}

// The reserved keys this dict claims, sorted — the insert guard's test. A plain
// block that somehow carries `preview_asset` claims one too, and is refused by
// the server just the same.
export function nativeClaimKeys(props) {
  if (!props || typeof props !== "object") return [];
  const hit = new Set(Object.keys(props).filter((key) => RESERVED_INSERT.includes(key)));
  if (NATIVE_TYPES.includes(props.type)) hit.add("type");
  return [...hit].sort();
}

// Does this block carry a native payload (or claim one)? Such a block is owned
// by the native endpoints: the web renders it, edits its caption, and may
// delete it (undo included), but must not copy or move it across pages.
// Ink/audio may be nested within their PDF page; native notes keep their parent.
export function isNativeClaim(blockOrProps) {
  const props = blockOrProps?.properties ?? blockOrProps;
  return nativeClaimKind(props) !== null || nativeClaimKeys(props).length > 0;
}

// The reason to show on a disabled control.
export const NATIVE_CONTROL_REASON =
  "iPad annotations are created on the iPad — this would need a native copy the server does not accept";
