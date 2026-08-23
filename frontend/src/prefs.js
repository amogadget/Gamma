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

export function useAppPrefs() {
  // --- Appearance (Settings → General) ---
  // Theme: "system" follows the OS; "light"/"dark" pin it.
  const [theme, setTheme] = usePersistedState("gamma-theme", "system", {
    parse: (raw) => (raw === "system" || raw === "light" || raw === "dark" ? raw : undefined),
  });
  // Flip page colors: display-only inverted (night) rendering of the PDF canvas.
  const [pdfDarkPage, setPdfDarkPage] = usePersistedFlag("gamma-pdf-dark", false);
  // Recently-viewed cards on the home page: cover thumbnails (a snapshot of
  // the PDF at the last-read spot). Off also stops capturing new ones.
  const [recentThumbs, setRecentThumbs] = usePersistedFlag("gamma-recent-thumbs", true);

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
  const [agentPerms, setAgentPerms] = usePersistedState("gamma-ai-agent-perms", AGENT_PERMS_DEFAULT, AGENT_PERMS_CODEC);

  // --- Chat behavior (Settings → Assistant) ---
  // Off by default: rectangle snapshots stay attached until removed or sent.
  // On, a plain click elsewhere in the PDF drops them — the same gesture that
  // clears quoted text selections.
  const [chatImgAutoClear, setChatImgAutoClear] = usePersistedFlag("gamma-chat-img-autoclear", false);

  return {
    theme, setTheme, pdfDarkPage, setPdfDarkPage, recentThumbs, setRecentThumbs,
    oaFallback, setOaFallback, metaAutoFetch, setMetaAutoFetch, pdfSaveLocal, setPdfSaveLocal,
    snapVertical, setSnapVertical, embAnnots, setEmbAnnots,
    searchDetailsHome, setSearchDetailsHome, searchDetailsPaper, setSearchDetailsPaper,
    enterNewNote, setEnterNewNote, hlNoteBadges, setHlNoteBadges,
    statusBarVisible, setStatusBarVisible,
    chatEffort, setChatEffort, metaModel, setMetaModel,
    dictationModel, setDictationModel, dictationLang, setDictationLang,
    chatSystem, setChatSystem, agentSystem, setAgentSystem,
    metaPrompt, setMetaPrompt, citePrompt, setCitePrompt,
    chatContextChars, setChatContextChars, metaContextChars, setMetaContextChars,
    multiContextChars, setMultiContextChars,
    toolRounds, setToolRounds, agentPerms, setAgentPerms,
    chatImgAutoClear, setChatImgAutoClear,
  };
}
