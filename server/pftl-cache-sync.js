import { isValidClassicAddress } from "xrpl";
import { fetchHistoricalAccountTransactions } from "./context-history-rpc.js";
import { databaseEnabled } from "./db/pool.js";
import {
  getPftlSyncWallet,
  enqueuePftlReducerEventsForTransaction,
  listCachedAccountTx,
  listPftlWalletsDueForHotSync,
  markPftlSyncWalletChecked,
  markPftlSyncWalletInactive,
  mapPftlTransaction,
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
    let reducerEvents = 0;
    for (const entry of history.transactions) {
      const mapped = mapPftlTransaction(entry, wallet);
      if (!mapped?.txHash) continue;
      const queued = await enqueuePftlReducerEventsForTransaction({
        walletAddress: wallet,
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
