// Every localStorage-backed user preference (the state behind the Settings
// dialog), declared in one hook so App.jsx doesn't carry thirty useState
// lines. One entry per storage key; a codec clamps stored values back into
// range so a stale or hand-edited localStorage never breaks the app.
import { usePersistedState, usePersistedFlag } from "./utils";

// AI context-size preferences (chars of extracted PDF text): clamp stored
// values to a sane range, fall back to the default otherwise.
const CONTEXT_CHARS_CODEC = {
  parse: (raw) => {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 100 && value <= 1000000 ? value : undefined;
  },
};

// Organizer tool-round budget (home/folder chat agent loop), 1–100.
const TOOL_ROUNDS_CODEC = {
  parse: (raw) => {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 1 && value <= 100 ? value : undefined;
  },
};

// Folder-agent per-tool permissions (Settings → Assistant → Folder agent).
// Missing keys mean allowed, so new tools default on for existing users.
const AGENT_PERMS_DEFAULT = { list: true, read: true, search: true, rename: true, move: true };
const AGENT_PERMS_CODEC = {
  parse: (raw) => {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" ? { ...AGENT_PERMS_DEFAULT, ...value } : undefined;
    } catch { return undefined; }
  },
  serialize: JSON.stringify,
};

// Target languages for the PDF translated view. Codes mirror the backend's
// allowlist (TRANSLATE_LANGS in gamma/routers/ai.py) — keep the two in sync.
export const TRANSLATE_LANGS = [
  ["zh-CN", "中文（简体）"], ["zh-TW", "中文（繁體）"], ["en", "English"],
  ["ja", "日本語"], ["ko", "한국어"], ["de", "Deutsch"], ["fr", "Français"],
  ["es", "Español"], ["pt", "Português"], ["it", "Italiano"], ["ru", "Русский"],
];

export const THEMES = ["system", "light", "dark", "sepia", "gray"];

