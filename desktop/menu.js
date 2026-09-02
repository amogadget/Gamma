// The application menu.
//
// Deliberately thin. Every accelerator here steals a keystroke from the page,
// and the web UI already binds a lot of them (search, the command palette,
// block editing), so this sticks to what a native window is expected to
// provide: editing commands, zoom, reload-the-page, window management — plus
// the two things only the shell can do (switch mode, reveal the library).

const { app, Menu, dialog, shell } = require("electron");

const isMac = process.platform === "darwin";

function buildMenu(hooks = {}) {
  const { getWindow, getSupervisor, getSettings, reload, openChooser } = hooks;

  const revealLibrary = {
    label: "Show Library Folder",
    click: () => {
      const sup = getSupervisor && getSupervisor();
      const dir = sup && sup.info && sup.info.data_dir;
      if (dir) {
        shell.openPath(dir);
        return;
      }
      const settings = getSettings && getSettings();
      dialog.showMessageBox({
        type: "info",
        title: "Gamma",
        message: settings && settings.mode === "remote"
          ? "This Gamma runs on a server, so there is no library folder on this computer."
          : "The library folder isn't available yet.",
        buttons: ["OK"],
      });
    },
  };

  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Switch Server or Library…",
          click: () => openChooser && openChooser(),
        },
        revealLibrary,
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac ? [{ role: "pasteAndMatchStyle" }] : []),
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          // Not `role: "reload"`: reloading has to go back to the app's URL,
          // which after a backend restart may be on a different port.
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => reload && reload(),
        },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: isMac
        ? [
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { role: "front" },
          ]
        : [{ role: "minimize" }, { role: "close" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Backend Log",
          click: () => {
            const sup = getSupervisor && getSupervisor();
            const settings = getSettings && getSettings();
            const detail = sup && sup.tail()
              ? sup.tail()
              : settings && settings.mode === "remote"
                ? "This Gamma runs on a server, so there is no local backend."
                : "Nothing logged yet.";
            dialog.showMessageBox(getWindow && getWindow() ? getWindow() : undefined, {
              type: "info",
              title: "Backend Log",
              message: "The most recent output from Gamma's backend",
              detail,
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { buildMenu };
