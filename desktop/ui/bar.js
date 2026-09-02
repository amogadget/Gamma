// The shell bar: which workspace is open, what is starting, and the switcher.
//
// It is the window's title bar, so it must stay out of the way — one button,
// a status line and a reload. Everything else lives in the launcher.

const $ = (id) => document.getElementById(id);

let state = { workspaces: [], current: null, busy: null, theme: "", platform: "linux" };
let menuOpen = false;

document.body.dataset.platform = window.gammaShell.platform;
$("mark").innerHTML = ICONS.mark;
$("chev").innerHTML = ICONS.chevron;
$("reload").innerHTML = ICONS.reload;

function render() {
  // The chrome follows the app's theme, mirrored out of the Gamma page.
  document.documentElement.setAttribute("data-theme", state.theme || "dark");

  const cur = state.current;
  $("label").textContent = cur ? cur.name : "Workspaces";
  $("kind").innerHTML = cur ? ICONS[cur.type] || "" : ICONS.grid;
  $("reload").hidden = !cur;

  const status = $("status");
  status.textContent = "";
  if (state.busy) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    status.append(spinner, document.createTextNode(state.busy));
  }
  if (menuOpen) renderMenu();
}

function item({ icon, name, current, running, onClick, role = "menuitem" }) {
  const el = document.createElement("button");
  el.className = "item";
  el.setAttribute("role", role);
  if (current) el.setAttribute("aria-current", "true");

  const ico = document.createElement("span");
  ico.className = "ico";
  ico.innerHTML = icon;

  const label = document.createElement("span");
  label.className = "name";
  label.textContent = name;

  el.append(ico, label);
  if (running) {
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.title = "server running";
    el.append(dot);
  }
  const check = document.createElement("span");
  check.className = "check";
  check.innerHTML = current ? ICONS.check : "";
  el.append(check);

  el.addEventListener("click", onClick);
  return el;
}

function renderMenu() {
  const menu = $("menu");
  menu.textContent = "";
  const local = state.workspaces.filter((w) => w.type === "local");
  const remote = state.workspaces.filter((w) => w.type === "remote");

  for (const [group, list] of [["On this computer", local], ["Servers", remote]]) {
    if (!list.length) continue;
    const label = document.createElement("div");
    label.className = "groupLabel";
    label.textContent = group;
    menu.append(label);
    for (const ws of list) {
      menu.append(
        item({
          icon: ICONS[ws.type],
          name: ws.name,
          current: Boolean(state.current && state.current.id === ws.id),
          running: ws.running,
          onClick: () => {
            setOpen(false);
            window.gammaShell.open(ws.id).catch(() => {
              /* the launcher explains it */
            });
          },
        }),
      );
    }
  }

  if (state.workspaces.length) menu.append(Object.assign(document.createElement("div"), { className: "sep" }));
  menu.append(
    item({
      icon: ICONS.grid,
      name: "All workspaces…",
      onClick: () => {
        setOpen(false);
        window.gammaShell.launcher();
      },
    }),
  );
}

function setOpen(next) {
  menuOpen = Boolean(next);
  $("menu").hidden = !menuOpen;
  $("switcher").setAttribute("aria-expanded", String(menuOpen));
  // The view has to grow past the strip for the menu to be visible at all.
  window.gammaShell.expandBar(menuOpen);
  if (menuOpen) renderMenu();
}

$("switcher").addEventListener("click", (event) => {
  event.stopPropagation();
  setOpen(!menuOpen);
});
$("reload").addEventListener("click", () => window.gammaShell.reload());

// A click anywhere off the menu closes it — including on the transparent part
// of this view, which covers the content while the menu is open.
document.addEventListener("click", (event) => {
  if (!menuOpen) return;
  if (!$("menu").contains(event.target)) setOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuOpen) setOpen(false);
});

window.gammaShell.onState((next) => {
  state = next;
  render();
});
window.gammaShell.state().then((next) => {
  state = next;
  render();
});
render();
