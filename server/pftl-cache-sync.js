import { isValidClassicAddress } from "xrpl";
import { fetchHistoricalAccountTransactions } from "./context-history-rpc.js";
import { databaseEnabled } from "./db/pool.js";
import {
  getPftlSyncWallet,
  enqueuePftlReducerEventsForTransaction,
  listCachedAccountTx,
  listPftlWalletsDueForHotSync,
  listPftlWalletsDueForArchiveSync,
  markPftlSyncWalletChecked,
  markPftlSyncWalletInactive,
  mapPftlTransaction,
  recordPftlArchiveCheckpoint,
  recordPftlSyncError,
  registerPftlSyncWallet,
  storePftlAccountTransactions,
} from "./repositories/pftl-cache.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function publicPftlCacheSyncState(checkpoint, { transactionCount = 0 } = {}) {
  const archiveMarker = jsonObject(checkpoint?.archive_marker);
  const lastHotSyncAt = checkpoint?.last_hot_sync_at || null;
  const lastArchiveSyncAt = checkpoint?.last_archive_sync_at || null;
  const lastError = checkpoint?.last_error || null;
  const archiveComplete = archiveMarker.complete === true;
  const hasCachedTransactions = Number(transactionCount || 0) > 0;

  let status = "syncing";
  if (lastError) {
    status = "error";
  } else if (!archiveComplete && (hasCachedTransactions || lastHotSyncAt || lastArchiveSyncAt)) {
    status = "archive_incomplete";
  } else if (archiveComplete || lastHotSyncAt || lastArchiveSyncAt) {
    status = "ready";
  }

  return {
    status,
    archiveComplete,
    lastHotSyncAt,
    lastArchiveSyncAt,
    lastError,
  };
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function splitUrls(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function pollRpcUrls(env = process.env) {
  return uniqueUrls([
    ...splitUrls(env.PFTL_CACHE_POLL_RPC_URL || env.PFTL_RPC_URL),
    ...splitUrls(env.PFTL_CACHE_POLL_RPC_URL_FALLBACKS || env.PFTL_RPC_URL_FALLBACKS),
  ]);
}

async function fetchJsonRpc({ url, apiKey, method, params, timeoutMs, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (apiKey) headers["X-Api-Key"] = apiKey;
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: Array.isArray(params) ? params : [params || {}],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`pftl_poll_rpc_http_${response.status}`);
    if (payload?.error) throw new Error(payload.error.message || payload.error.error || "pftl_poll_rpc_error");
    if (payload?.result?.error || payload?.result?.status === "error") {
      throw new Error(payload.result.error_message || payload.result.error || "pftl_poll_rpc_error");
    }
    return payload?.result || {};
  } finally {
    clearTimeout(timer);
  }
}

