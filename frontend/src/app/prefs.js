// Every localStorage-backed user preference (the state behind the Settings
// dialog), declared in one hook so App.jsx doesn't carry thirty useState
// lines. One entry per storage key; a codec clamps stored values back into
// range so a stale or hand-edited localStorage never breaks the app.
import { usePersistedState, usePersistedFlag } from "../shared/lib/utils";
import { DEFAULT_TOOLS, normalizeTools } from "../ink/ink";

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

// Chip-display modes for home cards/rows; the codec and the Settings
// MenuSelect both derive from this list.
export const FILE_LABEL_MODES = ["off", "labels", "folders", "both"];

// Target languages for the PDF translated view. Codes mirror the backend's
// allowlist (TRANSLATE_LANGS in gamma/routers/ai.py) — keep the two in sync.
export const TRANSLATE_LANGS = [
  ["zh-CN", "中文（简体）"], ["zh-TW", "中文（繁體）"], ["en", "English"],
  ["ja", "日本語"], ["ko", "한국어"], ["de", "Deutsch"], ["fr", "Français"],
  ["es", "Español"], ["pt", "Português"], ["it", "Italiano"], ["ru", "Русский"],
];

// Agent per-tool permissions (Settings → Assistant → Tool configuration),
// one map per chat KIND: "folder" (the home/folder chat), "pdf" (a page with
// a PDF attached) and "notes" (a page without one). The chat picks its
// kind's map (chat/ChatDock.jsx) and sends it as the request's `permissions`.
// Missing keys mean allowed, so new tools default on for existing users;
// a pre-kind flat map ({list, read, …}) is applied to every kind.
export const CHAT_KINDS = ["folder", "pdf", "notes"];
const TOOL_PERMS_DEFAULT = {
  list: true, read: true, block_read: true, view: true, search: true,
  web_search: true, web_read: true,
  rename: true, move: true, block_edit: true,
};
const AGENT_PERMS_DEFAULT = Object.fromEntries(CHAT_KINDS.map((k) => [k, { ...TOOL_PERMS_DEFAULT }]));
const AGENT_PERMS_CODEC = {
  parse: (raw) => {
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object") return undefined;
      const perKind = CHAT_KINDS.some((k) => value[k] && typeof value[k] === "object");
      return Object.fromEntries(CHAT_KINDS.map((k) => [
        k, { ...TOOL_PERMS_DEFAULT, ...(perKind ? value[k] || {} : value) },
      ]));
    } catch { return undefined; }
  },
  serialize: JSON.stringify,
};

// Handwriting: the strip's tool presets (docs/dev/handwriting.md) and the
// eraser's S/M/L size index.
const INK_TOOLS_CODEC = {
  parse: (raw) => {
    try { return normalizeTools(JSON.parse(raw)); } catch { return undefined; }
  },
  serialize: JSON.stringify,
};
const SIZE_INDEX_CODEC = {
  parse: (raw) => {
    const value = Number.parseInt(raw, 10);
    return value >= 0 && value <= 2 ? value : undefined;
  },
  serialize: String,
};

export const THEMES = ["system", "light", "dark", "gamma-light", "gamma-dark", "sepia", "solarized", "gray"];

// Interface size (Settings → Appearance): text and control boxes share
// --ui-scale in app.css. Ctrl+scroll further resizes notes/chat text in place
// per panel and never persists. PDF zoom remains independent. The
// index.html pre-paint script repeats the bounds — keep them in step.
export const UI_SCALE = { min: 0.7, max: 1.6, step: 0.1, default: 1 };

