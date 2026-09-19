// A DOI used as a URL path: doi.org/<doi>, Atypon/Wiley /doi/(abs|full|pdf)/<doi>,
// and publisher PDF paths built on it — APS /prl/pdf/<doi>, Springer
// /content/pdf/<doi>.pdf, IOP /article/<doi>/pdf. The view/file suffix is
// stripped with the same rule as the server's clip.norm_doi
// (_DOI_PATH_TAIL_RE), then trailing punctuation.
//
// Loaded by the content script (classic script scope, before detect.js) and
// imported for its side effect by the module worker — hence a global, not an
// export.
globalThis.gammaDoiFromPath = function doiFromPath(pathname) {
  let path = pathname || "";
  try { path = decodeURIComponent(path); } catch {}
  const m = path.match(/\/(10\.\d{4,9}\/.+)$/);
  if (!m) return "";
  return m[1]
    .replace(/(?:\/(?:e?pdf|full|abs(?:tract)?|meta|download))?(?:\.pdf)?$/i, "")
    .replace(/[.,;)\]]+$/, "");
};
