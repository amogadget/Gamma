// Old entry points stay valid while everyday preferences use five destinations.
export const PANE_ALIASES = {
  general: "appearance", papers: "appearance", viewer: "reading", notes: "reading", search: "reading",
  context: "ai-advanced", workspace: "workspaces", advanced: "diagnostics",
};
export const resolveSettingsPane = (pane) => PANE_ALIASES[pane] || pane;

// Search names the actual setting, including settings on the second-level AI pages.
const entries = [
  ["appearance", "Theme", "dark light sepia gray system colors"],
  ["appearance", "Dark PDF pages", "flip invert page colors"],
  ["appearance", "Control size", "zoom buttons scale touch"],
  ["appearance", "Status bar", "notifications messages"],
  ["reading", "Snap vertical scrolling", "PDF swipe touch"],
  ["reading", "Imported annotations", "hide strip highlights PDF"],
  ["reading", "Show translation shortcut", "translation button"],
  ["reading", "Translate into", "translation language"],
  ["reading", "Enter key", "notes line keyboard shift"],
  ["reading", "Note badges on highlights", "bubble PDF"],
  ["reading", "On the home page", "search expand results"],
  ["reading", "On a page", "search expand results find"],
  ["library", "Recents thumbnails", "snapshots library home display"],
  ["library", "File labels", "folders chips library display"],
  ["library", "Open-access fallback", "download PDF publisher free"],
  ["library", "Auto-fetch metadata", "title authors BibTeX DOI"],
  ["library", "Save external PDFs", "download storage offline URL"],
  ["ai", "Connections", "provider credentials API key ChatGPT login service"],
  ["ai", "Default chat model", "AI model"],
  ["ai", "Metadata model", "AI extraction identifiers"],
  ["ai", "Translation model", "AI translate"],
  ["ai", "Dictation model", "speech voice mic transcription"],
  ["ai", "Dictation language", "speech voice mic"],
  ["assistant", "Allow assistant tools", "master switch permissions"],
  ["assistant", "Folder chat", "permissions tools read search edit rename move"],
  ["assistant", "PDF chat", "permissions tools read search edit"],
  ["assistant", "Notes chat", "permissions tools read search edit"],
  ["assistant", "Clear snapshots on click", "chat images selections"],
  ["assistant", "Context budget", "context size characters limits pages"],
  ["ai-advanced", "Tool rounds", "advanced tool requests limits"],
  ["ai-advanced", "Read window", "advanced context characters"],
  ["ai-advanced", "Single paper", "advanced context budget"],
  ["ai-advanced", "Metadata extraction", "advanced context budget"],
  ["ai-advanced", "Multi-paper total", "advanced context budget"],
  ["ai-advanced", "Default reasoning effort", "advanced thinking"],
  ["ai-advanced", "Translation effort", "advanced thinking"],
  ["ai-advanced", "Parallel requests", "advanced translation concurrency speed"],
  ["ai", "Check at login", "connection test credential ping"],
  ["prompts", "Custom prompts", "system prompt citation metadata agent"],
  ["account", "Account", "profile password storage quota"],
  ["workspaces", "Workspaces", "members sharing import export storage quota default"],
  ["backups", "Backups", "snapshot restore merge download"],
  ["maintenance", "Library maintenance", "metadata health text index rebuild papers"],
  ["users", "Users", "administration accounts password limits personal workspaces"],
  ["server", "Server", "administration storage defaults shared workspaces backups log"],
  ["diagnostics", "Debug logging", "diagnostics tracing browser system log"],
];
export const SETTINGS_SEARCH = entries.map(([pane, label, keywords]) => ({ pane, label, keywords }));
export function searchSettings(query, allowedPanes) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return SETTINGS_SEARCH.filter(({ pane, label, keywords }) => allowedPanes.includes(pane)
    && words.every((word) => `${label} ${keywords}`.toLocaleLowerCase().includes(word)));
}
