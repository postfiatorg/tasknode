import { isValidClassicAddress } from "xrpl";
import { fetchHistoricalAccountTransactions } from "./context-history-rpc.js";
import { databaseEnabled } from "./db/pool.js";
import {
  getPftlSyncWallet,
  listCachedAccountTx,
  listPftlWalletsDueForHotSync,
  markPftlSyncWalletInactive,
  recordPftlSyncError,
  registerPftlSyncWallet,
  storePftlAccountTransactions,
} from "./repositories/pftl-cache.js";

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export async function bestEffortRegisterPftlSyncWallet({ accountId, walletAddress, reason }) {
  try {
    await registerPftlSyncWallet({
      accountId,
      walletAddress,
      role: "user",
      priority: 10,
      status: "active",
      metadata: { reason },
    });
  } catch (error) {
    console.warn("pftl_sync_wallet_register_failed", {
      walletAddress,
      error: error?.message || String(error),
    });
  }
}

export async function bestEffortDeactivatePftlSyncWallet({ walletAddress, reason }) {
  try {
    await markPftlSyncWalletInactive({ walletAddress, reason });
  } catch (error) {
    console.warn("pftl_sync_wallet_deactivate_failed", {
      walletAddress,
      error: error?.message || String(error),
    });
  }
}

export async function syncPftlWalletTransactions({
  walletAddress = "",
  accountId = "",
  role = "user",
  limit = 100,
  maxPages = 1,
  syncKind = "hot",
  fetchImpl = fetch,
} = {}) {
  const wallet = normalizeText(walletAddress);
  if (!databaseEnabled()) {
    return {
      ok: false,
      status: 503,
      skipped: true,
      error: "pftl_cache_database_not_configured",
      message: "The PFTL transaction cache database is not configured.",
    };
  }
  if (!isValidClassicAddress(wallet)) {
    return {
      ok: false,
      status: 400,
      error: "pftl_cache_invalid_wallet",
      message: "The wallet address is not a valid PFTL classic address.",
    };
  }

  await registerPftlSyncWallet({
    walletAddress: wallet,
    accountId,
    role,
    priority: role === "user" ? 10 : 50,
    status: "active",
  });

  try {
    const history = await fetchHistoricalAccountTransactions({
      walletAddress: wallet,
      limit: clampInteger(limit, 100, 20, 400),
      maxPages: clampInteger(maxPages, 1, 1, 30),
      fetchImpl,
    });
    const stored = await storePftlAccountTransactions({
      walletAddress: wallet,
      transactions: history.transactions,
      syncKind,
    });
    return {
      ok: true,
      status: 200,
      walletAddress: wallet,
      scannedTransactions: history.transactions.length,
      complete: history.complete,
      stored,
      source: "pftl_account_tx",
    };
  } catch (error) {
    await recordPftlSyncError({ walletAddress: wallet, error });
    return {
      ok: false,
      status: error?.status || 502,
      error: String(error?.code || error?.message || "pftl_cache_sync_failed"),
      message: "The PFTL transaction cache could not sync this wallet.",
    };
  }
}

export async function readCachedAccountTx({
  walletAddress = "",
  accountId = "",
  limit = 100,
  syncIfEmpty = false,
  forceSync = false,
} = {}) {
  const wallet = normalizeText(walletAddress);
  if (!databaseEnabled()) {
    return {
      ok: false,
      status: 503,
      skipped: true,
      error: "pftl_cache_database_not_configured",
      message: "The PFTL transaction cache database is not configured.",
    };
  }
  if (!isValidClassicAddress(wallet)) {
    return {
      ok: false,
      status: 400,
      error: "pftl_cache_invalid_wallet",
      message: "The wallet address is not a valid PFTL classic address.",
    };
  }

  await registerPftlSyncWallet({
    walletAddress: wallet,
    accountId,
    role: "user",
    priority: 10,
    status: "active",
  });

  let cached = await listCachedAccountTx({ walletAddress: wallet, limit });
  let sync = null;
  if (forceSync || (syncIfEmpty && cached.transactions.length === 0)) {
    sync = await syncPftlWalletTransactions({
      walletAddress: wallet,
      accountId,
      role: "user",
      limit,
      maxPages: forceSync ? 3 : 1,
      syncKind: "hot",
    });
    cached = await listCachedAccountTx({ walletAddress: wallet, limit });
  }

  const checkpoint = await getPftlSyncWallet({ walletAddress: wallet });
  const stale = checkpoint?.last_error || (!checkpoint?.last_hot_sync_at && cached.transactions.length === 0);

  return {
    ok: true,
    status: 200,
    source: "pftl_cache",
    walletAddress: wallet,
    transactions: cached.transactions,
    count: cached.transactions.length,
    sync: {
      status: stale ? "syncing" : "ready",
      lastHotSyncAt: checkpoint?.last_hot_sync_at || null,
      lastArchiveSyncAt: checkpoint?.last_archive_sync_at || null,
      lastError: checkpoint?.last_error || null,
      attempted: sync ? {
        ok: Boolean(sync.ok),
        scannedTransactions: sync.scannedTransactions || 0,
        complete: sync.complete ?? null,
      } : null,
    },
  };
}

export function startPftlCacheWorker({
  enabled = process.env.PFTL_CACHE_WORKER_ENABLED === "true",
  intervalMs = Number(process.env.PFTL_CACHE_WORKER_INTERVAL_MS || 60000),
  batchLimit = Number(process.env.PFTL_CACHE_WORKER_BATCH_LIMIT || 3),
  staleMs = Number(process.env.PFTL_CACHE_HOT_STALE_MS || 120000),
  logger = console,
} = {}) {
  if (!enabled) return { started: false, reason: "disabled" };
  const safeInterval = Math.min(Math.max(intervalMs || 60000, 10000), 3_600_000);
  const safeBatch = Math.min(Math.max(batchLimit || 3, 1), 20);
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const due = await listPftlWalletsDueForHotSync({ limit: safeBatch, staleMs });
      for (const wallet of due) {
        const result = await syncPftlWalletTransactions({
          walletAddress: wallet.wallet_address,
          accountId: wallet.account_id || "",
          role: wallet.role || "user",
          limit: 80,
          maxPages: 1,
          syncKind: "hot",
        });
        if (!result.ok) {
          logger.warn?.("pftl_cache_worker_sync_failed", {
            wallet: wallet.wallet_address,
            error: result.error,
          });
        }
      }
    } catch (error) {
      logger.warn?.("pftl_cache_worker_tick_failed", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runOnce, safeInterval);
  runOnce().catch((error) => {
    logger.warn?.("pftl_cache_worker_initial_tick_failed", { error: error?.message || String(error) });
  });
  return {
    started: true,
    stop: () => clearInterval(timer),
  };
}
