import { Client, isValidClassicAddress } from "xrpl";

const CONTENT_KIND = Object.freeze({
  UNSPECIFIED: 0,
  TASK: 1,
  TASK_UPDATE: 2,
  TASK_SUBMISSION: 3,
  CHAT: 4,
  CONTEXT: 5,
  REWARD: 6,
  POLICY: 7,
  IDENTITY: 8,
  ASSET: 9,
  DOCUMENT: 10,
  SYSTEM: 11,
  TEST: 99,
});

const KIND_LABELS = Object.freeze(Object.keys(CONTENT_KIND).reduce((acc, key) => {
  acc[CONTENT_KIND[key]] = key;
  return acc;
}, {}));

const POINTER_MEMO_TYPE = "pf.ptr";
const POINTER_MEMO_FORMAT = "v4";
const RIPPLE_EPOCH_OFFSET = 946684800;
const DEFAULT_HISTORY_WSS_URL = "wss://ws-archive.testnet.postfiat.org";
const DEFAULT_HISTORY_RPC_URL = "https://rpc.testnet.postfiat.org:5006/";
const DEFAULT_ACCOUNT_TX_LIMIT = 200;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_TIMEOUT_MS = 12000;

const textDecoder = new TextDecoder();

function splitUrls(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueUrls(urls) {
  const seen = new Set();
  const unique = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  return unique;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function endpointHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "configured-endpoint";
  }
}

function normalizeWssUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function safeErrorCode(error) {
  return String(error?.code || error?.message || "pftl_history_rpc_error")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .slice(0, 100);
}

function normalizeCid(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.replace(/^ipfs:\/\//i, "").replace(/^\/ipfs\//i, "").split(/[?#]/)[0] || null;
}

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function hexToBytes(hex) {
  const text = String(hex || "").trim();
  if (!text || text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) return null;
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < text.length; index += 2) {
    const byte = Number.parseInt(text.slice(index, index + 2), 16);
    if (!Number.isFinite(byte)) return null;
    bytes[index / 2] = byte;
  }
  return bytes;
}

function hexToUtf8(value) {
  const text = String(value || "").trim();
  const bytes = hexToBytes(text);
  if (!bytes) return text;
  try {
    return textDecoder.decode(bytes);
  } catch {
    return text;
  }
}

