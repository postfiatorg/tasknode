import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";

const inFlightRefreshes = new Map();
const lastRefreshes = new Map();
const defaultMinIntervalMs = Math.max(
  1000,
  Number(process.env.TASK_PROJECTION_REFRESH_MIN_INTERVAL_MS || 5000)
);

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function refreshKey({ accountId = "", walletAddress = "" } = {}) {
  return [
    safeText(accountId, 180) || "account",
    safeText(walletAddress, 180),
  ].join(":");
}

export async function refreshLinkedWalletTaskProjection({
  accountId = "",
  walletAddress = "",
  syncKind = "task_list_refresh",
  logger = console,
} = {}) {
  const normalizedWallet = safeText(walletAddress, 180);
  if (!normalizedWallet) {
    return { ok: false, skipped: true, reason: "wallet_not_linked" };
  }

  try {
    const synced = await syncPftlWalletTransactions({
      walletAddress: normalizedWallet,
      accountId: safeText(accountId, 180),
      limit: 120,
      maxPages: 1,
      syncKind,
    });
    const reduced = await runPftlCacheReducerOnce({ batchLimit: 40, logger });
    return {
      ok: synced?.ok !== false && reduced?.ok !== false,
      synced,
      reduced,
    };
  } catch (error) {
    logger.warn?.("task_projection_refresh_failed", {
      walletAddress: normalizedWallet,
      error: safeText(error?.message || error, 1000),
    });
    return {
      ok: false,
      error: safeText(error?.code || error?.message || error, 500),
    };
  }
}

export function scheduleLinkedWalletTaskProjectionRefresh({
  accountId = "",
  walletAddress = "",
  syncKind = "task_list_refresh",
  logger = console,
  minIntervalMs = defaultMinIntervalMs,
} = {}) {
  const normalizedWallet = safeText(walletAddress, 180);
  if (!normalizedWallet) {
    return { ok: false, skipped: true, reason: "wallet_not_linked" };
  }

  const key = refreshKey({ accountId, walletAddress: normalizedWallet });
  if (inFlightRefreshes.has(key)) {
    return { ok: true, scheduled: false, inFlight: true, reason: "refresh_in_flight" };
  }

  const recent = lastRefreshes.get(key);
  const now = Date.now();
  if (recent && now - Number(recent.completedAtMs || 0) < Number(minIntervalMs || 0)) {
    return {
      ok: recent.result?.ok !== false,
      scheduled: false,
      skipped: true,
      reason: "recent_refresh",
      result: recent.result,
    };
  }

  const refresh = refreshLinkedWalletTaskProjection({
    accountId,
    walletAddress: normalizedWallet,
    syncKind,
    logger,
  })
    .then((result) => {
      lastRefreshes.set(key, { completedAtMs: Date.now(), result });
      return result;
    })
    .catch((error) => {
      const result = {
        ok: false,
        error: safeText(error?.code || error?.message || error, 500),
      };
      lastRefreshes.set(key, { completedAtMs: Date.now(), result });
      logger.warn?.("task_projection_refresh_failed", {
        walletAddress: normalizedWallet,
        error: result.error,
      });
      return result;
    })
    .finally(() => {
      inFlightRefreshes.delete(key);
    });

  inFlightRefreshes.set(key, refresh);
  return { ok: true, scheduled: true, inFlight: false };
}
