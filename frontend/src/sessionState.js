// Session persistence localStorage wrapper.
// Saves viewer layout state so bare `/` restores the last workspace.

// One saved session per account and workspace. Never read the old unscoped
// cache: it may belong to another account that used this browser.
let scope = "";
const STORAGE_KEY = () => `gamma-session:${scope}`;

export function setSessionScope(user, ws) {
  clearTimeout(saveTimer);
  scope = user && ws ? `${user}@${ws}` : "";
}

// Fields to persist. Add new ones here and they'll auto-save + restore.
const SESSION_FIELDS = [
  "focusedBlockId",
  "pdfScale",
  "orientation",
  "pdfHidden",
  "notesVisible",
  "sidebarWidth",
  "sidebarHeight",
  "pdfPageNumber",
];

let saveTimer = null;

export function loadSession() {
  if (!scope) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY());
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveSession(state) {
  clearTimeout(saveTimer);
  if (!scope) return;
  saveTimer = setTimeout(() => {
    try {
      const merged = { ...loadSession(), ...state };
      // Only keep known fields
      const pruned = {};
      for (const k of SESSION_FIELDS) {
        if (k in merged) pruned[k] = merged[k];
      }
      localStorage.setItem(STORAGE_KEY(), JSON.stringify(pruned));
    } catch {
      // localStorage full or blocked; silently ignore
    }
  }, 300);
}

export function clearSession() {
  clearTimeout(saveTimer);
  if (!scope) return;
  try {
    localStorage.removeItem(STORAGE_KEY());
  } catch {}
}
