// Two jobs, decided by what the page is.
//
// On the shell's own pages (`file:` — the bar and the launcher) it exposes the
// IPC bridge they need. On a Gamma page it exposes **nothing**: that view
// loads the app's UI, remote servers in remote workspaces, and AI output, and
// none of it has any business reaching the main process. All it does there is
// report the page's theme so the chrome can match it.
//
// The main process re-checks the sender on every call rather than trusting
// this file alone (see shellOnly in main.js). Two cheap checks, because the
// consequence of getting it wrong is a remote page driving the shell.

const { contextBridge, ipcRenderer } = require("electron");

const isShellPage = location.protocol === "file:";

if (isShellPage) {
  contextBridge.exposeInMainWorld("gammaShell", {
    platform: process.platform,

    // State the bar and launcher render.
    state: () => ipcRenderer.invoke("shell:state"),
    details: () => ipcRenderer.invoke("shell:details"),
    onState: (fn) => {
      const handler = (_event, state) => fn(state);
      ipcRenderer.on("shell:state", handler);
      return () => ipcRenderer.removeListener("shell:state", handler);
    },

    // Workspaces.
    open: (id) => ipcRenderer.invoke("shell:open", id),
    addLocal: (name) => ipcRenderer.invoke("shell:add-local", name),
    addRemote: (name, url) => ipcRenderer.invoke("shell:add-remote", name, url),
    rename: (id, name) => ipcRenderer.invoke("shell:rename", id, name),
    remove: (id, opts) => ipcRenderer.invoke("shell:remove", id, opts),
    probe: (url) => ipcRenderer.invoke("shell:probe", url),

    // Shell chrome and shortcuts.
    launcher: () => ipcRenderer.invoke("shell:launcher"),
    reload: () => ipcRenderer.invoke("shell:reload"),
    expandBar: (on) => ipcRenderer.invoke("shell:bar-expand", on),
    revealData: (id) => ipcRenderer.invoke("shell:reveal-data", id),
    revealLog: (id) => ipcRenderer.invoke("shell:reveal-log", id),
    readLog: (id) => ipcRenderer.invoke("shell:read-log", id),
    setSettings: (patch) => ipcRenderer.invoke("shell:set-settings", patch),
  });
} else {
  // Mirror the app's theme into the shell's chrome. `data-theme` is absent for
  // dark, which is Gamma's default.
  const report = () => {
    ipcRenderer.send("shell:theme", document.documentElement.getAttribute("data-theme") || "");
  };
  const observe = () => {
    report();
    new MutationObserver(report).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observe, { once: true });
  } else {
    observe();
  }
}
