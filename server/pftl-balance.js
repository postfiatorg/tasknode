import WebSocket from "ws";
import { dropsToXrp, isValidClassicAddress } from "xrpl";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_TTL_MS = 15000;
const ZERO_DROPS = "0";
const wssClientCache = new Map();

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

function numericEnv(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1000, Math.floor(number));
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

function hostLabel(value) {
  try {
    return new URL(value).host;
  } catch {
    return "configured-endpoint";
  }
}

function coerceDrops(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  return text;
}

function safeErrorCode(error) {
  const raw =
    error?.code ||
    error?.data?.error ||
    error?.message ||
    error?.name ||
    "pft_balance_error";

  return String(raw).replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
}

function isAccountNotFound(error) {
  const text = [
    error?.code,
    error?.data?.error,
    error?.data?.error_exception,
    error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return text.includes("actnotfound") || text.includes("account not found");
}

function withTimeout(promise, timeoutMs, code) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function endpointCandidates(env) {
  const explicitWss = splitUrls(env.PFTL_WSS_URL || env.VITE_PFTL_WSS_URL).map(normalizeWssUrl);
  const fallbackWss = splitUrls(env.PFTL_WSS_URL_FALLBACKS).map(normalizeWssUrl);
  const derivedWss = splitUrls(env.PFTL_RPC_URL)
    .map(normalizeWssUrl)
    .filter((url) => url.startsWith("ws://") || url.startsWith("wss://"));
  const rpc = uniqueUrls([
    ...splitUrls(env.PFTL_RPC_URL),
    ...splitUrls(env.PFTL_RPC_URL_FALLBACKS),
  ]);

  return {
    wss: uniqueUrls([...explicitWss, ...fallbackWss, ...derivedWss]),
    rpc,
  };
}

function dropsToPft(drops) {
  try {
    return dropsToXrp(drops);
  } catch {
    return String(Number(drops || 0) / 1_000_000);
  }
}

function wssRejectUnauthorized(env, url) {
  const configured = String(env.PFTL_WSS_REJECT_UNAUTHORIZED || "").trim().toLowerCase();
  if (["false", "0", "no"].includes(configured)) return false;
  if (["true", "1", "yes"].includes(configured)) return true;

  try {
    const hostname = new URL(url).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "178.156.143.199") {
      return false;
    }
  } catch {
    return true;
  }

  return true;
}

function cachedWssKey({ url, apiKey, rejectUnauthorized }) {
  return `${url}::${apiKey ? "auth" : "public"}::${rejectUnauthorized ? "tls" : "insecure-tls"}`;
}

function rejectPending(client, error) {
  for (const pending of client.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  client.pending.clear();
}

function attachWssHandlers({ key, client }) {
  client.socket.on("message", (message) => {
    let payload;
    try {
      payload = JSON.parse(String(message));
    } catch {
      return;
    }

    const pending = client.pending.get(payload?.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    client.pending.delete(payload.id);

    if (payload.status === "error" || payload.error) {
      const error = new Error(payload.error_message || payload.error || "pftl_wss_error");
      error.code = payload.error || payload.error_code || "pftl_wss_error";
      error.data = payload;
      pending.reject(error);
      return;
    }

    pending.resolve(payload);
  });

  client.socket.on("close", () => {
    wssClientCache.delete(key);
    const error = new Error("pftl_wss_closed");
    error.code = "pftl_wss_closed";
    rejectPending(client, error);
  });

  client.socket.on("error", (error) => {
    wssClientCache.delete(key);
    rejectPending(client, error);
  });
}

async function cachedWssClient({ url, apiKey, timeoutMs, rejectUnauthorized }) {
  const key = cachedWssKey({ url, apiKey, rejectUnauthorized });
  const cached = wssClientCache.get(key);
  if (cached?.client?.socket?.readyState === WebSocket.OPEN) return cached.client;
  if (cached?.connecting) return cached.connecting;

  const options = {
    handshakeTimeout: timeoutMs,
  };

  if (apiKey) {
    options.headers = { "X-Api-Key": apiKey };
  }
  if (url.startsWith("wss://")) {
    options.rejectUnauthorized = rejectUnauthorized;
  }

  const socket = new WebSocket(url, options);
  const client = {
    socket,
    pending: new Map(),
    nextId: 1,
  };

  const connecting = withTimeout(
    new Promise((resolve, reject) => {
      socket.once("open", () => {
        socket._socket?.unref?.();
        resolve(client);
      });
      socket.once("error", reject);
    }),
    timeoutMs,
    "pftl_wss_connect_timeout"
  )
    .then(() => {
      wssClientCache.set(key, { client });
      attachWssHandlers({ key, client });
      return client;
    })
    .catch((error) => {
      wssClientCache.delete(key);
      try {
        socket.terminate();
      } catch {
        // Ignore cleanup failures while surfacing the connect error.
      }
      throw error;
    });

  wssClientCache.set(key, { client, connecting });
  return connecting;
}

function sendWssRequest(client, request, timeoutMs) {
  if (client.socket.readyState !== WebSocket.OPEN) {
    const error = new Error("pftl_wss_not_open");
    error.code = "pftl_wss_not_open";
    throw error;
  }

  const id = client.nextId++;
  const payload = {
    ...request,
    id,
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.pending.delete(id);
      const error = new Error("pftl_wss_request_timeout");
      error.code = "pftl_wss_request_timeout";
      reject(error);
    }, timeoutMs);

    client.pending.set(id, { resolve, reject, timeout });
    client.socket.send(JSON.stringify(payload), (error) => {
      if (!error) return;
      clearTimeout(timeout);
      client.pending.delete(id);
      reject(error);
    });
  });
}

