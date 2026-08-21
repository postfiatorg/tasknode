import WebSocket from "ws";
import { isValidClassicAddress } from "xrpl";
import { databaseEnabled } from "./db/pool.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";
import {
  enqueuePftlReducerEventsForTransaction,
  listActivePftlSyncWallets,
  mapPftlTransaction,
  recordPftlCacheWatcherState,
  recordPftlSyncError,
  storePftlAccountTransactions,
} from "./repositories/pftl-cache.js";
import { pftlWssRejectUnauthorized } from "./pftl-wss-tls.js";
import { publishWalletActivityEvent } from "./app-realtime.js";

const DEFAULT_WSS_URL = "wss://ws.testnet.postfiat.org";
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_REFRESH_MS = 15000;
const DEFAULT_RECONNECT_MS = 3000;
const DEFAULT_SUBSCRIBE_CHUNK_SIZE = 100;

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
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

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizeWssUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.hostname.startsWith("rpc.")) {
      url.hostname = `ws.${url.hostname.slice("rpc.".length)}`;
    }
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function wssRejectUnauthorized(env, url) {
  return pftlWssRejectUnauthorized({ env, url, configuredValue: normalizeText(env.PFTL_WSS_REJECT_UNAUTHORIZED) });
}

function safeError(error) {
  return normalizeText(error?.code || error?.message || error || "pftl_cache_watcher_error").slice(0, 500);
}

function eventMeta(event = {}) {
  return event.meta || event.meta_json || event.metadata || event.metaData || null;
}

function transactionResult(event = {}) {
  const meta = eventMeta(event) || {};
  return normalizeText(
    meta.TransactionResult ||
      meta.transaction_result ||
      meta.engine_result ||
      event.engine_result ||
      event.result
  );
}

function txJson(event = {}) {
  return event.tx_json || event.transaction || event.tx || event;
}

function txHash(event = {}) {
  const tx = txJson(event);
  return normalizeText(tx?.hash || tx?.Hash || event.hash || event.tx_hash || event.txHash);
}