export function useAppPrefs() {
  // --- Appearance (Settings → General) ---
  // Theme: "system" follows the OS; the rest pin it. "sepia" is the warm
  // eye-comfort mode (Solarized Light) and "gray" its neutral counterpart;
  // both also tint the PDF page (app.css), no separate toggle.
  // Theme and pdfDarkPage additionally follow the account through
  // /api/prefs/appearance (App.jsx): server wins on login, changes push back,
  // this localStorage copy stays the instant-paint cache.
  const [theme, setTheme] = usePersistedState("gamma-theme", "system", {
    parse: (raw) => (THEMES.includes(raw) ? raw : undefined),
  });
  // Flip page colors: display-only inverted (night) rendering of the PDF canvas.
  const [pdfDarkPage, setPdfDarkPage] = usePersistedFlag("gamma-pdf-dark", false);
  // Recently-viewed cards on the home page (only — library cards always use
  // the glyph): cover thumbnails (a snapshot of the PDF at the last-read
  // spot). Off shows the file icon instead and stops capturing new ones.
  const [recentThumbs, setRecentThumbs] = usePersistedFlag("gamma-recent-thumbs", true);
  // Folder/label chips on home file cards and list rows.
  const [fileLabels, setFileLabels] = usePersistedState("gamma-home-file-labels", "both", {
    parse: (raw) => (raw === "off" || raw === "labels" || raw === "folders" || raw === "both" ? raw : undefined),
  });

  // --- Papers (Settings → General) ---
  const [oaFallback, setOaFallback] = usePersistedFlag("gamma-oa-fallback", true);
  const [metaAutoFetch, setMetaAutoFetch] = usePersistedFlag("gamma-meta-auto", true);
  const [pdfSaveLocal, setPdfSaveLocal] = usePersistedFlag("gamma-pdf-save", true);

  // --- PDF viewer (Settings → Reading) ---
  // Touch scrolling in a zoomed-in PDF: a near-vertical one-finger swipe keeps
  // the horizontal position it started from, so the text column doesn't wander
  // sideways as you read down the page.
  const [snapVertical, setSnapVertical] = usePersistedFlag("gamma-snap-vertical", true);
  // Embedded PDF annotations (burned in by a Gamma export or another viewer)
  // would render twice once imported as blocks — canvas + overlay. "hide"
  // keeps them out of the canvas; "strip" removes them from the stored file
  // at import time.
  const [embAnnots, setEmbAnnots] = usePersistedState("gamma-embedded-annots", "hide", {
    parse: (raw) => (raw === "hide" || raw === "strip" ? raw : undefined),
  });

  // --- Translation (Settings → Reading → PDF viewer) ---
  // Master switch: off removes the translate button from the viewer.
  const [translateEnabled, setTranslateEnabled] = usePersistedFlag("gamma-translate-enabled", true);
  // Target language for the translated view (the languages button in the viewer).
  const [translateLang, setTranslateLang] = usePersistedState("gamma-translate-lang", "zh-CN", {
    parse: (raw) => (TRANSLATE_LANGS.some(([code]) => code === raw) ? raw : undefined),
  });
  // Parallel translation requests: chunks of a page are translated this many
  // at a time — the whole-document queue never exceeds it either. Typed in
  // Settings, clamped to 1–8. (Upstream allows up to 32; this fork keeps the
  // lower ceiling until real provider rate-limit behavior is measured, since
  // every extra slot is a concurrent paid request.)
  const [translateParallel, setTranslateParallel] = usePersistedState("gamma-translate-parallel", 3, {
    parse: (raw) => {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= 1 && n <= 8 ? n : undefined;
    },
  });
  // Model for page translation. "" = follow the chat model; a stale pick
  // (provider/model removed) also falls back.
  const [translateModel, setTranslateModel] = usePersistedState("gamma-translate-model", "");
  // Reasoning effort for translation calls. "" = provider default (param
  // omitted — some models reject it outright, so that stays the safe
  // default); Low/Minimal is the speed lever for reasoning models, which
  // otherwise spend their thinking budget before the first output token.
  const [translateEffort, setTranslateEffort] = usePersistedState("gamma-translate-effort", "", {
    parse: (raw) => (["", "minimal", "low", "medium", "high"].includes(raw) ? raw : undefined),
  });

  // --- Search (Settings → Reading) ---
  // Whether the search popover's result-detail lists start expanded, one
  // default per place. Home page: expanded unless turned off — with no open
  // PDF the compact find bar shows nothing. Paper view: compact unless on.
  const [searchDetailsHome, setSearchDetailsHome] = usePersistedFlag("gamma-search-details-home", true);
  const [searchDetailsPaper, setSearchDetailsPaper] = usePersistedFlag("gamma-search-details", false);

  // --- Notes (Settings → Reading) ---
  // Enter key in the note editor: off (default) = Enter types a line break and
  // Shift+Enter starts a new note; on = the Logseq-style swap of the two.
  const [enterNewNote, setEnterNewNote] = usePersistedFlag("gamma-enter-new-note", false);
  // Speech-bubble badge on PDF highlights that carry a typed note.
  const [hlNoteBadges, setHlNoteBadges] = usePersistedFlag("gamma-hl-note-badge", true);

  // --- Interface (Settings → Advanced) ---
  // The always-on status bar under the tabs — off by default, the floating
  // pill carries user-facing messages; the bar is a debugging aid.
  const [statusBarVisible, setStatusBarVisible] = usePersistedFlag("gamma-status-bar", false);

  // --- AI models (Settings → Assistant) ---
  const [chatEffort, setChatEffort] = usePersistedState("gamma-chat-effort", "");
  // Model for AI metadata extraction. "" = follow the chat model; a stale
  // pick (provider/model removed) also falls back.
  const [metaModel, setMetaModel] = usePersistedState("gamma-meta-model", "");
  // Voice dictation (mic button): transcription model + spoken language
  // ("" = auto-detect).
  const [dictationModel, setDictationModel] = usePersistedState("gamma-dictation-model", "gpt-4o-transcribe");
  const [dictationLang, setDictationLang] = usePersistedState("gamma-dictation-lang", "");

  // --- Prompts (Settings → Prompts; "" = built-in default from /api/ai/models) ---
  const [chatSystem, setChatSystem] = usePersistedState("gamma-chat-system", "");
  const [agentSystem, setAgentSystem] = usePersistedState("gamma-agent-system", "");
  const [metaPrompt, setMetaPrompt] = usePersistedState("gamma-meta-prompt", "");
  const [citePrompt, setCitePrompt] = usePersistedState("gamma-cite-prompt", "");

  // --- Context budgets + folder agent (Settings → Assistant) ---
  const [chatContextChars, setChatContextChars] = usePersistedState("gamma-chat-context-chars", 8000, CONTEXT_CHARS_CODEC);
  const [metaContextChars, setMetaContextChars] = usePersistedState("gamma-meta-context-chars", 6000, CONTEXT_CHARS_CODEC);
  const [multiContextChars, setMultiContextChars] = usePersistedState("gamma-multi-context-chars", 18000, CONTEXT_CHARS_CODEC);
  const [toolRounds, setToolRounds] = usePersistedState("gamma-ai-tool-rounds", 32, TOOL_ROUNDS_CODEC);
  // Per-read_page-call cap on document text the folder/paper agent may pull.
  const [agentReadChars, setAgentReadChars] = usePersistedState("gamma-ai-read-chars", 20000, CONTEXT_CHARS_CODEC);
  const [agentPerms, setAgentPerms] = usePersistedState("gamma-ai-agent-perms", AGENT_PERMS_DEFAULT, AGENT_PERMS_CODEC);
  // Master kill-switch plus the starting state for each chat scope. A chat can
  // override its own tool set from the header; PDF chat starts conservative,
  // while the library/folder organizer keeps its existing agent-first default.
  const [agentEnabled, setAgentEnabled] = usePersistedFlag("gamma-ai-agent-enabled", true);
  const [folderToolsDefault, setFolderToolsDefault] = usePersistedFlag("gamma-ai-folder-tools-default", true);
  const [pdfToolsDefault, setPdfToolsDefault] = usePersistedFlag("gamma-ai-pdf-tools-default", false);

  // --- Chat behavior (Settings → Assistant) ---
  // Off by default: rectangle snapshots stay attached until removed or sent.
  // On, a plain click elsewhere in the PDF drops them — the same gesture that
  // clears quoted text selections.
  const [chatImgAutoClear, setChatImgAutoClear] = usePersistedFlag("gamma-chat-img-autoclear", false);

  return {
    theme, setTheme, pdfDarkPage, setPdfDarkPage, recentThumbs, setRecentThumbs,
    fileLabels, setFileLabels,
    oaFallback, setOaFallback, metaAutoFetch, setMetaAutoFetch, pdfSaveLocal, setPdfSaveLocal,
    snapVertical, setSnapVertical, embAnnots, setEmbAnnots,
    translateEnabled, setTranslateEnabled,
    translateLang, setTranslateLang, translateModel, setTranslateModel,
    translateEffort, setTranslateEffort, translateParallel, setTranslateParallel,
    searchDetailsHome, setSearchDetailsHome, searchDetailsPaper, setSearchDetailsPaper,
    enterNewNote, setEnterNewNote, hlNoteBadges, setHlNoteBadges,
    statusBarVisible, setStatusBarVisible,
    chatEffort, setChatEffort, metaModel, setMetaModel,
    dictationModel, setDictationModel, dictationLang, setDictationLang,
    chatSystem, setChatSystem, agentSystem, setAgentSystem,
    metaPrompt, setMetaPrompt, citePrompt, setCitePrompt,
    chatContextChars, setChatContextChars, metaContextChars, setMetaContextChars,
    multiContextChars, setMultiContextChars,
    toolRounds, setToolRounds, agentReadChars, setAgentReadChars, agentPerms, setAgentPerms,
    agentEnabled, setAgentEnabled, folderToolsDefault, setFolderToolsDefault,
    pdfToolsDefault, setPdfToolsDefault,
    chatImgAutoClear, setChatImgAutoClear,
  };
}
