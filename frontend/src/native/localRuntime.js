// Presentation only: this host-injected marker never authenticates a request.
// Match the literal loopback origin, not URL-normalized aliases or prefixes.
export function isEmbeddedLocalRuntime(host = globalThis.window) {
  const origin = host?.__GAMMA_LOCAL_ORIGIN__;
  if (host?.__GAMMA_IPAD__ !== true || typeof origin !== "string" || origin !== host?.location?.origin) return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(origin);
  return !!match && Number(match[1]) <= 65535;
}