function ledgerIndex(event = {}) {
  const tx = txJson(event);
  const value = tx?.ledger_index || tx?.ledgerIndex || event.ledger_index || event.ledgerIndex;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function accountRootFromNode(node = {}) {
  const entry = node.ModifiedNode || node.CreatedNode || node.DeletedNode || {};
  if (entry.LedgerEntryType !== "AccountRoot") return "";
  return normalizeText(
    entry.FinalFields?.Account ||
      entry.NewFields?.Account ||
      entry.PreviousFields?.Account
  );
}

function collectAffectedAccounts(event = {}) {
  const tx = txJson(event) || {};
  const accounts = new Set([
    normalizeText(tx.Account || tx.account),
    normalizeText(tx.Destination || tx.destination),
  ].filter(Boolean));

  const affectedNodes = Array.isArray(eventMeta(event)?.AffectedNodes)
    ? eventMeta(event).AffectedNodes
    : [];
  for (const node of affectedNodes) {
    const account = accountRootFromNode(node);
    if (account) accounts.add(account);
  }

  if (Array.isArray(event.accounts)) {
    for (const account of event.accounts) {
      const normalized = normalizeText(account);
      if (normalized) accounts.add(normalized);
    }
  }

  return accounts;
}

export function affectedWalletsForTransactionEvent(event = {}, watchedWallets = []) {
  const watched = new Set(
    watchedWallets
      .map((wallet) => normalizeText(typeof wallet === "string" ? wallet : wallet?.wallet_address || wallet?.walletAddress))
      .filter(Boolean)
  );
  if (watched.size === 0) return [];

  const affectedAccounts = collectAffectedAccounts(event);
  const matched = [...affectedAccounts].filter((account) => watched.has(account));
  if (matched.length > 0) return matched;

  return watched.size === 1 ? [...watched] : [];
}

export function pftlCacheWatcherConfig(env = process.env) {
  const explicit = splitUrls(env.PFTL_CACHE_WSS_URL || env.PFTL_WSS_URL || env.VITE_PFTL_WSS_URL);
  const fallback = splitUrls(env.PFTL_CACHE_WSS_URL_FALLBACKS || env.PFTL_WSS_URL_FALLBACKS);
  const derived = splitUrls(env.PFTL_RPC_URL || env.PFTL_RPC_URL_FALLBACKS)
    .map(normalizeWssUrl)
    .filter((url) => /^wss?:\/\//i.test(url));
  return {
    enabled: env.PFTL_CACHE_WSS_WATCHER_ENABLED === "true",
    endpoints: uniqueUrls([...explicit, ...fallback, ...derived, DEFAULT_WSS_URL].map(normalizeWssUrl)),
    apiKey: normalizeText(env.PFTL_CACHE_WSS_API_KEY || env.PFTL_RPC_API_KEY),
    requestTimeoutMs: clampInteger(env.PFTL_CACHE_WSS_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 60000),
    walletRefreshMs: clampInteger(env.PFTL_CACHE_WSS_WALLET_REFRESH_MS, DEFAULT_REFRESH_MS, 5000, 300000),
    reconnectMs: clampInteger(env.PFTL_CACHE_WSS_RECONNECT_MS, DEFAULT_RECONNECT_MS, 1000, 60000),
    subscribeChunkSize: clampInteger(
      env.PFTL_CACHE_WSS_SUBSCRIBE_CHUNK_SIZE,
      DEFAULT_SUBSCRIBE_CHUNK_SIZE,
      1,
      500
    ),
    walletLimit: clampInteger(env.PFTL_CACHE_WSS_WALLET_LIMIT, 1000, 1, 5000),
    backfillLimit: clampInteger(env.PFTL_CACHE_WSS_BACKFILL_LIMIT, 50, 1, 1000),
    backfillAccountTxLimit: clampInteger(env.PFTL_CACHE_WSS_BACKFILL_ACCOUNT_TX_LIMIT, 120, 20, 400),
    backfillMaxPages: clampInteger(env.PFTL_CACHE_WSS_BACKFILL_MAX_PAGES, 2, 1, 30),
    rejectUnauthorizedByEndpoint: new Map(),
  };
}

export async function processPftlCacheTransactionEvent({
  event,
  watchedWallets = [],
  source = "pftl_cache_watcher",
  logger = console,
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  if (event?.validated === false) return { ok: true, skipped: true, reason: "not_validated" };

  const hash = txHash(event);
  if (!hash) return { ok: false, error: "pftl_cache_event_missing_tx_hash" };

  const affected = affectedWalletsForTransactionEvent(event, watchedWallets);
  if (affected.length === 0) {
    return { ok: true, skipped: true, reason: "no_watched_wallet_match", txHash: hash };
  }

  const rowsByWallet = new Map(
    watchedWallets
      .map((wallet) => {
        const address = normalizeText(
          typeof wallet === "string" ? wallet : wallet?.wallet_address || wallet?.walletAddress
        );
        return [address, typeof wallet === "string" ? { wallet_address: address } : wallet];
      })
      .filter(([address]) => address)
  );

  const result = {
    ok: true,
    txHash: hash,
    affectedWallets: affected,
    stored: 0,
    reducerEvents: 0,
  };

  for (const walletAddress of affected) {
    const wallet = rowsByWallet.get(walletAddress) || { wallet_address: walletAddress };
    try {
      const stored = await storePftlAccountTransactions({
        walletAddress,
        transactions: [event],
        syncKind: "live",
      });
      const mapped = mapPftlTransaction(event, walletAddress);
      const queued = await enqueuePftlReducerEventsForTransaction({
        walletAddress,
        accountId: wallet.account_id || wallet.accountId || "",
        txHash: hash,
        ledgerIndex: mapped?.ledgerIndex ?? ledgerIndex(event),
        transactionResult: mapped?.transactionResult || transactionResult(event),
        source,
        payload: {
          source,
          txHash: hash,
          ledgerIndex: mapped?.ledgerIndex ?? ledgerIndex(event),
        },
      });
      if (wallet.account_id || wallet.accountId) {
        await publishWalletActivityEvent({
          accountId: wallet.account_id || wallet.accountId || "",
          walletAddress,
          txHash: hash,
          ledgerIndex: mapped?.ledgerIndex ?? ledgerIndex(event),
          source,
        }, { local: false }).catch((error) => {
          logger.warn?.("pftl_cache_watcher_realtime_publish_failed", {
            walletAddress,
            txHash: hash,
            error: safeError(error),
          });
        });
      }
      result.stored += stored?.inserted || 0;
      result.reducerEvents += queued?.inserted || 0;
    } catch (error) {
      await recordPftlSyncError({ walletAddress, error }).catch(() => {});
      logger.warn?.("pftl_cache_watcher_store_failed", {
        walletAddress,
        txHash: hash,
        error: safeError(error),
      });
    }
  }

  return result;
}

function websocketOptions({ endpoint, apiKey, env, timeoutMs }) {
  const options = { handshakeTimeout: timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS };
  if (apiKey) options.headers = { "X-Api-Key": apiKey };
  if (endpoint.startsWith("wss://")) {
    options.rejectUnauthorized = wssRejectUnauthorized(env, endpoint);
  }
  return options;
}

class PftlCacheWatcher {
  constructor({
    id = "default",
    env = process.env,
    socketFactory = (endpoint, options) => new WebSocket(endpoint, options),
    logger = console,
  } = {}) {
    this.id = id;
    this.env = env;
    this.config = pftlCacheWatcherConfig(env);
    this.socketFactory = socketFactory;
    this.logger = logger;
    this.socket = null;
    this.endpointIndex = 0;
    this.pending = new Map();
    this.nextId = 1;
    this.wallets = new Map();
    this.subscribed = new Set();
    this.stopped = false;
    this.connected = false;
    this.lastLedgerIndex = null;
    this.reconnectTimer = null;
    this.refreshTimer = null;
  }

  async start() {
    if (!databaseEnabled()) return { started: false, reason: "database_not_configured" };
    if (this.config.endpoints.length === 0) return { started: false, reason: "wss_not_configured" };
    this.stopped = false;
    await this.refreshWallets({ subscribeNew: false });
    await this.connect();
    this.refreshTimer = setInterval(() => {
      this.refreshWallets({ subscribeNew: true }).catch((error) => {
        this.logger.warn?.("pftl_cache_watcher_wallet_refresh_failed", { error: safeError(error) });
      });
    }, this.config.walletRefreshMs);
    this.refreshTimer.unref?.();
    return { started: true };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.refreshTimer);
    this.rejectPending(new Error("pftl_cache_watcher_stopped"));
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        this.socket.terminate?.();
      }
    }
  }

  async refreshWallets({ subscribeNew = true } = {}) {
    const rows = await listActivePftlSyncWallets({ limit: this.config.walletLimit });
    const next = new Map();
    for (const row of rows) {
      const address = normalizeText(row.wallet_address);
      if (!isValidClassicAddress(address)) continue;
      next.set(address, row);
    }

    const removed = [...this.wallets.keys()].filter((address) => !next.has(address));
    const added = [...next.keys()].filter((address) => !this.wallets.has(address));
    this.wallets = next;

    if (this.connected && subscribeNew) {
      if (added.length > 0) await this.subscribeAccounts(added);
      if (removed.length > 0) await this.unsubscribeAccounts(removed);
    }

    await recordPftlCacheWatcherState({
      id: this.id,
      endpointUrl: this.currentEndpoint(),
      status: this.connected ? "connected" : "idle",
      subscribedWalletCount: this.subscribed.size,
      lastLedgerIndex: this.lastLedgerIndex,
      metadata: { activeWalletCount: this.wallets.size },
    }).catch(() => {});

    return { activeWalletCount: this.wallets.size, added, removed };
  }

  currentEndpoint() {
    return this.config.endpoints[this.endpointIndex % this.config.endpoints.length] || "";
  }

  async connect() {
    const endpoint = this.currentEndpoint();
    await recordPftlCacheWatcherState({
      id: this.id,
      endpointUrl: endpoint,
      status: "connecting",
      subscribedWalletCount: this.subscribed.size,
      lastLedgerIndex: this.lastLedgerIndex,
    }).catch(() => {});

    const socket = this.socketFactory(
      endpoint,
      websocketOptions({
        endpoint,
        apiKey: this.config.apiKey,
        env: this.env,
        timeoutMs: this.config.requestTimeoutMs,
      })
    );
    this.socket = socket;

    socket.on("open", () => {
      socket._socket?.unref?.();
      this.connected = true;
      this.onOpen().catch((error) => this.handleDisconnect(error));
    });
    socket.on("message", (message) => this.onMessage(message));
    socket.on("close", () => this.handleDisconnect(new Error("pftl_cache_wss_closed")));
    socket.on("error", (error) => this.handleDisconnect(error));
  }

  async onOpen() {
    await this.sendRequest({ command: "subscribe", streams: ["ledger"] });
    await this.subscribeAccounts([...this.wallets.keys()]);
    await this.backfillWallets([...this.wallets.values()].slice(0, this.config.backfillLimit), "watcher_start");
    await recordPftlCacheWatcherState({
      id: this.id,
      endpointUrl: this.currentEndpoint(),
      status: "connected",
      subscribedWalletCount: this.subscribed.size,
      lastLedgerIndex: this.lastLedgerIndex,
    }).catch(() => {});
  }

  onMessage(message) {
    let payload;
    try {
      payload = JSON.parse(String(message));
    } catch {
      return;
    }

    if (payload?.id !== undefined) {
      this.resolvePending(payload);
      return;
    }

    if (payload?.type === "ledgerClosed") {
      this.handleLedger(payload).catch((error) => {
        this.logger.warn?.("pftl_cache_watcher_ledger_failed", { error: safeError(error) });
      });
      return;
    }

    if (payload?.type === "transaction") {
      processPftlCacheTransactionEvent({
        event: payload,
        watchedWallets: [...this.wallets.values()],
        source: "pftl_cache_wss",
        logger: this.logger,
      })
        .then((result) => {
          if (!result?.txHash) return;
          recordPftlCacheWatcherState({
            id: this.id,
            endpointUrl: this.currentEndpoint(),
            status: "connected",
            subscribedWalletCount: this.subscribed.size,
            lastLedgerIndex: ledgerIndex(payload),
            lastEventTxHash: result.txHash,
            metadata: {
              affectedWallets: result.affectedWallets || [],
              reducerEvents: result.reducerEvents || 0,
            },
          }).catch(() => {});
        })
        .catch((error) => {
          this.logger.warn?.("pftl_cache_watcher_transaction_failed", { error: safeError(error) });
        });
    }
  }

  async handleLedger(payload) {
    const current = Number(payload.ledger_index || payload.ledgerIndex);
    if (!Number.isFinite(current)) return;
    const previous = this.lastLedgerIndex;
    this.lastLedgerIndex = Math.trunc(current);
    if (previous && this.lastLedgerIndex > previous + 1) {
      await this.backfillWallets([...this.wallets.values()].slice(0, this.config.backfillLimit), "ledger_gap");
    }
    await recordPftlCacheWatcherState({
      id: this.id,
      endpointUrl: this.currentEndpoint(),
      status: "connected",
      subscribedWalletCount: this.subscribed.size,
      lastLedgerIndex: this.lastLedgerIndex,
      metadata: { ledgerGap: previous ? this.lastLedgerIndex - previous : 0 },
    }).catch(() => {});
  }

  handleDisconnect(error) {
    if (this.stopped) return;
    if (this.connected || this.socket) {
      this.logger.warn?.("pftl_cache_watcher_disconnected", {
        endpoint: this.currentEndpoint(),
        error: safeError(error),
      });
    }
    this.connected = false;
    this.subscribed.clear();
    this.rejectPending(error);
    try {
      this.socket?.terminate?.();
    } catch {
      // Socket may already be closed.
    }
    this.socket = null;
    this.endpointIndex = (this.endpointIndex + 1) % this.config.endpoints.length;
    recordPftlCacheWatcherState({
      id: this.id,
      endpointUrl: this.currentEndpoint(),
      status: "reconnecting",
      subscribedWalletCount: 0,
      lastLedgerIndex: this.lastLedgerIndex,
      lastError: safeError(error),
    }).catch(() => {});
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.refreshWallets({ subscribeNew: false })
        .then(() => this.connect())
        .catch((connectError) => this.handleDisconnect(connectError));
    }, this.config.reconnectMs);
    this.reconnectTimer.unref?.();
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  resolvePending(payload) {
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(payload.id);
    if (payload.status === "error" || payload.error || payload.result?.status === "error") {
      const error = new Error(
        payload.error_message ||
          payload.error ||
          payload.result?.error_message ||
          payload.result?.error ||
          "pftl_cache_wss_error"
      );
      error.data = payload;
      pending.reject(error);
      return;
    }
    pending.resolve(payload);
  }

  sendRequest(request) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      const error = new Error("pftl_cache_wss_not_open");
      error.code = "pftl_cache_wss_not_open";
      throw error;
    }

    const id = this.nextId++;
    const payload = { ...request, id };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("pftl_cache_wss_request_timeout"));
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async subscribeAccounts(accounts) {
    const valid = accounts.filter((account) => isValidClassicAddress(account));
    for (let index = 0; index < valid.length; index += this.config.subscribeChunkSize) {
      const chunk = valid.slice(index, index + this.config.subscribeChunkSize);
      if (chunk.length === 0) continue;
      await this.sendRequest({ command: "subscribe", accounts: chunk });
      for (const account of chunk) this.subscribed.add(account);
    }
  }

  async unsubscribeAccounts(accounts) {
    const valid = accounts.filter((account) => this.subscribed.has(account));
    for (let index = 0; index < valid.length; index += this.config.subscribeChunkSize) {
      const chunk = valid.slice(index, index + this.config.subscribeChunkSize);
      if (chunk.length === 0) continue;
      await this.sendRequest({ command: "unsubscribe", accounts: chunk });
      for (const account of chunk) this.subscribed.delete(account);
    }
  }

  async backfillWallets(walletRows, reason) {
    for (const wallet of walletRows) {
      const walletAddress = normalizeText(wallet.wallet_address);
      if (!isValidClassicAddress(walletAddress)) continue;
      const result = await syncPftlWalletTransactions({
        walletAddress,
        accountId: wallet.account_id || "",
        role: wallet.role || "user",
        limit: this.config.backfillAccountTxLimit,
        maxPages: this.config.backfillMaxPages,
        syncKind: "hot",
      });
      if (!result.ok) {
        this.logger.warn?.("pftl_cache_watcher_backfill_failed", {
          walletAddress,
          reason,
          error: result.error,
        });
      }
    }
  }
}

export function startPftlCacheWatcher({
  enabled = process.env.PFTL_CACHE_WSS_WATCHER_ENABLED === "true",
  id = "default",
  env = process.env,
  logger = console,
  socketFactory,
} = {}) {
  if (!enabled) return { started: false, reason: "disabled" };
  const watcher = new PftlCacheWatcher({ id, env, logger, socketFactory });
  watcher.start().catch((error) => {
    logger.warn?.("pftl_cache_watcher_start_failed", { error: safeError(error) });
    recordPftlCacheWatcherState({
      id,
      status: "failed",
      lastError: safeError(error),
    }).catch(() => {});
  });
  return {
    started: true,
    stop: () => watcher.stop(),
    watcher,
  };
}
