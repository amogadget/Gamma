// Cookie values live only in this operation's memory, never extension storage.
import { api } from "./api.js";

export function publisherHost(url, roots) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return "";
    return roots.some((root) => u.hostname === root || u.hostname.endsWith("." + root)) ? u.hostname : "";
  } catch { return ""; }
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
