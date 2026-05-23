import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
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
