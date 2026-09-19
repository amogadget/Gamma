// The one thing the static `_redirects` file cannot express: a host-based
// redirect. Everything else is answered from the assets binding, so
// `_redirects` (short links) and `_headers` still apply.
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
