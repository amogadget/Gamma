// Where the pre-workspaces app kept its one library.
//
// That version had a single local library in the platform's application
// support directory, chosen by gamma/desktop.py::default_data_dir(). The
// migration in registry.js adopts that directory as a workspace instead of
// starting an empty one, so upgrading does not appear to lose every note.
//
// These paths must stay in step with default_data_dir() on the Python side.
// They are not used for anything else: new workspaces live under the shell's
// own userData directory.

const os = require("node:os");
const path = require("node:path");

function defaultDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Gamma");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Gamma");
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "gamma");
}

module.exports = { defaultDataDir };
