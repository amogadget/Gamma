// The only bridge into the main process, and it is attached to the chooser
// window alone — never to the window that loads Gamma itself, whose content
// includes remote pages and AI output.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gamma", {
  state: () => ipcRenderer.invoke("chooser:state"),
  probe: (url) => ipcRenderer.invoke("chooser:probe", url),
  choose: (choice) => ipcRenderer.invoke("chooser:choose", choice),
  cancel: () => ipcRenderer.invoke("chooser:cancel"),
});
