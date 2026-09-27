// Parse an incoming HTTP request target into a URL without letting the path
// choose the host or crash the listener.
//
// `new URL("//api/tasks", base)` treats `//api` as an authority: the path
// becomes `/tasks` and the host becomes `api`, so `//api/tasks` was served as
// the SPA and `//user:pw@evil.example/api/health` rewrote the URL host. A
// malformed authority (`//[::1/x`, `//a b/c`) throws ERR_INVALID_URL
// synchronously inside the request listener, which has no handler.
export const REQUEST_URL_BASE = "http://tasknode.local";

export function normalizeRequestTarget(rawTarget = "") {
  let target = typeof rawTarget === "string" ? rawTarget : "";
  if (!target) return "/";
  // Absolute-form targets (proxies) keep only their path and query.
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.exec(target);
  if (absolute) {
    const slash = target.indexOf("/", absolute[0].length);
    target = slash >= 0 ? target.slice(slash) : "/";
  }
  if (!target.startsWith("/")) target = `/${target}`;
  // Collapse duplicate leading slashes so the path can never carry an authority.
  target = target.replace(/^\/{2,}/, "/");
  return target;
}

export function parseRequestUrl(rawTarget = "", base = REQUEST_URL_BASE) {
  const target = normalizeRequestTarget(rawTarget);
  try {
    const url = new URL(target, base);
    // A normalized target starts with a single slash, so the host is the base's.
    if (url.host !== new URL(base).host) return { ok: false, error: "request_target_invalid" };
    return { ok: true, url, target };
  } catch {
    return { ok: false, error: "request_target_invalid", target };
  }
}
