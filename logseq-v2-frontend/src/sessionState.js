// Session persistence localStorage wrapper.
// Saves viewer layout state so bare `/` restores the last workspace.

const STORAGE_KEY = "gamma-session";

// Fields to persist. Add new ones here and they'll auto-save + restore.
const SESSION_FIELDS = [
  "focusedBlockId",
  "pdfScale",
  "orientation",
  "pdfHidden",
  "notesVisible",
  "sidebarWidth",
  "sidebarHeight",
];

let saveTimer = null;

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveSession(state) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const merged = { ...loadSession(), ...state };
      // Only keep known fields
      const pruned = {};
      for (const k of SESSION_FIELDS) {
        if (k in merged) pruned[k] = merged[k];
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
    } catch {
      // localStorage full or blocked; silently ignore
    }
  }, 300);
}

export function clearSession() {
  clearTimeout(saveTimer);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