export function useAppPrefs() {
  // --- Appearance (Settings → General) ---
  // System follows the OS; the other themes pin the appearance.
  // Sepia, Solarized Light, and Gray also tint PDF pages (app.css).
  // Theme and pdfDarkPage additionally follow the account through
  // /api/prefs/appearance (App.jsx): server wins on login, changes push back,
  // this localStorage copy stays the instant-paint cache.
  const [theme, setTheme] = usePersistedState("gamma-theme", "system", {
    parse: (raw) => (THEMES.includes(raw) ? raw : undefined),
  });
  // Flip page colors: display-only inverted (night) rendering of the PDF canvas.
  const [pdfDarkPage, setPdfDarkPage] = usePersistedFlag("gamma-pdf-dark", false);
  // Interface size: index.html applies the stored value before first paint,
  // App.jsx keeps `--ui-scale` on the root in sync afterwards.
  const [uiScale, setUiScale] = usePersistedState("gamma-ui-scale", 1, {
    parse: (raw) => {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n >= UI_SCALE.min && n <= UI_SCALE.max ? Math.round(n * 100) / 100 : undefined;
    },
  });
  // Recently-viewed cards on the home page (only — library cards always use
  // the glyph): cover thumbnails (a snapshot of the PDF at the last-read
  // spot). Off shows the file icon instead and stops capturing new ones.
  const [recentThumbs, setRecentThumbs] = usePersistedFlag("gamma-recent-thumbs", true);
  // Folder/label chips on home file cards and list rows.
  const [fileLabels, setFileLabels] = usePersistedState("gamma-home-file-labels", "both", {
    parse: (raw) => (FILE_LABEL_MODES.includes(raw) ? raw : undefined),
  });

  // --- Papers (Settings → General) ---
  const [oaFallback, setOaFallback] = usePersistedFlag("gamma-oa-fallback", true);
  const [metaAutoFetch, setMetaAutoFetch] = usePersistedFlag("gamma-meta-auto", true);
  const [pdfSaveLocal, setPdfSaveLocal] = usePersistedFlag("gamma-pdf-save", true);

  // --- PDF viewer (Settings → Reading) ---
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
  // Target language for the translated view (the 文A button in the viewer).
  const [translateLang, setTranslateLang] = usePersistedState("gamma-translate-lang", "zh-CN", {
    parse: (raw) => (TRANSLATE_LANGS.some(([code]) => code === raw) ? raw : undefined),
  });
  // Parallel translation requests: chunks of a page are translated this many
  // at a time — the whole-document queue never exceeds it either. Typed in
  // Settings, clamped to 1–32 (a chunk is ~1200 chars, so even 32 stays well
  // under provider rate limits for most accounts).
  const [translateParallel, setTranslateParallel] = usePersistedState("gamma-translate-parallel", 3, {
    parse: (raw) => {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= 1 && n <= 32 ? n : undefined;
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
  // PDF the compact find bar shows nothing. Page view: compact unless on.
  const [searchDetailsHome, setSearchDetailsHome] = usePersistedFlag("gamma-search-details-home", true);
  const [searchDetailsPaper, setSearchDetailsPaper] = usePersistedFlag("gamma-search-details", false);

  // --- Notes (Settings → Reading) ---
  // Enter key in the note editor: off (default) = Enter types a line break and
  // Shift+Enter starts a new note; on = the Logseq-style swap of the two.
  const [enterNewNote, setEnterNewNote] = usePersistedFlag("gamma-enter-new-note", false);

  // --- Interface (Settings → Advanced) ---
  // The always-on status bar under the tabs — off by default, the floating
  // pill carries user-facing messages; the bar is a debugging aid.
  const [statusBarVisible, setStatusBarVisible] = usePersistedFlag("gamma-status-bar", false);

  // --- AI models (Settings → Assistant) ---
  const [chatEffort, setChatEffort] = usePersistedState("gamma-chat-effort", "");
  // Connection check of the active provider at login (POST /api/ai/health):
  // "ping" (default) is the free credential check — OAuth entries hit the
  // usage endpoint, API keys list /v1/models, both 401 on a dead credential
  // without spending tokens; "test" runs the tiny live completion (the same
  // probe as the settings Test button, through the entry's test model).
  const [aiLoginCheck, setAiLoginCheck] = usePersistedState("gamma-ai-login-check", "ping", {
    parse: (raw) => (["off", "ping", "test"].includes(raw) ? raw : undefined),
  });
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
  const [chatContextChars, setChatContextChars] = usePersistedState("gamma-chat-context-chars", 60000, CONTEXT_CHARS_CODEC);
  const [metaContextChars, setMetaContextChars] = usePersistedState("gamma-meta-context-chars", 6000, CONTEXT_CHARS_CODEC);
  const [multiContextChars, setMultiContextChars] = usePersistedState("gamma-multi-context-chars", 120000, CONTEXT_CHARS_CODEC);
  const [toolRounds, setToolRounds] = usePersistedState("gamma-ai-tool-rounds", 32, TOOL_ROUNDS_CODEC);
  // Per-read_page-call cap on document text the folder/paper agent may pull.
  // The default matches the backend's fallback (READ_CHARS_CAP in
  // gamma/ai_tools.py) — keep the two in sync.
  const [agentReadChars, setAgentReadChars] = usePersistedState("gamma-ai-read-chars", 20000, CONTEXT_CHARS_CODEC);
  const [agentPerms, setAgentPerms] = usePersistedState("gamma-ai-agent-perms", AGENT_PERMS_DEFAULT, AGENT_PERMS_CODEC);
  // Master kill-switch for tool use in every chat (folder and page alike).
  // A chat can still turn tools off for itself from its header.
  const [agentEnabled, setAgentEnabled] = usePersistedFlag("gamma-ai-agent-enabled", true);

  // --- Handwriting (Settings → Editor → PDF viewer; docs/dev/handwriting.md) ---
  // Device-specific, so none of these sync. inkPenOnly: fingers never draw
  // (they scroll and pinch) — default on where the primary pointer is coarse
  // (tablets). inkAutoPen: a stylus draws with the pen even when no tool is
  // armed. inkPressure: use the stylus pressure for stroke width.
  const coarse = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
  const [inkPenOnly, setInkPenOnly] = usePersistedFlag("gamma-ink-pen-only", coarse);
  const [inkAutoPen, setInkAutoPen] = usePersistedFlag("gamma-ink-auto-pen", true);
  const [inkPressure, setInkPressure] = usePersistedFlag("gamma-ink-pressure", true);
  // The strip's tool presets: [{id, kind: pen|highlighter, color, size}],
  // the user's own row of pens and highlighters (ink.js DEFAULT_TOOLS).
  const [inkTools, setInkTools] = usePersistedState("gamma-ink-tools", DEFAULT_TOOLS, INK_TOOLS_CODEC);
  // "stroke" erases whole strokes, "partial" cuts through them; the size
  // is an S/M/L index (ink/InkLayer.jsx ERASER_SIZES).
  const [inkEraserMode, setInkEraserMode] = usePersistedState("gamma-ink-eraser", "stroke", {
    parse: (raw) => (["stroke", "partial"].includes(raw) ? raw : undefined),
  });
  const [inkEraserSize, setInkEraserSize] = usePersistedState("gamma-ink-eraser-size", 1, SIZE_INDEX_CODEC);
  // The lasso draws a freeform loop or a box.
  const [inkLassoMode, setInkLassoMode] = usePersistedState("gamma-ink-lasso", "free", {
    parse: (raw) => (["free", "box"].includes(raw) ? raw : undefined),
  });

  // --- Chat behavior (Settings → Assistant) ---
  // Off by default: rectangle snapshots stay attached until removed or sent.
  // On, a plain click elsewhere in the PDF drops them — the same gesture that
  // clears quoted text selections.
  const [chatImgAutoClear, setChatImgAutoClear] = usePersistedFlag("gamma-chat-img-autoclear", false);

  return {
    theme, setTheme, pdfDarkPage, setPdfDarkPage, uiScale, setUiScale,
    recentThumbs, setRecentThumbs, fileLabels, setFileLabels,
    oaFallback, setOaFallback, metaAutoFetch, setMetaAutoFetch, pdfSaveLocal, setPdfSaveLocal,
    embAnnots, setEmbAnnots,
    translateEnabled, setTranslateEnabled,
    translateLang, setTranslateLang, translateModel, setTranslateModel,
    translateEffort, setTranslateEffort, translateParallel, setTranslateParallel,
    searchDetailsHome, setSearchDetailsHome, searchDetailsPaper, setSearchDetailsPaper,
    enterNewNote, setEnterNewNote,
    statusBarVisible, setStatusBarVisible,
    chatEffort, setChatEffort, aiLoginCheck, setAiLoginCheck, metaModel, setMetaModel,
    dictationModel, setDictationModel, dictationLang, setDictationLang,
    chatSystem, setChatSystem, agentSystem, setAgentSystem,
    metaPrompt, setMetaPrompt, citePrompt, setCitePrompt,
    chatContextChars, setChatContextChars, metaContextChars, setMetaContextChars,
    multiContextChars, setMultiContextChars,
    toolRounds, setToolRounds, agentReadChars, setAgentReadChars, agentPerms, setAgentPerms,
    agentEnabled, setAgentEnabled,
    chatImgAutoClear, setChatImgAutoClear,
    inkPenOnly, setInkPenOnly, inkAutoPen, setInkAutoPen, inkPressure, setInkPressure,
    inkTools, setInkTools, inkEraserMode, setInkEraserMode, inkEraserSize, setInkEraserSize,
    inkLassoMode, setInkLassoMode,
  };
}
