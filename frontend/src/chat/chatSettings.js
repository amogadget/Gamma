// Shared permission presets used by Settings and the chat settings shortcut.
export const READ_TOOLS = ["list", "read", "block_read", "search", "web_search", "web_read"];
export const WRITE_TOOLS = ["rename", "move", "block_edit"];
export const toolsForKind = (kind) => kind === "folder"
  ? [...READ_TOOLS, ...WRITE_TOOLS]
  : ["read", "block_read", "search", "web_search", "web_read", "block_edit"];

export function permissionPreset(kind, permissions = {}) {
  const keys = toolsForKind(kind);
  if (keys.every((key) => permissions[key] !== false)) return "edit";
  if (keys.every((key) => (permissions[key] !== false) === READ_TOOLS.includes(key))) return "read";
  return "custom";
}

export function presetPermissions(kind, preset) {
  return Object.fromEntries(toolsForKind(kind).map((key) => [key, preset === "edit" || READ_TOOLS.includes(key)]));
}
