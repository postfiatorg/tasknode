import { poolMetrics } from "./db/pool.js";

const DEFAULT_ROUTE_OBSERVABILITY_WINDOW_MS = 60_000;
const DEFAULT_ROUTE_OBSERVABILITY_MIN_SAMPLES = 20;
const trackedRoutePrefixes = [
  "/api/app-state",
  "/api/hive",
  "/api/task",
  "/api/tasks",
];

const routeWindows = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function windowMs() {
  return positiveInteger(process.env.ROUTE_OBSERVABILITY_WINDOW_MS, DEFAULT_ROUTE_OBSERVABILITY_WINDOW_MS);
}

function minSamples() {
  return positiveInteger(process.env.ROUTE_OBSERVABILITY_MIN_SAMPLES, DEFAULT_ROUTE_OBSERVABILITY_MIN_SAMPLES);
}

function percentile(values = [], quantile = 0.95) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return Number(sorted[index].toFixed(2));
}

function routeFamily(pathname = "") {
  if (pathname === "/api/app-state") return "/api/app-state";
  if (pathname.startsWith("/api/hive/")) {
    const parts = pathname.split("/").filter(Boolean);
    return `/api/hive/${parts[2] || ""}`;
  }
  if (pathname.startsWith("/api/tasks/")) {
    const parts = pathname.split("/").filter(Boolean);
    return `/api/tasks/${parts[2] || ""}`;
  }
  if (pathname.startsWith("/api/task/")) {
    const parts = pathname.split("/").filter(Boolean);
    return `/api/task/${parts[2] || ""}`;
  }
  return pathname;
}

function shouldObserve(pathname = "") {
  return trackedRoutePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function routeKey({ method = "GET", pathname = "", authState = "anon" } = {}) {
  return `${method.toUpperCase()} ${routeFamily(pathname)} ${authState}`;
}

function freshWindow(now = Date.now()) {
  return {
    startedAtMs: now,
    durations: [],
    statusCounts: {},
    errorCount: 0,
  };
}

function flushRouteWindow(key, routeWindow, now = Date.now()) {
  if (!routeWindow?.durations?.length) return;
  console.info("route_observability_summary", {
    key,
    windowMs: now - routeWindow.startedAtMs,
    count: routeWindow.durations.length,
    p50Ms: percentile(routeWindow.durations, 0.5),
    p95Ms: percentile(routeWindow.durations, 0.95),
    maxMs: Number(Math.max(...routeWindow.durations).toFixed(2)),
    errorCount: routeWindow.errorCount,
    statusCounts: routeWindow.statusCounts,
    dbPool: poolMetrics(),
  });
}

export function recordRouteObservation({
  method = "GET",
  pathname = "",
  authState = "anon",
  statusCode = 0,
  durationMs = 0,
  now = Date.now(),
} = {}) {
  if (!shouldObserve(pathname)) return;
  const key = routeKey({ method, pathname, authState });
  let routeWindow = routeWindows.get(key);
  if (!routeWindow || now - routeWindow.startedAtMs > windowMs()) {
    flushRouteWindow(key, routeWindow, now);
    routeWindow = freshWindow(now);
    routeWindows.set(key, routeWindow);
  }
  const roundedDuration = Number(Math.max(0, durationMs).toFixed(2));
  routeWindow.durations.push(roundedDuration);
  const status = String(statusCode || 0);
  routeWindow.statusCounts[status] = (routeWindow.statusCounts[status] || 0) + 1;
  if (!statusCode || statusCode >= 500) routeWindow.errorCount += 1;

  if (routeWindow.errorCount > 0 || routeWindow.durations.length >= minSamples()) {
    flushRouteWindow(key, routeWindow, now);
    routeWindows.set(key, freshWindow(now));
  }
}

export function observeApiRoute({ req, res, url, session = null } = {}) {
  const pathname = url?.pathname || "";
  if (!shouldObserve(pathname)) return;
  const startedAt = performance.now();
  const authState = session?.accountId ? "authed" : "anon";
  res.once?.("finish", () => {
    recordRouteObservation({
      method: req?.method || "GET",
      pathname,
      authState,
      statusCode: res.statusCode,
      durationMs: performance.now() - startedAt,
    });
  });
}

export function __resetRouteObservabilityForTests() {
  routeWindows.clear();
}
