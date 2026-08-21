const AUTH_FALLBACK_PATHS = new Set(["/auth", "/login", "/onboarding/auth"]);

function defaultWindow() {
  return typeof window === "undefined" ? null : window;
}

function currentRoute(win) {
  const location = win?.location;
  if (!location) return "";
  const pathname = String(location.pathname || "/") || "/";
  const search = String(location.search || "");
  const hash = String(location.hash || "");
  return `${pathname}${search}${hash}`;
}

function normalizedPath(value = "") {
  const path = String(value || "/").replace(/\/+$/, "");
  return path || "/";
}

function taskNodeViewFromHash(value = "") {
  const hashPath = String(value || "").replace(/^#\/?/, "").trim();
  return hashPath.split("?")[0].split("/")[0].toLowerCase();
}

function taskNodeViewFromHistory(win) {
  const view = win?.history?.state?.tasknodeView;
  return typeof view === "string" ? view.toLowerCase() : "";
}

export function captureTaskActionRoute(win = defaultWindow()) {
  const location = win?.location;
  if (!location) return null;
  return {
    route: currentRoute(win),
    pathname: String(location.pathname || "/") || "/",
    search: String(location.search || ""),
    hash: String(location.hash || ""),
  };
}

export function shouldRestoreTaskActionRoute(snapshot, win = defaultWindow()) {
  if (!snapshot?.route || !win?.location) return false;
  const current = currentRoute(win);
  if (!current || current === snapshot.route) return false;

  const currentPath = normalizedPath(win.location.pathname);
  if (AUTH_FALLBACK_PATHS.has(currentPath)) return true;

  const previousHadHashRoute = String(snapshot.hash || "").startsWith("#");
  const currentLostHashRoute = previousHadHashRoute && !String(win.location.hash || "").startsWith("#");
  if (!currentLostHashRoute) return false;

  const snapshotView = taskNodeViewFromHash(snapshot.hash);
  const currentStateView = taskNodeViewFromHistory(win);
  if (snapshotView && currentStateView && currentStateView !== snapshotView) return false;
  return true;
}

export function restoreTaskActionRoute(snapshot, win = defaultWindow()) {
  if (!shouldRestoreTaskActionRoute(snapshot, win)) return false;
  if (typeof win?.history?.replaceState !== "function") return false;
  win.history.replaceState(
    { ...(win.history.state || {}), tasknodeTaskActionRouteRestored: true },
    "",
    snapshot.route
  );
  return true;
}
