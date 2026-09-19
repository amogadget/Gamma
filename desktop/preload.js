// Runs in every page the shell's views load. Two very different jobs:
//
// - file: pages (the launcher + the shell bar — the shell's own chrome) get
//   the `gammaShell` IPC bridge.
// - http(s) pages (a server's Gamma frontend) get NOTHING exposed. The
//   only thing that happens there is a read-only mirror: the page's
//   `data-theme` attribute is reported to the main process so the shell
//   chrome paints in the same theme. Gamma stays a black box.

const { contextBridge, ipcRenderer } = require('electron');

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('gammaShell', {
    platform: process.platform,
    state: () => ipcRenderer.invoke('shell:state'),
    list: () => ipcRenderer.invoke('shell:list'),
    addLocal: (name) => ipcRenderer.invoke('shell:add-local', name),
    addRemote: (name, url) => ipcRenderer.invoke('shell:add-remote', name, url),
    rename: (id, name) => ipcRenderer.invoke('shell:rename', id, name),
    remove: (id, opts) => ipcRenderer.invoke('shell:remove', id, opts),
    open: (id) => ipcRenderer.invoke('shell:open', id),
    openWorkspace: (id) => ipcRenderer.invoke('shell:open-workspace', id),
    launcher: () => ipcRenderer.invoke('shell:launcher'),
    reload: () => ipcRenderer.invoke('shell:reload'),
    revealData: (id) => ipcRenderer.invoke('shell:reveal-data', id),
    revealLog: (id) => ipcRenderer.invoke('shell:reveal-log', id),
    setSettings: (patch) => ipcRenderer.invoke('shell:set-settings', patch),
    pickFolder: (defaultPath) => ipcRenderer.invoke('shell:pick-folder', defaultPath),
    setDataRoot: (dir, opts) => ipcRenderer.invoke('shell:set-data-root', dir, opts),
    barExpand: (on) => ipcRenderer.invoke('shell:bar-expand', on),
    updateCheck: () => ipcRenderer.invoke('shell:update-check'),
    updateInstall: () => ipcRenderer.invoke('shell:update-install'),
    onState: (cb) => {
      const handler = (_e, state) => cb(state);
      ipcRenderer.on('shell:state', handler);
      return () => ipcRenderer.removeListener('shell:state', handler);
    },
  });
} else if (/^https?:$/.test(window.location.protocol)) {
  const report = () => {
    const t = document.documentElement.getAttribute('data-theme') || '';
    ipcRenderer.send('shell:theme', t);
  };
  const start = () => {
    report();
    new MutationObserver(report).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