async function readBalanceViaWss({ url, address, apiKey, timeoutMs, rejectUnauthorized = true }) {
  const client = await cachedWssClient({ url, apiKey, timeoutMs, rejectUnauthorized });
  const response = await sendWssRequest(
    client,
    {
      command: "account_info",
      account: address,
      ledger_index: "validated",
    },
    timeoutMs
  );

  return coerceDrops(response?.result?.account_data?.Balance);
}

async function readBalanceViaRpc({ url, address, apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      "content-type": "application/json",
    };
    if (apiKey) headers["X-Api-Key"] = apiKey;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "account_info",
        params: [
          {
            account: address,
            ledger_index: "validated",
          },
        ],
        id: 1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(`http_${response.status}`);
      error.code = `http_${response.status}`;
      throw error;
    }

    const payload = await response.json();
    if (payload?.error) {
      const error = new Error(payload.error?.message || payload.error);
      error.code = payload.error?.code || payload.error?.message || "rpc_error";
      error.data = payload.error;
      throw error;
    }
    if (payload?.result?.error) {
      const error = new Error(payload.result.error);
      error.code = payload.result.error;
      error.data = payload.result;
      throw error;
    }

    return coerceDrops(payload?.result?.account_data?.Balance);
  } finally {
    clearTimeout(timeout);
  }
}

function successResult({ address, balanceDrops, source, url, accountExists, nowMs, cached = false }) {
  return {
    ok: true,
    address,
    balanceDrops,
    balancePft: dropsToPft(balanceDrops),
    source,
    endpointHost: hostLabel(url),
    ledgerIndex: "validated",
    accountExists,
    fetchedAt: new Date(nowMs).toISOString(),
    cached,
  };
}

export function createPftBalanceService({
  env = process.env,
  cache = new Map(),
  now = () => Date.now(),
  requestWss = readBalanceViaWss,
  requestRpc = readBalanceViaRpc,
} = {}) {
  async function fetchPftBalance(address, options = {}) {
    const normalizedAddress = String(address || "").trim();
    const force = options.force === true;
    const timeoutMs = numericEnv(env.PFT_BALANCE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const cacheTtlMs = numericEnv(env.PFT_BALANCE_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);

    if (!isValidClassicAddress(normalizedAddress)) {
      return {
        ok: false,
        status: 400,
        error: "pft_balance_invalid_address",
        message: "The linked wallet address is not a valid PFTL classic address.",
      };
    }

    const cacheKey = normalizedAddress;
    const cached = cache.get(cacheKey);
    if (!force && cached && now() - cached.nowMs <= cacheTtlMs) {
      return {
        ...cached.result,
        cached: true,
      };
    }

    const endpoints = endpointCandidates(env);
    const attempts = [];
    if (endpoints.wss.length === 0 && endpoints.rpc.length === 0) {
      return {
        ok: false,
        status: 503,
        error: "pft_balance_not_configured",
        message: "Balance service is not configured for this environment.",
      };
    }

    for (const [index, url] of endpoints.wss.entries()) {
      try {
        const balanceDrops = await requestWss({
          url,
          address: normalizedAddress,
          apiKey: index === 0 ? env.PFTL_RPC_API_KEY || "" : "",
          timeoutMs,
          rejectUnauthorized: wssRejectUnauthorized(env, url),
        });

        if (balanceDrops === null) throw new Error("pftl_balance_missing");

        const result = successResult({
          address: normalizedAddress,
          balanceDrops,
          source: "pftl_wss",
          url,
          accountExists: true,
          nowMs: now(),
        });
        cache.set(cacheKey, { nowMs: now(), result });
        return result;
      } catch (error) {
        if (isAccountNotFound(error)) {
          const result = successResult({
            address: normalizedAddress,
            balanceDrops: ZERO_DROPS,
            source: "pftl_wss",
            url,
            accountExists: false,
            nowMs: now(),
          });
          cache.set(cacheKey, { nowMs: now(), result });
          return result;
        }

        attempts.push({
          source: "pftl_wss",
          endpointHost: hostLabel(url),
          error: safeErrorCode(error),
        });
      }
    }

    for (const [index, url] of endpoints.rpc.entries()) {
      try {
        const balanceDrops = await requestRpc({
          url,
          address: normalizedAddress,
          apiKey: index === 0 ? env.PFTL_RPC_API_KEY || "" : "",
          timeoutMs,
        });

        if (balanceDrops === null) throw new Error("pftl_balance_missing");

        const result = successResult({
          address: normalizedAddress,
          balanceDrops,
          source: "pftl_rpc",
          url,
          accountExists: true,
          nowMs: now(),
        });
        cache.set(cacheKey, { nowMs: now(), result });
        return result;
      } catch (error) {
        if (isAccountNotFound(error)) {
          const result = successResult({
            address: normalizedAddress,
            balanceDrops: ZERO_DROPS,
            source: "pftl_rpc",
            url,
            accountExists: false,
            nowMs: now(),
          });
          cache.set(cacheKey, { nowMs: now(), result });
          return result;
        }

        attempts.push({
          source: "pftl_rpc",
          endpointHost: hostLabel(url),
          error: safeErrorCode(error),
        });
      }
    }

    return {
      ok: false,
      status: 502,
      error: "pft_balance_unavailable",
      message: "The PFT balance service could not read the validated PFTL ledger.",
      address: normalizedAddress,
      attempts,
      fetchedAt: new Date(now()).toISOString(),
    };
  }

  return {
    fetchPftBalance,
  };
}

const defaultPftBalanceService = createPftBalanceService();

export const fetchPftBalance = defaultPftBalanceService.fetchPftBalance;
