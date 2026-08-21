import https from "node:https";
import { Client, isValidClassicAddress } from "xrpl";
import { fetchContextIpfsJson, normalizeContextCid } from "./context-ipfs.js";
import { pftlWssRejectUnauthorized } from "./pftl-wss-tls.js";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 400;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_GATEWAY_BASE = "https://dweb.link/ipfs/";
const DEFAULT_METADATA_CONCURRENCY = 4;

function splitUrls(value = "") {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueUrls(urls = []) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function normalizeWssUrl(value = "") {
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

function endpointCandidates(env = process.env) {
  const explicit = splitUrls(env.PFTL_WSS_URL || env.VITE_PFTL_WSS_URL).map(normalizeWssUrl);
  const fallback = splitUrls(env.PFTL_WSS_URL_FALLBACKS).map(normalizeWssUrl);
  const derived = splitUrls(env.PFTL_RPC_URL || env.PFTL_RPC_URL_FALLBACKS)
    .filter((url) => /^wss?:\/\//i.test(url))
    .map(normalizeWssUrl);
  return uniqueUrls([...explicit, ...fallback, ...derived]);
}

function endpointHost(value = "") {
  try {
    return new URL(value).host;
  } catch {
    return "configured-endpoint";
  }
}

function numericEnv(value, fallback, min = 1000, max = 120000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

async function mapWithConcurrency(items = [], concurrency = DEFAULT_METADATA_CONCURRENCY, mapper) {
  const boundedConcurrency = clampInteger(concurrency, DEFAULT_METADATA_CONCURRENCY, 1, 12);
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(boundedConcurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function safeErrorCode(error) {
  return String(error?.code || error?.data?.error || error?.message || "pftl_nft_error")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .slice(0, 100);
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

function clientOptionsForEndpoint({ endpoint = "", index = 0, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const options = { connectionTimeout: timeoutMs };
  const rejectUnauthorized = pftlWssRejectUnauthorized({ env, url: endpoint });
  if (!rejectUnauthorized) {
    options.rejectUnauthorized = false;
    options.agent = new https.Agent({ rejectUnauthorized: false });
  }
  const apiKey = safeText(env.PFTL_RPC_API_KEY, 500);
  if (index === 0 && apiKey) options.headers = { "X-Api-Key": apiKey };
  return options;
}

export function decodeHexToUtf8(value = "") {
  const text = safeText(value, 4000);
  if (!text || text.length % 2 !== 0 || !/^[A-Fa-f0-9]+$/.test(text)) return "";
  try {
    return Buffer.from(text, "hex").toString("utf8");
  } catch {
    return "";
  }
}

function normalizeTokenId(value = "") {
  const text = safeText(value, 256);
  return /^[A-Fa-f0-9]{32,256}$/.test(text) ? text.toUpperCase() : "";
}

export function ipfsCidFromUri(value = "") {
  const text = safeText(value, 1000);
  if (!text) return "";
  if (/^ipfs:\/\//i.test(text) || /^\/ipfs\//i.test(text)) {
    return normalizeContextCid(text);
  }
  try {
    const url = new URL(text);
    const marker = "/ipfs/";
    const index = url.pathname.indexOf(marker);
    if (index >= 0) return normalizeContextCid(url.pathname.slice(index + marker.length));
  } catch {
    return "";
  }
  return "";
}

export function imageGatewayUrlForCid(cid = "", gatewayBase = DEFAULT_GATEWAY_BASE) {
  const normalized = normalizeContextCid(cid);
  const base = safeText(gatewayBase, 500) || DEFAULT_GATEWAY_BASE;
  return normalized ? `${base.replace(/\/+$/, "")}/${encodeURIComponent(normalized)}` : "";
}

export function normalizeAccountNftRecord(record = {}, { gatewayBase = DEFAULT_GATEWAY_BASE } = {}) {
  const tokenId = normalizeTokenId(record.NFTokenID || record.nftoken_id || record.nftTokenId);
  const uriHex = safeText(record.URI || record.uriHex, 4000).toUpperCase();
  const metadataUri = safeText(decodeHexToUtf8(uriHex) || record.uri || record.metadataUri, 1000);
  const metadataCid = ipfsCidFromUri(metadataUri);
  return {
    tokenId,
    nftTokenId: tokenId,
    issuer: safeText(record.Issuer || record.issuer, 160),
    owner: safeText(record.Owner || record.owner, 160),
    taxon: Number(record.NFTokenTaxon ?? record.nft_taxon ?? 0),
    flags: Number(record.Flags ?? record.flags ?? 0),
    nftSerial: Number(record.nft_serial ?? record.nftSerial ?? 0),
    transferFee: Number(record.TransferFee ?? record.transferFee ?? 0),
    uriHex,
    metadataUri,
    metadataCid,
    metadataGatewayUrl: imageGatewayUrlForCid(metadataCid, gatewayBase),
  };
}

function metadataImageUri(metadata = {}) {
  const candidates = [
    metadata.image,
    metadata.image_url,
    metadata.imageUrl,
    metadata.thumbnail,
    metadata.thumbnail_url,
    metadata.thumbnailUrl,
  ];
  return safeText(candidates.find((value) => safeText(value, 1000)), 1000);
}

async function enrichWithIpfsMetadata(nft, { fetchMetadata = true, timeoutMs = DEFAULT_TIMEOUT_MS, gatewayBase = DEFAULT_GATEWAY_BASE } = {}) {
  if (!fetchMetadata || !nft.metadataCid) {
    return {
      ...nft,
      metadata: null,
      imageUri: "",
      imageCid: "",
      imageGatewayUrl: "",
      title: "",
      description: "",
      metadataFetch: nft.metadataCid ? "skipped" : "missing_metadata_cid",
    };
  }

  const fetched = await fetchContextIpfsJson({ cid: nft.metadataCid, timeoutMs });
  if (!fetched.ok) {
    return {
      ...nft,
      metadata: null,
      imageUri: "",
      imageCid: "",
      imageGatewayUrl: "",
      title: "",
      description: "",
      metadataFetch: fetched.error || "metadata_fetch_failed",
    };
  }

  const metadata = fetched.payload && typeof fetched.payload === "object" ? fetched.payload : {};
  const imageUri = metadataImageUri(metadata);
  const imageCid = ipfsCidFromUri(imageUri);
  return {
    ...nft,
    metadata,
    imageUri,
    imageCid,
    imageGatewayUrl: imageGatewayUrlForCid(imageCid, gatewayBase),
    title: safeText(metadata.name || metadata.title, 160),
    description: safeText(metadata.description, 1000),
    metadataFetch: "ok",
  };
}

async function readAccountNftsFromEndpoint({ endpoint, index = 0, walletAddress = "", env = process.env, limit, maxPages, timeoutMs } = {}) {
  const client = new Client(endpoint, clientOptionsForEndpoint({ endpoint, index, env, timeoutMs }));
  await client.connect();
  try {
    const rows = [];
    let marker = null;
    for (let page = 0; page < maxPages; page += 1) {
      const request = {
        command: "account_nfts",
        account: walletAddress,
        ledger_index: "validated",
        limit,
      };
      if (marker) request.marker = marker;
      const response = await client.request(request);
      const nfts = Array.isArray(response?.result?.account_nfts) ? response.result.account_nfts : [];
      rows.push(...nfts);
      marker = response?.result?.marker || null;
      if (!marker) break;
    }
    return rows;
  } finally {
    try {
      await client.disconnect();
    } catch {
      // Preserve the read result or read error.
    }
  }
}

export async function fetchWalletNftInventory({
  walletAddress = "",
  env = process.env,
  fetchMetadata = true,
  limit = DEFAULT_LIMIT,
  maxPages = DEFAULT_MAX_PAGES,
  timeoutMs = null,
  gatewayBase = DEFAULT_GATEWAY_BASE,
  metadataConcurrency = DEFAULT_METADATA_CONCURRENCY,
} = {}) {
  const normalizedWallet = safeText(walletAddress, 120);
  if (!isValidClassicAddress(normalizedWallet)) {
    return {
      ok: false,
      status: 400,
      error: "pftl_nft_invalid_wallet",
      message: "Wallet address is not a valid PFTL classic address.",
      walletAddress: normalizedWallet,
    };
  }

  const boundedLimit = clampInteger(limit, DEFAULT_LIMIT, 1, 400);
  const boundedMaxPages = clampInteger(maxPages, DEFAULT_MAX_PAGES, 1, 20);
  const requestTimeoutMs = timeoutMs || numericEnv(env.PFTL_NFT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const endpoints = endpointCandidates(env);
  if (!endpoints.length) {
    return {
      ok: false,
      status: 503,
      error: "pftl_nft_wss_not_configured",
      message: "No PFTL websocket endpoint is configured.",
      walletAddress: normalizedWallet,
    };
  }

  const attempts = [];
  for (const [index, endpoint] of endpoints.entries()) {
    try {
      const rawNfts = await readAccountNftsFromEndpoint({
        endpoint,
        index,
        walletAddress: normalizedWallet,
        env,
        limit: boundedLimit,
        maxPages: boundedMaxPages,
        timeoutMs: requestTimeoutMs,
      });
      const normalized = rawNfts.map((record) => normalizeAccountNftRecord(record, { gatewayBase }));
      const nfts = await mapWithConcurrency(normalized, metadataConcurrency, (nft) =>
        enrichWithIpfsMetadata(nft, {
          fetchMetadata,
          timeoutMs: requestTimeoutMs,
          gatewayBase,
        })
      );
      return {
        ok: true,
        walletAddress: normalizedWallet,
        accountExists: true,
        source: "pftl_account_nfts",
        endpointHost: endpointHost(endpoint),
        ledgerIndex: "validated",
        count: nfts.length,
        nfts,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (isAccountNotFound(error)) {
        return {
          ok: true,
          walletAddress: normalizedWallet,
          accountExists: false,
          source: "pftl_account_nfts",
          endpointHost: endpointHost(endpoint),
          ledgerIndex: "validated",
          count: 0,
          nfts: [],
          fetchedAt: new Date().toISOString(),
        };
      }
      attempts.push({
        endpointHost: endpointHost(endpoint),
        error: safeErrorCode(error),
      });
    }
  }

  return {
    ok: false,
    status: 502,
    error: "pftl_nft_inventory_unavailable",
    message: "Could not read wallet NFT inventory from PFTL.",
    walletAddress: normalizedWallet,
    attempts,
    fetchedAt: new Date().toISOString(),
  };
}
