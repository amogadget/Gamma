// The launcher: every workspace, what state it is in, and what can be done
// with it. Shown at first launch, when a workspace fails to open (with the
// reason), and from the switcher.

const $ = (id) => document.getElementById(id);
const shell = window.gammaShell;

let state = { workspaces: [], current: null, settings: {}, platform: "linux" };

$("mark").innerHTML = ICONS.mark;
$("addLocal").innerHTML = `${ICONS.plus}New library on this computer`;
$("addRemote").innerHTML = `${ICONS.remote}Connect to a server…`;

// --- helpers -----------------------------------------------------------------

function say(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

function bytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function whenText(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function iconButton(icon, title, onClick) {
  const b = document.createElement("button");
  b.className = "iconBtn";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = icon;
  b.addEventListener("click", onClick);
  return b;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- rendering ---------------------------------------------------------------

function card(ws) {
  const root = el("div", "card");
  root.dataset.id = ws.id;
  root.dataset.name = ws.name;

  const kind = el("div", "kind");
  kind.innerHTML = ICONS[ws.type];
  kind.title = ws.type === "local" ? "on this computer" : "a server you run";

  const info = el("div", "info");
  const name = el("div", "name");
  name.append(el("span", "text", ws.name));
  if (ws.running) {
    const dot = el("span", "dot");
    dot.title = "its server is running";
    name.append(dot);
  }
  if (state.current && state.current.id === ws.id) name.append(el("span", "badge accent", "open"));
  else if (state.lastOpened === ws.id) name.append(el("span", "badge", "last used"));

  const detail = el("div", "detail");
  const parts = [];
  if (ws.type === "local") {
    if (Number.isFinite(ws.sizeBytes)) parts.push(bytes(ws.sizeBytes));
    parts.push(ws.dataDir);
  } else {
    parts.push(ws.url);
  }
  const when = whenText(ws.lastOpenedAt);
  if (when) parts.push(when);
  parts.forEach((text, i) => {
    if (i) detail.append(el("span", "sep", "·"));
    detail.append(document.createTextNode(text));
  });

  info.append(name, detail);

  const actions = el("div", "actions");
  const openBtn = el("button", "btn", "Open");
  openBtn.classList.add(state.current && state.current.id === ws.id ? "quiet" : "primary");
  openBtn.addEventListener("click", () => openWorkspace(ws));
  actions.append(openBtn);

  actions.append(iconButton(ICONS.pencil, "Rename", () => askRename(ws)));
  if (ws.type === "local") {
    actions.append(iconButton(ICONS.folder, "Show the library folder", () => shell.revealData(ws.id)));
    actions.append(iconButton(ICONS.log, "Server log", () => showLog(ws)));
  }
  actions.append(iconButton(ICONS.trash, "Remove", () => askRemove(ws)));

  root.append(kind, info, actions);
  return root;
}

function render() {
  document.documentElement.setAttribute("data-theme", state.theme || "dark");
  $("version").textContent = state.version ? `Gamma ${state.version}` : "";
  $("userDataDir").textContent = state.userDataDir || "";
  $("openLast").setAttribute("aria-checked", String(Boolean(state.settings.openLastOnLaunch)));

  const groups = $("groups");
  groups.textContent = "";

  if (!state.workspaces.length) {
    const empty = el("div", "empty");
    empty.innerHTML =
      "No workspaces yet. Create a <b>library on this computer</b> to keep your " +
      "papers here, or <b>connect to a server</b> you already run.";
    groups.append(empty);
    return;
  }

  for (const [label, type] of [["On this computer", "local"], ["Servers", "remote"]]) {
    const list = state.workspaces.filter((w) => w.type === type);
    if (!list.length) continue;
    groups.append(el("div", "groupLabel", label));
    const cards = el("div", "cards");
    for (const ws of list) cards.append(card(ws));
    groups.append(cards);
  }
}

async function refresh() {
  state = await shell.details();
  render();
}

// --- actions -----------------------------------------------------------------

async function openWorkspace(ws) {
  say(ws.type === "local" ? `Starting ${ws.name}…` : `Connecting to ${ws.name}…`);
  try {
    await shell.open(ws.id);
  } catch (err) {
    // The shell reloads this page with ?error= when an open fails, so there is
    // nothing to show here — but if it somehow does not, say something.
    say((err && err.message) || String(err), "error");
  }
}

function dialog(id) {
  const dlg = $(id);
  return {
    show(reset) {
      if (reset) reset();
      dlg.showModal();
    },
    close: () => dlg.close(),
    error: (text) => {
      const err = dlg.querySelector(".err");
      if (err) err.textContent = text || "";
    },
  };
}

const dlgLocal = dialog("dlgLocal");
const dlgRemote = dialog("dlgRemote");
const dlgRename = dialog("dlgRename");
const dlgRemove = dialog("dlgRemove");
const dlgLog = dialog("dlgLog");

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => $(button.dataset.close).close());
}

$("addLocal").addEventListener("click", () =>
  dlgLocal.show(() => {
    $("localName").value = "";
    dlgLocal.error("");
  }),
);

$("createLocal").addEventListener("click", async () => {
  const button = $("createLocal");
  button.disabled = true;
  try {
    const ws = await shell.addLocal($("localName").value);
    dlgLocal.close();
    await refresh();
    await openWorkspace(ws);
  } catch (err) {
    dlgLocal.error((err && err.message) || String(err));
  } finally {
    button.disabled = false;
  }
});

$("addRemote").addEventListener("click", () =>
  dlgRemote.show(() => {
    $("remoteUrl").value = "";
    $("remoteName").value = "";
    dlgRemote.error("");
  }),
);

$("createRemote").addEventListener("click", async () => {
  const button = $("createRemote");
  const url = $("remoteUrl").value.trim();
  if (!url) {
    dlgRemote.error("Enter the address of your Gamma server.");
    return;
  }
  button.disabled = true;
  button.textContent = "Checking…";
  dlgRemote.error("");
  try {
    // The shell probes /api/health before adding it, so a typo is a sentence
    // here rather than a browser error page later.
    const ws = await shell.addRemote($("remoteName").value, url);
    dlgRemote.close();
    await refresh();
    await openWorkspace(ws);
  } catch (err) {
    dlgRemote.error((err && err.message) || String(err));
  } finally {
    button.disabled = false;
    button.textContent = "Add";
  }
});

function askRename(ws) {
  dlgRename.show(() => {
    $("renameName").value = ws.name;
    dlgRename.error("");
    $("doRename").onclick = async () => {
      try {
        await shell.rename(ws.id, $("renameName").value);
        dlgRename.close();
        refresh();
      } catch (err) {
        dlgRename.error((err && err.message) || String(err));
      }
    };
  });
}

function askRemove(ws) {
  dlgRemove.show(() => {
    $("removeTitle").textContent = `Remove “${ws.name}”?`;
    dlgRemove.error("");
    const canDelete = ws.type === "local" && ws.owned;
    $("removeBody").textContent =
      ws.type === "remote"
        ? "The server itself is untouched — this only removes it from the list."
        : canDelete
          ? "Removing it leaves the library on disk. Deleting everything erases " +
            `its notes, PDFs and highlights (${bytes(ws.sizeBytes || 0)}) and cannot be undone.`
          : "This library lives outside the app's own folder, so it will be " +
            "removed from the list but never deleted.";
    $("removeAll").hidden = !canDelete;
    $("removeKeep").onclick = () => finishRemove(ws, false);
    $("removeAll").onclick = () => finishRemove(ws, true);
  });
}

async function finishRemove(ws, deleteData) {
  try {
    await shell.remove(ws.id, { deleteData });
    dlgRemove.close();
    await refresh();
    say(deleteData ? `Deleted ${ws.name}.` : `Removed ${ws.name} from the list.`);
  } catch (err) {
    dlgRemove.error((err && err.message) || String(err));
  }
}

async function showLog(ws) {
  const text = await shell.readLog(ws.id);
  dlgLog.show(() => {
    $("logPathLine").textContent = ws.logPath || "";
    $("logText").textContent = text;
    $("revealLog").onclick = () => shell.revealLog(ws.id);
  });
  // Logs are read bottom-up: the last thing that happened is the interesting
  // one.
  const view = $("logText");
  view.scrollTop = view.scrollHeight;
}

const toggle = $("openLast");
const flip = async () => {
  const next = toggle.getAttribute("aria-checked") !== "true";
  toggle.setAttribute("aria-checked", String(next));
  state.settings = await shell.setSettings({ openLastOnLaunch: next });
};
toggle.addEventListener("click", flip);
toggle.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    flip();
  }
});

// --- boot --------------------------------------------------------------------

shell.onState(() => refresh());

// An open that failed reloads this page with the reason attached.
const failure = new URLSearchParams(location.search).get("error");
if (failure) say(failure, "error");

refresh();
