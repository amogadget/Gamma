// Byte progress belongs to the upload only. Processing starts after upload.load
// and remains indeterminate until the server returns its report.
export function uploadJson(url, body, { headers = {}, signal, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (fn, value) => { signal?.removeEventListener("abort", abort); fn(value); };
    if (signal?.aborted) { reject(new DOMException("Upload cancelled", "AbortError")); return; }
    xhr.open("POST", url);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(headers)) if (value) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = event => onProgress({ phase: "upload", loaded: event.loaded,
      total: event.lengthComputable ? event.total : null });
    xhr.upload.onload = () => onProgress({ phase: "processing" });
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); }
      catch { finish(reject, new Error(`The server returned an unreadable import response (${xhr.status}).`)); return; }
      if (xhr.status === 409 && xhr.getResponseHeader("X-Gamma-Session-User") !== null) {
        const user = xhr.getResponseHeader("X-Gamma-Session-User");
        window.dispatchEvent(new CustomEvent(user ? "gamma-user-mismatch" : "gamma-auth-expired", { detail: { user } }));
      }
      if (xhr.status >= 200 && xhr.status < 300) finish(resolve, data);
      else finish(reject, new Error(typeof data?.detail === "string" ? data.detail : `Import request failed (${xhr.status}).`));
    };
    xhr.onerror = () => finish(reject, new Error("Connection lost. Check your connection and try again."));
    xhr.onabort = () => finish(reject, new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    onProgress({ phase: "upload", loaded: 0, total: null });
    xhr.send(body);
  });
}
