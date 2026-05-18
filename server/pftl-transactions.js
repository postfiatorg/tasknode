import { isValidClassicAddress } from "xrpl";
import {
  extractPftPointerEvents,
  fetchHistoricalAccountTransactions,
} from "./context-history-rpc.js";
import { readCachedAccountTx } from "./pftl-cache-sync.js";

const PFT_DROPS_PER_PFT = 1_000_000;
const RIPPLE_EPOCH_OFFSET = 946684800;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_CACHE_TTL_MS = 30_000;
const txCache = new Map();

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function safeErrorCode(error) {
  return String(error?.code || error?.message || "pft_transactions_unavailable")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .slice(0, 100);
}

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function shortAddress(address) {
  const text = normalizeText(address);
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function normalizeAccountTxEntry(entry) {
  const candidate = entry?.tx_json || entry?.tx || entry?.transaction || entry;
  if (!candidate) return null;
  if (typeof candidate === "string") {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return typeof candidate === "object" ? candidate : null;
}

function normalizeTxHash(entry, tx) {
  return normalizeText(tx?.hash || tx?.Hash || entry?.hash || entry?.tx_hash || entry?.txHash) || null;
}

function normalizeLedgerIndex(entry, tx) {
  const value = tx?.ledger_index || tx?.ledgerIndex || entry?.ledger_index || entry?.ledgerIndex;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTransactionResult(entry) {
  return normalizeText(
    entry?.meta?.TransactionResult ||
      entry?.metaData?.TransactionResult ||
      entry?.meta?.transaction_result ||
      entry?.metaData?.transaction_result
  );
}

function rippleTimeToIso(txDate) {
  if (typeof txDate !== "number") return null;
  const date = new Date((txDate + RIPPLE_EPOCH_OFFSET) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeCreatedAt(entry, tx) {
  const rippleDate = typeof tx?.date === "number" ? tx.date : entry?.date;
  const fromRipple = rippleTimeToIso(rippleDate);
  if (fromRipple) return fromRipple;

  const direct = entry?.close_time_iso || entry?.createdAt || entry?.created_at || tx?.close_time_iso;
  if (!direct) return null;
  const date = new Date(String(direct));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nativeDrops(value) {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return "";
}

function dropsToPftString(drops) {
  const numeric = Number(drops || 0) / PFT_DROPS_PER_PFT;
  if (!Number.isFinite(numeric)) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6,
  }).format(numeric);
}

function pointerLabel(pointer, direction) {
  const kind = String(pointer?.kindLabel || "").toUpperCase();
  if (kind === "REWARD") return "Task reward";
  if (kind === "TASK_SUBMISSION") return direction === "in" ? "Task evidence received" : "Task evidence";
  if (kind === "TASK_UPDATE") return "Task update";
  if (kind === "TASK") return direction === "in" ? "Task received" : "Task request";
  if (kind === "CONTEXT") return "Context pointer";
  if (pointer?.cid) return "PFTL pointer";
  return "";
}

function transactionLabel({ pointer, direction, isSelfPayment }) {
  if (isSelfPayment) return "Self transfer";
  const fromPointer = pointerLabel(pointer, direction);
  if (fromPointer) return fromPointer;
  return direction === "in" ? "Received PFT" : "Sent PFT";
}

function transactionNote(pointer) {
  if (pointer?.taskId) return pointer.taskId;
  if (pointer?.contextId) return pointer.contextId;
  if (pointer?.cid) return pointer.cid;
  return "";
}

function sortTransactionsDesc(left, right) {
  const leftTime = Date.parse(left.createdAt || "") || 0;
  const rightTime = Date.parse(right.createdAt || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return Number(right.ledgerIndex || 0) - Number(left.ledgerIndex || 0);
}

export function normalizeWalletTransactions(transactions, walletAddress = "", { limit = DEFAULT_LIMIT } = {}) {
  const account = normalizeText(walletAddress);
  const pointers = extractPftPointerEvents(transactions, account);
  const pointerByHash = new Map();
  for (const pointer of pointers) {
    if (!pointer?.txHash || pointerByHash.has(pointer.txHash)) continue;
    pointerByHash.set(pointer.txHash, pointer);
  }

  const rows = [];
  for (const entry of Array.isArray(transactions) ? transactions : []) {
    const tx = normalizeAccountTxEntry(entry);
    if (!tx || tx.TransactionType !== "Payment") continue;
    const transactionResult = normalizeTransactionResult(entry);
    if (transactionResult && transactionResult !== "tesSUCCESS") continue;

    const source = normalizeText(tx.Account);
    const destination = normalizeText(tx.Destination);
    const inbound = destination === account;
    const outbound = source === account;
    if (!inbound && !outbound) continue;

    const amountDrops = nativeDrops(tx.DeliverMax || tx.deliverMax || tx.delivered_amount || tx.Amount);
    if (!amountDrops) continue;

    const txHash = normalizeTxHash(entry, tx);
    const pointer = pointerByHash.get(txHash) || null;
    const isSelfPayment = inbound && outbound;
    const direction = isSelfPayment ? "self" : inbound ? "in" : "out";
    const signedDrops = direction === "out" ? `-${amountDrops}` : amountDrops;
    const counterparty = direction === "in" ? source : destination;
    const createdAt = normalizeCreatedAt(entry, tx);

    rows.push({
      id: txHash || `${normalizeLedgerIndex(entry, tx) || "ledger"}:${rows.length}`,
      txHash,
      ledgerIndex: normalizeLedgerIndex(entry, tx),
      createdAt,
      type: direction,
      label: transactionLabel({ pointer, direction, isSelfPayment }),
      counterparty,
      counterpartyLabel: shortAddress(counterparty),
      note: transactionNote(pointer),
      amountDrops,
      signedDrops,
      amountPft: dropsToPftString(amountDrops),
      feeDrops: nativeDrops(tx.Fee),
      pointer: pointer
        ? {
            cid: pointer.cid,
            kind: pointer.kind,
            kindLabel: pointer.kindLabel,
            taskId: pointer.taskId,
            contextId: pointer.contextId,
          }
        : null,
      transactionResult: transactionResult || null,
    });
  }

  const seen = new Set();
  return rows
    .filter((row) => {
      const key = row.txHash || row.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(sortTransactionsDesc)
    .slice(0, clampInteger(limit, DEFAULT_LIMIT, 1, 100));
}

export async function fetchWalletTransactions(walletAddress, {
  accountId = "",
  force = false,
  limit = DEFAULT_LIMIT,
  maxPages = DEFAULT_MAX_PAGES,
} = {}) {
  const account = normalizeText(walletAddress);
  if (!isValidClassicAddress(account)) {
    return {
      ok: false,
      status: 400,
      error: "pft_transactions_invalid_address",
      message: "The linked wallet address is not a valid PFTL classic address.",
    };
  }

  const normalizedLimit = clampInteger(limit, DEFAULT_LIMIT, 1, 100);
  const normalizedMaxPages = clampInteger(maxPages, DEFAULT_MAX_PAGES, 1, 10);
  const cacheKey = `${account}:${normalizedLimit}:${normalizedMaxPages}`;
  const now = Date.now();
  const cached = txCache.get(cacheKey);
  if (!force && cached && now - cached.cachedAtMs < DEFAULT_CACHE_TTL_MS) {
    return {
      ...cached.result,
      cached: true,
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
    };
  }

  try {
    const cachedAccountTx = await readCachedAccountTx({
      walletAddress: account,
      accountId,
      limit: Math.max(50, normalizedLimit),
      forceSync: force,
      syncIfEmpty: true,
    });
    if (cachedAccountTx.ok && (cachedAccountTx.transactions.length > 0 || cachedAccountTx.sync?.attempted?.ok)) {
      const transactions = normalizeWalletTransactions(cachedAccountTx.transactions, account, {
        limit: normalizedLimit,
      });
      const result = {
        ok: true,
        status: 200,
        walletAddress: account,
        transactions,
        count: transactions.length,
        scannedTransactions: cachedAccountTx.transactions.length,
        complete: cachedAccountTx.sync?.attempted?.complete ?? null,
        fetchedAt: new Date().toISOString(),
        source: "pftl_cache",
        sync: cachedAccountTx.sync,
      };
      txCache.set(cacheKey, { cachedAtMs: now, result });
      return result;
    }
  } catch {
    // Fall through to direct PFTL history read. Cache failures should not make
    // the wallet page unusable while the cache is still rolling out.
  }

  try {
    const history = await fetchHistoricalAccountTransactions({
      walletAddress: account,
      limit: Math.max(50, normalizedLimit),
      maxPages: normalizedMaxPages,
    });
    const transactions = normalizeWalletTransactions(history.transactions, account, { limit: normalizedLimit });
    const result = {
      ok: true,
      status: 200,
      walletAddress: account,
      transactions,
      count: transactions.length,
      scannedTransactions: history.transactions.length,
      complete: history.complete,
      fetchedAt: new Date().toISOString(),
      source: "pftl_account_tx",
    };
    txCache.set(cacheKey, { cachedAtMs: now, result });
    return result;
  } catch (error) {
    return {
      ok: false,
      status: error?.status || 502,
      error: safeErrorCode(error),
      message: "The PFT transaction feed could not read account history.",
    };
  }
}
