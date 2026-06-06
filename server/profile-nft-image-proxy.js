import { isValidContextCid, normalizeContextCid } from "./context-ipfs.js";

const DEFAULT_GATEWAYS = [
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
];

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 8_388_608;
const DEFAULT_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_CACHE_MAX_BYTES = 80 * 1024 * 1024;
const allowedContentTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const imageCache = new Map();
let imageCacheBytes = 0;

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function numericEnv(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function configuredGateways(env = process.env) {
  const configured = [
    env.TASKNODE_PROFILE_NFT_IMAGE_GATEWAYS,
    env.TASKNODE_IPFS_GATEWAY,
    env.IPFS_GATEWAY_URL,
    env.TASKNODE_IPFS_GATEWAYS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...configured, ...DEFAULT_GATEWAYS]
    .map((value) => value.endsWith("/") ? value : `${value}/`)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function cacheGet(cid, ttlMs) {
  const cached = imageCache.get(cid);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > ttlMs) {
    imageCache.delete(cid);
    imageCacheBytes -= cached.bytes.length;
    return null;
  }
  imageCache.delete(cid);
  imageCache.set(cid, cached);
  return cached;
}

function cacheSet(cid, value, maxCacheBytes) {
  imageCache.set(cid, value);
  imageCacheBytes += value.bytes.length;
  while (imageCacheBytes > maxCacheBytes && imageCache.size > 0) {
    const [oldestKey, oldestValue] = imageCache.entries().next().value;
    imageCache.delete(oldestKey);
    imageCacheBytes -= oldestValue.bytes.length;
  }
}

function gatewayUrl(gateway = "", cid = "") {
  return `${String(gateway || "").replace(/\/$/, "")}/${encodeURIComponent(cid)}`;
}

function cleanContentType(value = "") {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

async function responseBytes(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    const error = new Error("profile_nft_image_too_large");
    error.status = 413;
    throw error;
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.length > maxBytes) {
    const error = new Error("profile_nft_image_too_large");
    error.status = 413;
    throw error;
  }
  return bytes;
}

async function fetchFromGateway({ cid, gateway, fetchImpl, maxBytes, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(gatewayUrl(gateway, cid), {
      method: "GET",
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`HTTP_${response.status}`);
      error.status = response.status;
      throw error;
    }
    const contentType = cleanContentType(response.headers.get("content-type"));
    if (!allowedContentTypes.has(contentType)) {
      const error = new Error("profile_nft_image_content_type_invalid");
      error.status = 415;
      throw error;
    }
    const bytes = await responseBytes(response, maxBytes);
    return {
      ok: true,
      cid,
      bytes,
      contentType,
      gateway,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function profileNftImageProxyPath(cid = "") {
  const normalized = normalizeContextCid(cid);
  return normalized ? `/api/profile/nft/image/${encodeURIComponent(normalized)}` : "";
}

export async function fetchProfileNftImage({
  cid = "",
  env = process.env,
  fetchImpl = fetch,
  gateways = null,
  timeoutMs = null,
  maxBytes = null,
  cacheTtlMs = null,
  maxCacheBytes = null,
} = {}) {
  const normalizedCid = normalizeContextCid(safeText(cid, 180));
  if (!isValidContextCid(normalizedCid)) {
    return {
      ok: false,
      status: 400,
      error: "profile_nft_image_cid_invalid",
      message: "Profile NFT image CID is not valid.",
      cid: normalizedCid,
    };
  }

  const ttlMs = numericEnv(cacheTtlMs ?? env.TASKNODE_PROFILE_NFT_IMAGE_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 0, 24 * 60 * 60_000);
  const cached = ttlMs > 0 ? cacheGet(normalizedCid, ttlMs) : null;
  if (cached) {
    return {
      ok: true,
      cid: normalizedCid,
      ...cached,
      cache: "hit",
    };
  }

  const boundedTimeoutMs = numericEnv(timeoutMs ?? env.TASKNODE_PROFILE_NFT_IMAGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 60000);
  const boundedMaxBytes = numericEnv(maxBytes ?? env.TASKNODE_PROFILE_NFT_IMAGE_MAX_BYTES, DEFAULT_MAX_BYTES, 1024, 32 * 1024 * 1024);
  const gatewayList = Array.isArray(gateways) && gateways.length ? gateways : configuredGateways(env);
  const attempts = [];

  const fetches = gatewayList.map(async (gateway) => {
    try {
      return await fetchFromGateway({
        cid: normalizedCid,
        gateway,
        fetchImpl,
        maxBytes: boundedMaxBytes,
        timeoutMs: boundedTimeoutMs,
      });
    } catch (error) {
      attempts.push({
        gateway: safeText(gateway, 160),
        error: safeText(error?.message || "profile_nft_image_gateway_failed", 120),
      });
      throw error;
    }
  });

  try {
    const result = await Promise.any(fetches);
    const cachedValue = {
      bytes: result.bytes,
      contentType: result.contentType,
      gateway: result.gateway,
      fetchedAt: result.fetchedAt,
      cachedAt: Date.now(),
    };
    if (ttlMs > 0) {
      cacheSet(
        normalizedCid,
        cachedValue,
        numericEnv(maxCacheBytes ?? env.TASKNODE_PROFILE_NFT_IMAGE_CACHE_MAX_BYTES, DEFAULT_CACHE_MAX_BYTES, 1_000_000, 512 * 1024 * 1024)
      );
    }
    return {
      ok: true,
      cid: normalizedCid,
      ...cachedValue,
      cache: "miss",
    };
  } catch {
    await Promise.allSettled(fetches);
  }

  return {
    ok: false,
    status: 502,
    error: "profile_nft_image_fetch_failed",
    message: "Profile NFT image CID could not be fetched from configured IPFS gateways.",
    cid: normalizedCid,
    attempts,
  };
}

export async function handleProfileNftImageRoute({ json, req, res, url } = {}) {
  if (!url.pathname.startsWith("/api/profile/nft/image/")) return false;
  if (req.method !== "GET") {
    json(res, 405, {
      ok: false,
      error: "profile_nft_image_method_not_allowed",
      message: "Profile NFT image proxy requires GET.",
    }, { allow: "GET" });
    return true;
  }

  const cid = decodeURIComponent(url.pathname.slice("/api/profile/nft/image/".length));
  const result = await fetchProfileNftImage({ cid });
  if (!result.ok) {
    json(res, result.status || 502, result);
    return true;
  }

  res.writeHead(200, {
    "content-type": result.contentType,
    "content-length": String(result.bytes.length),
    "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    "x-content-type-options": "nosniff",
    "x-profile-nft-image-cache": result.cache || "miss",
  });
  res.end(result.bytes);
  return true;
}
