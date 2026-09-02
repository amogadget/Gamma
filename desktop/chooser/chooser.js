// Renderer for the first-run chooser. Talks to the main process only through
// the small `gamma` bridge in preload.js — no Node here.

const optLocal = document.getElementById("opt-local");
const optRemote = document.getElementById("opt-remote");
const serverRow = document.getElementById("server-row");
const serverInput = document.getElementById("server");
const recent = document.getElementById("recent");
const statusEl = document.getElementById("status");
const go = document.getElementById("go");
const cancel = document.getElementById("cancel");

let mode = "local";
let busy = false;

function select(next) {
  mode = next;
  optLocal.setAttribute("aria-selected", String(next === "local"));
  optRemote.setAttribute("aria-selected", String(next === "remote"));
  serverRow.classList.toggle("shown", next === "remote");
  say("");
  if (next === "remote") serverInput.focus();
}

function say(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function setBusy(on, label) {
  busy = on;
  go.disabled = on;
  go.textContent = on ? label || "Working…" : "Continue";
}

for (const [el, name] of [[optLocal, "local"], [optRemote, "remote"]]) {
  el.addEventListener("click", () => select(name));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(name);
    }
  });
}

serverInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submit();
});

async function submit() {
  if (busy) return;
  if (mode === "local") {
    setBusy(true, "Starting…");
    const res = await window.gamma.choose({ mode: "local" });
    // On success the main process replaces this window; only failure comes back.
    if (res && res.error) {
      setBusy(false);
      say(res.error, "error");
    }
    return;
  }

  const url = serverInput.value.trim();
  if (!url) {
    say("Enter the address of your Gamma server.", "error");
    serverInput.focus();
    return;
  }
  // Check before committing: pointing a window at an unreachable address just
  // shows a browser error page, which tells the user nothing useful.
  setBusy(true, "Checking…");
  say("");
  const probe = await window.gamma.probe(url);
  if (!probe.ok) {
    setBusy(false);
    say(probe.error, "error");
    serverInput.focus();
    return;
  }
  setBusy(true, "Connecting…");
  const res = await window.gamma.choose({ mode: "remote", serverUrl: probe.url });
  if (res && res.error) {
    setBusy(false);
    say(res.error, "error");
  }
}

go.addEventListener("click", submit);
cancel.addEventListener("click", () => window.gamma.cancel());

window.gamma.state().then((state) => {
  if (!state) return;
  for (const url of state.recentServers || []) {
    const opt = document.createElement("option");
    opt.value = url;
    recent.append(opt);
  }
  if (state.serverUrl) serverInput.value = state.serverUrl;
  // Reopened from the menu rather than a first run: there is something to go
  // back to, so offer a way out.
  if (state.canCancel) cancel.hidden = false;
  select(state.mode === "remote" ? "remote" : "local");
});
