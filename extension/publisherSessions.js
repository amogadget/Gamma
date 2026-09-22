// Cookie values live only in this operation's memory, never extension storage.
import { api } from "./api.js";

// Automatic refresh (worker.js, on every https tab load): only a host the user
// connected by hand is re-imported, once its snapshot is REFRESH_AFTER old,
// and a host is retried at most every RETRY_AFTER. Seconds.
export const REFRESH_AFTER = 60 * 60;
export const RETRY_AFTER = 10 * 60;

export function publisherHost(url, roots) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return "";
    return roots.some((root) => u.hostname === root || u.hostname.endsWith("." + root)) ? u.hostname : "";
  } catch { return ""; }
}

export function publisherRoot(host, roots) {
  return roots.find((root) => host === root || host.endsWith("." + root)) || "";
}

export function secureServer(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch { return false; }
}

export function cookiesForHost(cookies, host) {
  return cookies.filter((c) => {
    const domain = c.domain.replace(/^\./, "").toLowerCase();
    return !c.partitionKey && (host === domain || (!c.hostOnly && host.endsWith("." + domain)));
  }).map(({ name, value, domain, path, hostOnly, expirationDate }) => ({
    name, value, domain, path, hostOnly, ...(expirationDate == null ? {} : { expirationDate }),
  }));
}

// The server's `updated_at` is an ISO string, `expires_at` epoch seconds.
export function updatedAt(session) {
  const t = Date.parse(session && session.updated_at || "") / 1000;
  return Number.isFinite(t) ? t : 0;
}

// Whether visiting `session.host` should re-import its cookies now. A snapshot
// can only be staler than the browser's cookies, so a fresh copy is never
// worse — except right after the user signed out of the publisher, which is
// why an hour-old snapshot is kept rather than replaced on every page view.
// `attempts` maps host → epoch seconds of the last automatic try.
export function shouldAutoRefresh({ session, attempts = {}, now = Date.now() / 1000 }) {
  if (!session) return false;
  if (now - updatedAt(session) < REFRESH_AFTER) return false;
  return now - (attempts[session.host] || 0) >= RETRY_AFTER;
}

// "just now" / "5 min" / "3 h" / "2 d" for a span in seconds.
export function ageText(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

// "refreshed 3 h ago · expires in 21 h" (the popup's status line).
export function describeSession(session, now = Date.now() / 1000) {
  const age = ageText(now - updatedAt(session));
  const left = session.expires_at - now;
  const expiry = left <= 0 ? "expired" : `expires in ${ageText(left)}`;
  return `${age === "just now" ? "refreshed just now" : `refreshed ${age} ago`} · ${expiry}`;
}

export async function connectPublisher({ tabId, host, root, user, origin }) {
  if (!secureServer(origin)) throw new Error("Use HTTPS or localhost to connect a publisher session.");
  const current = await chrome.tabs.get(tabId);
  if (current.incognito) throw new Error("Publisher sessions cannot be transferred from incognito tabs.");
  if (publisherHost(current.url, [root]) !== host) throw new Error("The publisher tab changed. Reopen the Connector.");
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find((s) => s.tabIds.includes(tabId));
  if (!store) throw new Error("Cannot find this tab's cookie store.");
  const cookies = cookiesForHost(await chrome.cookies.getAll({ domain: root, storeId: store.id }), host);
  if (!cookies.length) throw new Error("No transferable cookies found. Open the publisher PDF and try again.");
  return api("/publisher-sessions", {
    json: { host, cookies }, expectedUser: user, expectedOrigin: origin,
  });
}