export async function readPftlAccountPreviousTxnId({
  walletAddress = "",
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const wallet = normalizeText(walletAddress);
  if (!isValidClassicAddress(wallet)) {
    return { ok: false, error: "pftl_cache_invalid_wallet" };
  }
  const urls = pollRpcUrls(env);
  const timeoutMs = clampInteger(env.PFTL_CACHE_POLL_TIMEOUT_MS, 5000, 1000, 30000);
  let lastError = null;
  for (const [index, url] of urls.entries()) {
    try {
      const result = await fetchJsonRpc({
        url,
        apiKey: index === 0 ? normalizeText(env.PFTL_RPC_API_KEY) : "",
        method: "account_info",
        params: {
          account: wallet,
          ledger_index: "validated",
        },
        timeoutMs,
        fetchImpl,
      });
      return {
        ok: true,
        previousTxnId: normalizeText(result?.account_data?.PreviousTxnID),
        ledgerIndex: result?.ledger_index || result?.validated_ledger_index || null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ok: false,
    error: normalizeText(lastError?.message || "pftl_poll_rpc_unavailable"),
  };
}

export async function validatePftlSyncWalletForWorker(
  { walletAddress = "" } = {},
  { deactivateImpl = markPftlSyncWalletInactive, logger = console } = {}
) {
  const wallet = normalizeText(walletAddress);
  if (isValidClassicAddress(wallet)) return { ok: true, valid: true, walletAddress: wallet };

  const reason = "invalid_wallet_address";
  try {
    const deactivated = await deactivateImpl({ walletAddress: wallet, reason });
    logger.warn?.("pftl_invalid_sync_wallet_deactivated", {
      wallet,
      deactivated: deactivated?.ok === true,
      reason,
    });
    return {
      ok: deactivated?.ok === true,
      valid: false,
      walletAddress: wallet,
      reason,
    };
  } catch (error) {
    logger.warn?.("pftl_invalid_sync_wallet_deactivation_failed", {
      wallet,
      error: error?.message || String(error),
    });
    return {
      ok: false,
      valid: false,
      walletAddress: wallet,
      reason,
      error: error?.message || String(error),
    };
  }
}

export async function bestEffortRegisterPftlSyncWallet({ accountId, walletAddress, reason }) {
  try {
    const result = await registerPftlSyncWallet({
      accountId,
      walletAddress,
      role: "user",
      priority: 10,
      status: "active",
      metadata: { reason },
    });
    if (result?.ok) {
      recordUserObservabilityEvent({
        eventType: "user.wallet.sync_status_changed",
        accountId,
        walletAddress: result.walletAddress || walletAddress,
        walletScope: "active",
        sourceSurface: "wallet",
        sourceRoute: "server/pftl-cache-sync.js::bestEffortRegisterPftlSyncWallet",
        resultStatus: "active",
        reasonCode: normalizeText(reason) || "wallet_registered",
        metadata: {
          role: "user",
          priority: 10,
        },
      }).catch(() => {});
    }
  } catch (error) {
    console.warn("pftl_sync_wallet_register_failed", {
      walletAddress,
      error: error?.message || String(error),
    });
  }
}

export async function bestEffortDeactivatePftlSyncWallet({ walletAddress, reason }) {
  try {
    const existingWallet = await getPftlSyncWallet({ walletAddress });
    const result = await markPftlSyncWalletInactive({ walletAddress, reason });
    if (result?.ok) {
      recordUserObservabilityEvent({
        eventType: "user.wallet.sync_status_changed",
        accountId: existingWallet?.account_id || "",
        walletAddress: result.walletAddress || walletAddress,
        walletScope: "historical",
        sourceSurface: "wallet",
        sourceRoute: "server/pftl-cache-sync.js::bestEffortDeactivatePftlSyncWallet",
        resultStatus: "inactive",
        reasonCode: normalizeText(reason) || "wallet_deactivated",
        metadata: {
          previousStatus: normalizeText(existingWallet?.status),
          role: normalizeText(existingWallet?.role || "user"),
        },
      }).catch(() => {});
    }
  } catch (error) {
    console.warn("pftl_sync_wallet_deactivate_failed", {
      walletAddress,
      error: error?.message || String(error),
    });
  }
}

async function enqueueReducerEventsForEntries({
  walletAddress = "",
  accountId = "",
  transactions = [],
  syncKind = "hot",
} = {}) {
  let reducerEvents = 0;
  for (const entry of transactions) {
    const mapped = mapPftlTransaction(entry, walletAddress);
    if (!mapped?.txHash) continue;
    const queued = await enqueuePftlReducerEventsForTransaction({
      walletAddress,
      accountId,
      txHash: mapped.txHash,
      ledgerIndex: mapped.ledgerIndex,
      transactionResult: mapped.transactionResult,
      source: `pftl_account_tx_${syncKind}`,
      payload: {
        source: "pftl_account_tx",
        syncKind,
        txHash: mapped.txHash,
        ledgerIndex: mapped.ledgerIndex,
      },
    });
    reducerEvents += queued?.inserted || 0;
  }
  return reducerEvents;
}

function oldestLedgerIndex(transactions = [], walletAddress = "") {
  let oldest = null;
  for (const entry of transactions) {
    const mapped = mapPftlTransaction(entry, walletAddress);
    if (mapped?.ledgerIndex === null || mapped?.ledgerIndex === undefined) continue;
    if (oldest === null || mapped.ledgerIndex < oldest) oldest = mapped.ledgerIndex;
  }
  return oldest;
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
    const reducerEvents = await enqueueReducerEventsForEntries({
      walletAddress: wallet,
      accountId,
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
      reducerEvents,
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

export async function syncPftlWalletArchive({
  walletAddress = "",
  accountId = "",
  role = "user",
  limit = 200,
  maxPages = 1,
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

  const checkpoint = await getPftlSyncWallet({ walletAddress: wallet });
  const archiveMarker = checkpoint?.archive_marker || {};
  if (archiveMarker?.complete === true) {
    return {
      ok: true,
      status: 200,
      walletAddress: wallet,
      skipped: true,
      complete: true,
      scannedTransactions: 0,
      source: "pftl_account_tx_archive",
    };
  }

  try {
    const history = await fetchHistoricalAccountTransactions({
      walletAddress: wallet,
      limit: clampInteger(limit, 200, 20, 400),
      maxPages: clampInteger(maxPages, 1, 1, 30),
      marker: archiveMarker?.marker || null,
      fetchImpl,
    });
    const stored = await storePftlAccountTransactions({
      walletAddress: wallet,
      transactions: history.transactions,
      syncKind: "archive",
    });
    const reducerEvents = await enqueueReducerEventsForEntries({
      walletAddress: wallet,
      accountId,
      transactions: history.transactions,
      syncKind: "archive",
    });
    const archiveCheckpoint = await recordPftlArchiveCheckpoint({
      walletAddress: wallet,
      marker: history.nextMarker,
      complete: history.complete,
      lastArchiveLedger: oldestLedgerIndex(history.transactions, wallet),
      scannedTransactions: history.transactions.length,
      pages: history.pages.length,
    });
    return {
      ok: true,
      status: 200,
      walletAddress: wallet,
      scannedTransactions: history.transactions.length,
      complete: history.complete,
      nextMarker: history.nextMarker ? "present" : null,
      stored,
      reducerEvents,
      archiveCheckpoint: archiveCheckpoint.checkpoint,
      source: "pftl_account_tx_archive",
    };
  } catch (error) {
    await recordPftlSyncError({ walletAddress: wallet, error });
    return {
      ok: false,
      status: error?.status || 502,
      error: String(error?.code || error?.message || "pftl_cache_archive_sync_failed"),
      message: "The PFTL transaction cache could not archive-sync this wallet.",
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
  const syncState = publicPftlCacheSyncState(checkpoint, {
    transactionCount: cached.transactions.length,
  });

  return {
    ok: true,
    status: 200,
    source: "pftl_cache",
    walletAddress: wallet,
    transactions: cached.transactions,
    count: cached.transactions.length,
    sync: {
      ...syncState,
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
  previousTxnReader = readPftlAccountPreviousTxnId,
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
        const validation = await validatePftlSyncWalletForWorker(
          { walletAddress: wallet.wallet_address },
          { logger }
        );
        if (!validation.valid) continue;
        const previous = await previousTxnReader({ walletAddress: wallet.wallet_address });
        if (
          previous.ok &&
          wallet.last_seen_tx_hash &&
          previous.previousTxnId &&
          previous.previousTxnId === wallet.last_seen_tx_hash
        ) {
          await markPftlSyncWalletChecked({
            walletAddress: wallet.wallet_address,
            previousTxnId: previous.previousTxnId,
          });
          continue;
        }
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

export function startPftlArchiveWorker({
  enabled = process.env.PFTL_CACHE_ARCHIVE_WORKER_ENABLED === "true",
  intervalMs = Number(process.env.PFTL_CACHE_ARCHIVE_WORKER_INTERVAL_MS || 300000),
  batchLimit = Number(process.env.PFTL_CACHE_ARCHIVE_BATCH_LIMIT || 1),
  staleMs = Number(process.env.PFTL_CACHE_ARCHIVE_STALE_MS || 900000),
  accountTxLimit = Number(process.env.PFTL_CACHE_ARCHIVE_ACCOUNT_TX_LIMIT || 200),
  maxPages = Number(process.env.PFTL_CACHE_ARCHIVE_MAX_PAGES || 1),
  logger = console,
} = {}) {
  if (!enabled) return { started: false, reason: "disabled" };
  const safeInterval = Math.min(Math.max(intervalMs || 300000, 30000), 24 * 3_600_000);
  const safeBatch = Math.min(Math.max(batchLimit || 1, 1), 10);
  const safeStaleMs = Math.min(Math.max(staleMs || 900000, 60000), 7 * 86_400_000);
  const safeLimit = clampInteger(accountTxLimit, 200, 20, 400);
  const safeMaxPages = clampInteger(maxPages, 1, 1, 30);
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const due = await listPftlWalletsDueForArchiveSync({
        limit: safeBatch,
        staleMs: safeStaleMs,
      });
      for (const wallet of due) {
        const validation = await validatePftlSyncWalletForWorker(
          { walletAddress: wallet.wallet_address },
          { logger }
        );
        if (!validation.valid) continue;
        const result = await syncPftlWalletArchive({
          walletAddress: wallet.wallet_address,
          accountId: wallet.account_id || "",
          role: wallet.role || "user",
          limit: safeLimit,
          maxPages: safeMaxPages,
        });
        if (!result.ok) {
          logger.warn?.("pftl_archive_worker_sync_failed", {
            wallet: wallet.wallet_address,
            error: result.error,
          });
        }
      }
    } catch (error) {
      logger.warn?.("pftl_archive_worker_tick_failed", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runOnce, safeInterval);
  runOnce().catch((error) => {
    logger.warn?.("pftl_archive_worker_initial_tick_failed", { error: error?.message || String(error) });
  });
  return {
    started: true,
    stop: () => clearInterval(timer),
  };
}
