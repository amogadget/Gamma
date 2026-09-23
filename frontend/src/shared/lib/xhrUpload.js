// Multipart POST → the JSON reply. XMLHttpRequest rather than fetch because
// only it reports upload progress and can be aborted mid-body; it bypasses
// the fetch wrapper, so the workspace header and the tab-identity guard are
// set by hand, and a 409 from that guard raises the same window events the
// wrapper does. Rejects with an Error carrying `status` / `data` like the
// fetch wrapper's, or `aborted: true` after onAbortable's function ran or
// `signal` fired. Shared by every upload: block files and images
// (FileChip postFile), PDFs (App.jsx resolvePdfSource), backup zips (App.jsx
// runBackupImport) and the import review (transfers/importApi.js).
//   onProgress(loaded, total)  bytes sent, while the total is known
//   onProcessing()             the body is up; the server is working
import { getCurrentWorkspace, getExpectedUser, withShare, withWorkspace } from "./utils";

export function xhrUpload(endpoint, form, { onProgress, onProcessing, onAbortable, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (fn, value) => { signal?.removeEventListener("abort", abort); fn(value); };
    const stopped = () => { const err = new Error("stopped"); err.aborted = true; err.name = "AbortError"; return err; };
    if (signal?.aborted) { reject(stopped()); return; }
    xhr.open("POST", withShare(withWorkspace(endpoint)));
    xhr.withCredentials = true;
    const expected = getExpectedUser();
    if (expected) xhr.setRequestHeader("X-Gamma-User", expected);
    if (getCurrentWorkspace()) xhr.setRequestHeader("X-Gamma-Workspace", getCurrentWorkspace());
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
    xhr.upload.onload = () => onProcessing?.();
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 409 && xhr.getResponseHeader("X-Gamma-Session-User") !== null) {
        const user = xhr.getResponseHeader("X-Gamma-Session-User");
        window.dispatchEvent(new CustomEvent(user ? "gamma-user-mismatch" : "gamma-auth-expired", { detail: { user } }));
      }
      if (xhr.status >= 200 && xhr.status < 300) { finish(resolve, data); return; }
      const err = new Error(String(data?.detail || xhr.statusText || `HTTP ${xhr.status}`));
      err.status = xhr.status; err.data = data;
      finish(reject, err);
    };
    xhr.onerror = () => finish(reject, new Error("network error"));
    xhr.onabort = () => finish(reject, stopped());
    signal?.addEventListener("abort", abort, { once: true });
    onAbortable?.(abort);
    xhr.send(form);
  });
}
