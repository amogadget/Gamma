// The display name a visitor without an account carries on a share link
// (docs/dev/collab.md): shown in presence and stored as `link:<name>` in the
// page's op log. Generated once per browser, Google-Docs style, and kept in
// localStorage so the same person keeps the same name across visits and
// pages; the share view's topbar lets them change it.
const KEY = "gamma-link-name";
export const LINK_NAME_MAX = 40; // mirrored in gamma/auth.py LINK_NAME_MAX

const ADJECTIVES = ["Curious", "Quiet", "Bright", "Gentle", "Swift", "Clever", "Brave", "Calm",
  "Merry", "Keen", "Bold", "Witty", "Nimble", "Patient", "Lively", "Sunny"];
const ANIMALS = ["Otter", "Heron", "Fox", "Owl", "Lynx", "Panda", "Koala", "Falcon",
  "Badger", "Dolphin", "Marten", "Puffin", "Ibis", "Gecko", "Lemur", "Beaver"];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function randomLinkName() {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

// Same cleaning as the server: control characters out, whitespace collapsed,
// capped. Empty when nothing is left, so callers can keep the old name.
export function cleanLinkName(raw) {
  return String(raw || "").replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim().slice(0, LINK_NAME_MAX).trim();
}

export function saveLinkName(name) {
  try { localStorage.setItem(KEY, name); } catch {}
}

// The stored name, minting and storing one on the first visit.
export function loadLinkName() {
  let stored = "";
  try { stored = cleanLinkName(localStorage.getItem(KEY)); } catch {}
  if (stored) return stored;
  const fresh = randomLinkName();
  saveLinkName(fresh);
  return fresh;
}
