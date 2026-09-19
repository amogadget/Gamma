// One URL rule for browser-issued asset requests — an `<img src>`, an
// `<audio src>`, a download link, the replay JSON loader — which bypass the
// fetch wrapper (shared/lib/utils.js) and therefore carry neither the workspace
// header nor the share token. Pure and window-free so it can be unit-tested.
//
// Both asset families are covered:
//   /api/uploads/<hash>.<ext>  — the browser's own uploads and handwriting
//                                strokes (upstream `ink_url` groups)
//   /api/assets/<sha256>.<ext>  — the native (iPad) content-addressed assets:
//                                .pkdrawing, .png previews, .m4a audio and
//                                .inkjson per-stroke replay derivatives
// Anything else — another origin, another path, a data: URL — is returned
// untouched: this helper never rewrites what it does not own.

const SCOPED_PREFIXES = ["/api/uploads/", "/api/assets/"];

export function assetUrlInScope(url, { workspace = "", share = "" } = {}) {
  if (typeof url !== "string" || !SCOPED_PREFIXES.some((prefix) => url.startsWith(prefix))) return url;
  const query = [];
  if (workspace && !/[?&]ws=/.test(url)) query.push(`ws=${encodeURIComponent(workspace)}`);
  if (share && !/[?&]share=/.test(url)) query.push(`share=${encodeURIComponent(share)}`);
  if (!query.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query.join("&")}`;
}
