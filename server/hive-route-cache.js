const DEFAULT_HIVE_ROUTE_CACHE_TTL_MS = 3000;
const DEFAULT_HIVE_ROUTE_CACHE_MAX_ENTRIES = 128;

const hiveRouteCache = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cacheTtlMs() {
  return positiveInteger(process.env.HIVE_ROUTE_CACHE_TTL_MS, DEFAULT_HIVE_ROUTE_CACHE_TTL_MS);
}

function cacheMaxEntries() {
  return positiveInteger(process.env.HIVE_ROUTE_CACHE_MAX_ENTRIES, DEFAULT_HIVE_ROUTE_CACHE_MAX_ENTRIES);
}

function touchCacheEntry(key, entry) {
  hiveRouteCache.delete(key);
  hiveRouteCache.set(key, entry);
}

function trimCache() {
  const maxEntries = cacheMaxEntries();
  while (hiveRouteCache.size > maxEntries) {
    const oldestKey = hiveRouteCache.keys().next().value;
    if (!oldestKey) return;
    hiveRouteCache.delete(oldestKey);
  }
}

function safeError(error) {
  return String(error?.message || error || "hive_route_cache_refresh_failed").slice(0, 500);
}

function hasPrivateHiveContextShape(value = {}) {
  if (!value || typeof value !== "object") return true;
  if (value?.boardManager?.logsAvailable) return true;
  if (Array.isArray(value?.boardManager?.messages) && value.boardManager.messages.length > 0) return true;
  if (value?.conversation || value?.chat) return true;
  return false;
}

export function hiveReadResponseIsCacheSafe({ pathname = "", session = null, value = null } = {}) {
  if (!value || typeof value !== "object") return false;
  if (pathname === "/api/hive/projects") {
    return true;
  }
  if (pathname === "/api/hive/context") {
    if (session?.accountId) return false;
    return !hasPrivateHiveContextShape(value);
  }
  return false;
}

async function computeAndStore({ cacheKey, compute, entry, isSafe }) {
  const targetEntry = entry || hiveRouteCache.get(cacheKey) || {
    value: null,
    expiresAt: 0,
    refreshPromise: null,
  };
  let refreshPromise;
  refreshPromise = (async () => {
    try {
      const value = await compute();
      if (isSafe(value)) {
        targetEntry.value = value;
        targetEntry.expiresAt = Date.now() + cacheTtlMs();
        touchCacheEntry(cacheKey, targetEntry);
        trimCache();
      } else {
        hiveRouteCache.delete(cacheKey);
      }
      return value;
    } finally {
      if (targetEntry.refreshPromise === refreshPromise) {
        targetEntry.refreshPromise = null;
      }
    }
  })();
  targetEntry.refreshPromise = refreshPromise;
  touchCacheEntry(cacheKey, targetEntry);
  trimCache();
  return refreshPromise;
}

export async function getCachedHiveRead({
  cacheKey = "",
  compute,
  isSafe = () => false,
} = {}) {
  if (!cacheKey || typeof compute !== "function") {
    return compute();
  }
  const entry = hiveRouteCache.get(cacheKey);
  const now = Date.now();
  if (entry) touchCacheEntry(cacheKey, entry);

  if (entry?.value && now < entry.expiresAt) {
    return entry.value;
  }

  if (entry?.value) {
    if (!entry.refreshPromise) {
      computeAndStore({ cacheKey, compute, entry, isSafe }).catch((error) => {
        console.warn("hive_route_cache_refresh_failed", {
          cacheKey,
          error: safeError(error),
        });
      });
    }
    return entry.value;
  }

  if (entry?.refreshPromise) {
    return entry.refreshPromise;
  }

  return computeAndStore({ cacheKey, compute, entry, isSafe });
}

export function __resetHiveRouteCacheForTests() {
  hiveRouteCache.clear();
}

export function __hiveRouteCacheStatsForTests() {
  return {
    size: hiveRouteCache.size,
    keys: [...hiveRouteCache.keys()],
  };
}
