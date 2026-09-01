import { getSettings, login, logout, normalizeServer, originPattern, setSettings, whoAmI } from "./api.js";

const $ = (id) => document.getElementById(id);

function status(id, text, cls = "") {
  const el = $(id);
  el.textContent = text;
  el.className = "status " + cls;
}

async function refreshAccount() {
  const settings = await getSettings();
  if (!settings.server) {
    status("server-status", "Not connected.");
    $("signed-out").classList.remove("hidden"); $("signed-in").classList.add("hidden");
    return;
  }
  try {
    const me = await whoAmI();
    status("server-status", `Connected to ${settings.server}.`, "ok");
    $("signed-out").classList.toggle("hidden", !!me.user);
    $("signed-in").classList.toggle("hidden", !me.user);
    if (me.user) $("who").textContent = me.user;
    status("account-status", "");
  } catch (err) {
    status("server-status", `Can't reach ${settings.server}: ${err.message}`, "err");
  }
  chrome.runtime.sendMessage({ type: "auth-changed" }).catch(() => {});
}

async function connect() {
  const origin = normalizeServer($("server").value);
  if (!origin) { status("server-status", "Enter a valid URL.", "err"); return; }
  const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
  if (!granted) { status("server-status", "Permission to talk to that server was declined.", "err"); return; }
  await setSettings({ server: origin });
  $("server").value = origin;
  await refreshAccount();
}

async function doLogin(e) {
  if (e) e.preventDefault();
  $("login").disabled = true;
  try {
    await login($("user").value.trim(), $("pass").value);
    $("pass").value = "";
    await refreshAccount();
  } catch (err) {
    status("account-status", err.status === 401 ? "Wrong username or password." : err.message, "err");
  } finally { $("login").disabled = false; }
}

async function doLogout() {
  try { await logout(); } catch {}
  await refreshAccount();
}

async function saveDefaults() {
  await setSettings({
    folder: $("folder").value.trim(),
    labels: $("labels").value.split(",").map((s) => s.trim()).filter(Boolean),
    allowOa: $("allow-oa").checked,
    saveCopy: $("save-copy").checked,
  });
  status("save-status", "Saved.", "ok");
  setTimeout(() => status("save-status", ""), 1500);
}

document.addEventListener("DOMContentLoaded", async () => {
  const s = await getSettings();
  $("server").value = s.server;
  $("folder").value = s.folder;
  $("labels").value = (s.labels || []).join(", ");
  $("allow-oa").checked = !!s.allowOa;
  $("save-copy").checked = !!s.saveCopy;
  $("connect").onclick = connect;
  $("server").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
  $("login-form").addEventListener("submit", doLogin);
  $("login").onclick = doLogin;
  $("logout").onclick = doLogout;
  for (const id of ["folder", "labels", "allow-oa", "save-copy"]) $(id).addEventListener("change", saveDefaults);
  await refreshAccount();
});