function readVarint(bytes, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const byte = bytes[pos];
    result |= (byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) return { value: result, nextOffset: pos };
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

function readLengthDelimited(bytes, offset) {
  const len = readVarint(bytes, offset);
  if (!len) return null;
  const end = len.nextOffset + len.value;
  if (end > bytes.length) return null;
  return { data: bytes.subarray(len.nextOffset, end), nextOffset: end };
}

function readPointerString(bytes, offset) {
  const field = readLengthDelimited(bytes, offset);
  if (!field) return null;
  return {
    value: textDecoder.decode(field.data),
    nextOffset: field.nextOffset,
  };
}

function skipPointerField(bytes, offset, wireType) {
  switch (wireType) {
    case 0: {
      const next = readVarint(bytes, offset);
      return next ? next.nextOffset : -1;
    }
    case 1:
      return offset + 8;
    case 2: {
      const field = readLengthDelimited(bytes, offset);
      return field ? field.nextOffset : -1;
    }
    case 5:
      return offset + 4;
    default:
      return -1;
  }
}

export function decodePftPointerMemo(memoDataHex) {
  const bytes = hexToBytes(memoDataHex);
  if (!bytes) return null;

  const pointer = {};
  let offset = 0;

  try {
    while (offset < bytes.length) {
      const tag = readVarint(bytes, offset);
      if (!tag) break;
      offset = tag.nextOffset;
      const fieldNumber = tag.value >>> 3;
      const wireType = tag.value & 0x07;

      if (fieldNumber === 1 && wireType === 2) {
        const field = readPointerString(bytes, offset);
        if (!field) return null;
        pointer.cid = normalizeCid(field.value);
        offset = field.nextOffset;
      } else if (fieldNumber === 2 && wireType === 0) {
        const field = readVarint(bytes, offset);
        if (!field) return null;
        pointer.target = field.value;
        offset = field.nextOffset;
      } else if (fieldNumber === 3 && wireType === 0) {
        const field = readVarint(bytes, offset);
        if (!field) return null;
        pointer.kind = field.value;
        pointer.kindLabel = KIND_LABELS[field.value] || String(field.value);
        offset = field.nextOffset;
      } else if (fieldNumber === 4 && wireType === 0) {
        const field = readVarint(bytes, offset);
        if (!field) return null;
        pointer.schema = field.value;
        offset = field.nextOffset;
      } else if (fieldNumber === 5 && wireType === 2) {
        const field = readPointerString(bytes, offset);
        if (!field) return null;
        pointer.taskId = field.value;
        offset = field.nextOffset;
      } else if (fieldNumber === 6 && wireType === 2) {
        const field = readPointerString(bytes, offset);
        if (!field) return null;
        pointer.threadId = field.value;
        offset = field.nextOffset;
      } else if (fieldNumber === 7 && wireType === 2) {
        const field = readPointerString(bytes, offset);
        if (!field) return null;
        pointer.contextId = field.value;
        offset = field.nextOffset;
      } else if (fieldNumber === 8 && wireType === 0) {
        const field = readVarint(bytes, offset);
        if (!field) return null;
        pointer.flags = field.value;
        offset = field.nextOffset;
      } else {
        const next = skipPointerField(bytes, offset, wireType);
        if (next < 0 || next > bytes.length) return null;
        offset = next;
      }
    }
  } catch {
    return null;
  }

  return pointer.cid ? pointer : null;
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

function pointerKey(event) {
  return [
    event.txHash || "nohash",
    event.memoIndex ?? 0,
    event.cid || "nocid",
    event.kind ?? "nokind",
    event.contextId || "",
  ].join(":");
}

function sortDesc(left, right) {
  const leftTime = Date.parse(left.createdAt || "") || 0;
  const rightTime = Date.parse(right.createdAt || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return Number(right.ledgerIndex || 0) - Number(left.ledgerIndex || 0);
}

export function extractPftPointerEvents(transactions, walletAddress = "") {
  const rows = Array.isArray(transactions) ? transactions : [];
  const account = normalizeText(walletAddress);
  const pointers = [];

  rows.forEach((entry) => {
    const tx = normalizeAccountTxEntry(entry);
    if (!tx || !Array.isArray(tx.Memos)) return;

    tx.Memos.forEach((memoWrapper, memoIndex) => {
      const memo = memoWrapper?.Memo || memoWrapper || {};
      const memoType = hexToUtf8(memo.MemoType || memo.memo_type || "");
      const memoFormat = hexToUtf8(memo.MemoFormat || memo.memo_format || "");
      if (memoType !== POINTER_MEMO_TYPE || memoFormat !== POINTER_MEMO_FORMAT) return;

      const pointer = decodePftPointerMemo(memo.MemoData || memo.memo_data || "");
      if (!pointer?.cid) return;

      pointers.push({
        cid: pointer.cid,
        kind: pointer.kind ?? null,
        kindLabel: pointer.kindLabel || KIND_LABELS[pointer.kind] || "",
        schema: pointer.schema || null,
        flags: pointer.flags || 0,
        taskId: pointer.taskId || null,
        threadId: pointer.threadId || null,
        contextId: pointer.contextId || null,
        txHash: normalizeTxHash(entry, tx),
        ledgerIndex: normalizeLedgerIndex(entry, tx),
        memoIndex,
        createdAt: normalizeCreatedAt(entry, tx),
        account: tx.Account || null,
        destination: tx.Destination || null,
        direction: tx.Account === account ? "outbound" : tx.Destination === account ? "inbound" : "related",
        source: "pftl_history_rpc",
      });
    });
  });

  const seen = new Set();
  return pointers
    .filter((event) => {
      const key = pointerKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(sortDesc);
}

export function contextPointersFromTransactions(transactions, walletAddress = "") {
  return extractPftPointerEvents(transactions, walletAddress)
    .filter((event) => event.kind === CONTENT_KIND.CONTEXT);
}

export function contextEventsToIndexedSnapshot({ walletAddress, contextEvents } = {}) {
  const events = Array.isArray(contextEvents) ? contextEvents : [];
  return {
    source: "pftl_history_rpc",
    walletAddress,
    contextRevisions: events.map((event, index) => ({
      id: event.contextId || `pftl:${event.txHash || event.cid}:${event.memoIndex ?? index}`,
      cid: event.cid,
      context_id: event.contextId || null,
      tx_hash: event.txHash,
      tx_timestamp: event.createdAt,
      ledger_index: event.ledgerIndex,
      memo_index: event.memoIndex ?? index,
      context_version: event.schema || null,
      schema: event.schema || null,
      flags: event.flags || 0,
      account: event.account || null,
      destination: event.destination || null,
      direction: event.direction || null,
      source: "pftl_history_rpc.account_tx",
    })),
    tasks: [],
    taskEvents: [],
    taskSubmissions: [],
  };
}

export function historyRpcConfig(env = process.env) {
  const hasWssOverride = Object.prototype.hasOwnProperty.call(env, "PFTL_HISTORY_WSS_URL");
  const primaryWssUrl = hasWssOverride
    ? normalizeText(env.PFTL_HISTORY_WSS_URL)
    : DEFAULT_HISTORY_WSS_URL;
  const explicitPrimary = normalizeText(env.PFTL_HISTORY_RPC_URL);
  const primaryUrl = explicitPrimary || DEFAULT_HISTORY_RPC_URL;
  const wssFallbackUrls = splitUrls(env.PFTL_HISTORY_WSS_URL_FALLBACKS);
  const fallbackUrls = splitUrls(env.PFTL_HISTORY_RPC_URL_FALLBACKS);
  return {
    wssUrls: uniqueUrls([primaryWssUrl, ...wssFallbackUrls].map(normalizeWssUrl)),
    rpcUrls: uniqueUrls([primaryUrl, ...fallbackUrls]),
    apiKey: normalizeText(env.PFTL_HISTORY_RPC_API_KEY),
    timeoutMs: clampInteger(env.PFTL_HISTORY_RPC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 60000),
    accountTxLimit: clampInteger(
      env.PFTL_HISTORY_ACCOUNT_TX_LIMIT,
      DEFAULT_ACCOUNT_TX_LIMIT,
      20,
      400
    ),
    maxPages: clampInteger(env.PFTL_HISTORY_ACCOUNT_TX_MAX_PAGES, DEFAULT_MAX_PAGES, 1, 30),
    defaultedWssPrimary: !hasWssOverride,
    defaultedRpcPrimary: !explicitPrimary,
  };
}

async function fetchAccountTxWss({ url, params, timeoutMs }) {
  const client = new Client(url, { connectionTimeout: timeoutMs });
  let timer;

  try {
    await client.connect();
    const request = { command: "account_tx", ...params };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("history_wss_request_timeout");
        error.code = "history_wss_request_timeout";
        reject(error);
      }, timeoutMs);
    });
    const response = await Promise.race([client.request(request), timeout]);
    if (response?.result?.error || response?.result?.status === "error") {
      const error = new Error(response.result.error_message || response.result.error || "history_wss_error");
      error.code = response.result.error || response.result.error_code || "history_wss_error";
      throw error;
    }
    return response?.result || response || {};
  } finally {
    clearTimeout(timer);
    try {
      if (client.isConnected()) await client.disconnect();
    } catch {
      // Disconnect failures are non-fatal after account_tx has resolved.
    }
  }
}

async function fetchJsonRpc({
  url,
  apiKey,
  method,
  params,
  timeoutMs,
  fetchImpl = fetch,
}) {
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
    if (!response.ok) {
      const error = new Error(`history_rpc_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (payload?.error) {
      const error = new Error(payload.error.message || payload.error.error_message || "history_rpc_error");
      error.code = payload.error.code || payload.error.error || "history_rpc_error";
      throw error;
    }
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, "result")) {
      throw new Error("history_rpc_missing_result");
    }
    if (payload.result?.error || payload.result?.status === "error") {
      const error = new Error(payload.result.error_message || payload.result.error || "history_rpc_error");
      error.code = payload.result.error || payload.result.error_code || "history_rpc_error";
      throw error;
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function callHistoryRpc({ config, method, params, fetchImpl }) {
  let lastError = null;
  const attempts = [];

  for (const [index, url] of config.rpcUrls.entries()) {
    try {
      const result = await fetchJsonRpc({
        url,
        apiKey: index === 0 ? config.apiKey : "",
        method,
        params,
        timeoutMs: config.timeoutMs,
        fetchImpl,
      });
      return { result, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({
        endpointHost: endpointHost(url),
        error: safeErrorCode(error),
      });
    }
  }

  const error = lastError || new Error("history_rpc_unavailable");
  error.attempts = attempts;
  throw error;
}

async function requestHistoryAccountTx({ config, params, fetchImpl }) {
  let lastError = null;
  const attempts = [];

  for (const url of config.wssUrls) {
    try {
      const result = await fetchAccountTxWss({
        url,
        params,
        timeoutMs: config.timeoutMs,
      });
      return { result, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({
        source: "pftl_history_wss",
        endpointHost: endpointHost(url),
        error: safeErrorCode(error),
      });
    }
  }

  try {
    const response = await callHistoryRpc({
      config,
      method: "account_tx",
      params: [params],
      fetchImpl,
    });
    return {
      result: response.result,
      attempts: attempts.concat(
        response.attempts.map((attempt) => ({
          source: "pftl_history_rpc",
          ...attempt,
        }))
      ),
    };
  } catch (error) {
    lastError = error;
    attempts.push(...(
      Array.isArray(error.attempts)
        ? error.attempts.map((attempt) => ({
          source: "pftl_history_rpc",
          ...attempt,
        }))
        : []
    ));
  }

  const error = lastError || new Error("history_account_tx_unavailable");
  error.attempts = attempts;
  throw error;
}

export async function fetchHistoricalAccountTransactions({
  walletAddress,
  env = process.env,
  fetchImpl = fetch,
  limit,
  maxPages,
  marker: initialMarker = null,
} = {}) {
  const account = normalizeText(walletAddress);
  if (!isValidClassicAddress(account)) {
    const error = new Error("context_history_invalid_wallet");
    error.status = 400;
    throw error;
  }

  const config = historyRpcConfig(env);
  const pageLimit = clampInteger(limit, config.accountTxLimit, 20, 400);
  const pageMax = clampInteger(maxPages, config.maxPages, 1, 30);
  const pages = [];
  const transactions = [];
  const attempts = [];
  let marker = initialMarker === undefined ? null : initialMarker;
  if (typeof marker === "string" && !marker.trim()) marker = null;

  for (let pageIndex = 0; pageIndex < pageMax; pageIndex += 1) {
    const params = {
      account,
      ledger_index_min: 0,
      ledger_index_max: -1,
      binary: false,
      limit: pageLimit,
      forward: false,
    };
    if (marker) params.marker = marker;

    const response = await requestHistoryAccountTx({
      config,
      params,
      fetchImpl,
    });
    attempts.push(...response.attempts);

    const result = response.result || {};
    const txs = Array.isArray(result.transactions)
      ? result.transactions
      : Array.isArray(result.tx)
        ? result.tx
        : [];
    transactions.push(...txs);
    marker = result.marker || null;
    pages.push({
      count: txs.length,
      marker: marker ? "present" : null,
    });

    if (!marker || txs.length === 0) break;
  }

  return {
    walletAddress: account,
    transactions,
    pages,
    complete: !marker,
    nextMarker: marker || null,
    attempts,
  };
}

export async function discoverContextHistoryFromRpc({
  walletAddress,
  env = process.env,
  fetchImpl = fetch,
  limit,
  maxPages,
} = {}) {
  const txHistory = await fetchHistoricalAccountTransactions({
    walletAddress,
    env,
    fetchImpl,
    limit,
    maxPages,
  });
  const contextEvents = contextPointersFromTransactions(txHistory.transactions, txHistory.walletAddress);
  const snapshot = contextEventsToIndexedSnapshot({
    walletAddress: txHistory.walletAddress,
    contextEvents,
  });

  return {
    ok: true,
    walletAddress: txHistory.walletAddress,
    scannedTransactions: txHistory.transactions.length,
    accountTxPages: txHistory.pages,
    accountTxComplete: txHistory.complete,
    contextUpdateCount: contextEvents.length,
    contextEvents,
    snapshot,
  };
}
