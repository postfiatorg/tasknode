import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { isValidContextCid, normalizeContextCid } from "./context-ipfs.js";

const DEFAULT_GATEWAYS = [
  "https://pft-ipfs-testnet-clean.fly.dev/ipfs/",
  "https://w3s.link/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
];

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BYTES = 8_388_608;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_THUMBNAIL_CACHE_DIR = "/data/profile-nft-thumbnails";
const DEFAULT_THUMBNAIL_FORMAT = "webp";
const DEFAULT_THUMBNAIL_GENERATION_CONCURRENCY = 1;
const DEFAULT_THUMBNAIL_GENERATION_QUEUE_MAX = 32;
const THUMBNAIL_SIZES = [48, 96, 192];
const allowedContentTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const imageCache = new Map();
const imageFetchFlights = new Map();
const thumbnailFlights = new Map();
const thumbnailWarmKeys = new Set();
const thumbnailGenerationQueue = [];
let thumbnailGenerationActive = 0;
let imageCacheBytes = 0;

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function numericEnv(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export function profileNftImageGatewayList(env = process.env) {
  const configured = [
    env.TASKNODE_PROFILE_NFT_IMAGE_GATEWAYS,
    env.TASKNODE_IPFS_GATEWAY,
    env.TASKNODE_IPFS_GATEWAYS,
    env.IPFS_GATEWAY_FALLBACKS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...configured, ...DEFAULT_GATEWAYS, env.IPFS_GATEWAY_URL]
    .filter(Boolean)
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
  const previous = imageCache.get(cid);
  if (previous) {
    imageCacheBytes -= previous.bytes.length;
  }
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

function profileNftImageEtag(cid = "") {
  return `"${String(cid || "").trim()}"`;
}

function profileNftThumbnailEtag({ cid = "", size = 96, format = DEFAULT_THUMBNAIL_FORMAT } = {}) {
  return `"${String(cid || "").trim()}:pfp:${normalizeThumbnailSize(size)}:${normalizeThumbnailFormat(format)}"`;
}

function ifNoneMatchMatches(value = "", etag = "") {
  const normalizedEtag = String(etag || "").trim();
  if (!value || !normalizedEtag) return false;
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "*" || entry === normalizedEtag || entry === `W/${normalizedEtag}`);
}

export function normalizeThumbnailSize(value = 96) {
  const requested = numericEnv(value, 96, THUMBNAIL_SIZES[0], THUMBNAIL_SIZES[THUMBNAIL_SIZES.length - 1]);
  return THUMBNAIL_SIZES.find((size) => requested <= size) || THUMBNAIL_SIZES[THUMBNAIL_SIZES.length - 1];
}

export function normalizeThumbnailFormat(value = DEFAULT_THUMBNAIL_FORMAT) {
  const normalized = safeText(value || DEFAULT_THUMBNAIL_FORMAT, 20).toLowerCase();
  return normalized === "png" ? "png" : DEFAULT_THUMBNAIL_FORMAT;
}

function thumbnailContentType(format = DEFAULT_THUMBNAIL_FORMAT) {
  return normalizeThumbnailFormat(format) === "png" ? "image/png" : "image/webp";
}

function thumbnailSyncGenerateEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(String(env.TASKNODE_PROFILE_NFT_PFP_SYNC_GENERATE || "").toLowerCase());
}

function thumbnailCacheDir(env = process.env) {
  return safeText(env.TASKNODE_PROFILE_NFT_THUMBNAIL_CACHE_DIR || DEFAULT_THUMBNAIL_CACHE_DIR, 1000) ||
    DEFAULT_THUMBNAIL_CACHE_DIR;
}

function thumbnailCachePath({
  cid = "",
  size = 96,
  format = DEFAULT_THUMBNAIL_FORMAT,
  env = process.env,
} = {}) {
  const normalizedCid = normalizeContextCid(safeText(cid, 180));
  const normalizedSize = normalizeThumbnailSize(size);
  const normalizedFormat = normalizeThumbnailFormat(format);
  const digest = createHash("sha256")
    .update(`${normalizedCid}:${normalizedSize}:${normalizedFormat}`)
    .digest("hex")
    .slice(0, 32);
  return path.join(thumbnailCacheDir(env), `${digest}-${normalizedSize}.${normalizedFormat}`);
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

async function fetchFromGateway({ cid, gateway, fetchImpl, maxBytes, timeoutMs, controller = new AbortController() }) {
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

export function profileNftPfpProxyPath(cid = "", { size = 96, format = DEFAULT_THUMBNAIL_FORMAT } = {}) {
  const normalized = normalizeContextCid(cid);
  if (!normalized) return "";
  const normalizedSize = normalizeThumbnailSize(size);
  const normalizedFormat = normalizeThumbnailFormat(format);
  const params = new URLSearchParams({ size: String(normalizedSize) });
  if (normalizedFormat !== DEFAULT_THUMBNAIL_FORMAT) params.set("format", normalizedFormat);
  return `/api/profile/nft/pfp/${encodeURIComponent(normalized)}?${params.toString()}`;
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

  const existingFlight = imageFetchFlights.get(normalizedCid);
  if (existingFlight) return existingFlight;

  const flight = (async () => {
    const boundedTimeoutMs = numericEnv(timeoutMs ?? env.TASKNODE_PROFILE_NFT_IMAGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 60000);
    const boundedMaxBytes = numericEnv(maxBytes ?? env.TASKNODE_PROFILE_NFT_IMAGE_MAX_BYTES, DEFAULT_MAX_BYTES, 1024, 32 * 1024 * 1024);
    const gatewayList = Array.isArray(gateways) && gateways.length ? gateways : profileNftImageGatewayList(env);
    const attempts = [];

    const gatewayAttempts = gatewayList.map((gateway) => {
      const controller = new AbortController();
      const fetchPromise = (async () => {
        try {
          return await fetchFromGateway({
            cid: normalizedCid,
            gateway,
            fetchImpl,
            maxBytes: boundedMaxBytes,
            timeoutMs: boundedTimeoutMs,
            controller,
          });
        } catch (error) {
          attempts.push({
            gateway: safeText(gateway, 160),
            error: safeText(error?.message || "profile_nft_image_gateway_failed", 120),
          });
          throw error;
        }
      })();
      return { controller, fetchPromise };
    });
    const fetches = gatewayAttempts.map(({ fetchPromise }) => fetchPromise);

    try {
      const result = await Promise.any(fetches);
      for (const { controller } of gatewayAttempts) {
        if (!controller.signal.aborted) controller.abort();
      }
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
  })();

  imageFetchFlights.set(normalizedCid, flight);
  try {
    return await flight;
  } finally {
    if (imageFetchFlights.get(normalizedCid) === flight) {
      imageFetchFlights.delete(normalizedCid);
    }
  }
}

async function readThumbnailFromDisk({ cid, size, format, env = process.env } = {}) {
  try {
    const bytes = await readFile(thumbnailCachePath({ cid, size, format, env }));
    return {
      ok: true,
      cid,
      size,
      format,
      bytes,
      contentType: thumbnailContentType(format),
      cache: "disk",
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeThumbnailToDisk({ cid, size, format, bytes, env = process.env } = {}) {
  const cacheDir = thumbnailCacheDir(env);
  await mkdir(cacheDir, { recursive: true });
  const target = thumbnailCachePath({ cid, size, format, env });
  const temp = path.join(cacheDir, `.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(temp, bytes);
  await rename(temp, target);
}

async function resizeProfileNftThumbnail({ sourceBytes, size, format }) {
  const pipeline = sharp(sourceBytes, {
    animated: false,
    failOn: "none",
    limitInputPixels: 64_000_000,
  })
    .rotate()
    .resize(size, size, { fit: "cover", position: "centre" });
  const normalizedFormat = normalizeThumbnailFormat(format);
  return normalizedFormat === "png"
    ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    : pipeline.webp({ quality: 74, effort: 4 }).toBuffer();
}

async function withThumbnailGenerationSlot(env, task) {
  const maxActive = numericEnv(
    env.TASKNODE_PROFILE_NFT_THUMBNAIL_GENERATION_CONCURRENCY,
    DEFAULT_THUMBNAIL_GENERATION_CONCURRENCY,
    1,
    4
  );
  const maxQueued = numericEnv(
    env.TASKNODE_PROFILE_NFT_THUMBNAIL_GENERATION_QUEUE_MAX,
    DEFAULT_THUMBNAIL_GENERATION_QUEUE_MAX,
    0,
    1000
  );

  if (thumbnailGenerationActive >= maxActive) {
    if (thumbnailGenerationQueue.length >= maxQueued) {
      return {
        ok: false,
        status: 429,
        error: "profile_nft_pfp_generation_busy",
        message: "Profile NFT thumbnail generation is busy.",
      };
    }
    await new Promise((resolve) => thumbnailGenerationQueue.push(resolve));
  }

  thumbnailGenerationActive += 1;
  try {
    return await task();
  } finally {
    thumbnailGenerationActive = Math.max(0, thumbnailGenerationActive - 1);
    const next = thumbnailGenerationQueue.shift();
    if (next) next();
  }
}

export async function fetchProfileNftPfpThumbnail({
  cid = "",
  size = 96,
  format = DEFAULT_THUMBNAIL_FORMAT,
  env = process.env,
  fetchImage = fetchProfileNftImage,
} = {}) {
  const normalizedCid = normalizeContextCid(safeText(cid, 180));
  if (!isValidContextCid(normalizedCid)) {
    return {
      ok: false,
      status: 400,
      error: "profile_nft_pfp_cid_invalid",
      message: "Profile NFT PFP image CID is not valid.",
      cid: normalizedCid,
    };
  }

  const normalizedSize = normalizeThumbnailSize(size);
  const normalizedFormat = normalizeThumbnailFormat(format);
  const flightKey = `${normalizedCid}:${normalizedSize}:${normalizedFormat}`;
  const cached = await readThumbnailFromDisk({
    cid: normalizedCid,
    size: normalizedSize,
    format: normalizedFormat,
    env,
  });
  if (cached) return cached;

  const existingFlight = thumbnailFlights.get(flightKey);
  if (existingFlight) return existingFlight;

  const flight = (async () => {
    return await withThumbnailGenerationSlot(env, async () => {
      const source = await fetchImage({ cid: normalizedCid, env });
      if (!source.ok) {
        return {
          ok: false,
          status: source.status || 502,
          error: source.error || "profile_nft_pfp_source_fetch_failed",
          message: source.message || "Profile NFT source image could not be fetched.",
          cid: normalizedCid,
        };
      }
      const bytes = await resizeProfileNftThumbnail({
        sourceBytes: source.bytes,
        size: normalizedSize,
        format: normalizedFormat,
      });
      await writeThumbnailToDisk({
        cid: normalizedCid,
        size: normalizedSize,
        format: normalizedFormat,
        bytes,
        env,
      });
      return {
        ok: true,
        cid: normalizedCid,
        size: normalizedSize,
        format: normalizedFormat,
        bytes,
        contentType: thumbnailContentType(normalizedFormat),
        cache: "miss",
        sourceCache: source.cache || "",
        sourceBytes: source.bytes.length,
      };
    });
  })();

  thumbnailFlights.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    if (thumbnailFlights.get(flightKey) === flight) {
      thumbnailFlights.delete(flightKey);
    }
  }
}

function profileNftPfpPlaceholder({ cid = "", size = 96 } = {}) {
  const normalizedSize = normalizeThumbnailSize(size);
  const hue = createHash("sha256").update(String(cid || "profile-nft")).digest()[0] % 360;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${normalizedSize}" height="${normalizedSize}" viewBox="0 0 ${normalizedSize} ${normalizedSize}" role="img" aria-label="Profile NFT thumbnail warming">`,
    `<rect width="${normalizedSize}" height="${normalizedSize}" rx="${Math.max(4, Math.floor(normalizedSize / 6))}" fill="hsl(${hue} 22% 88%)"/>`,
    `<circle cx="${normalizedSize / 2}" cy="${normalizedSize / 2}" r="${Math.floor(normalizedSize * 0.28)}" fill="hsl(${hue} 24% 64%)"/>`,
    "</svg>",
  ].join("");
  return Buffer.from(svg);
}

function sendProfileNftPfpResult({ res, result, cacheHeaders }) {
  res.writeHead(200, {
    "content-type": result.contentType,
    "content-length": String(result.bytes.length),
    ...cacheHeaders,
    "x-profile-nft-thumbnail-cache": result.cache || "miss",
    "x-profile-nft-thumbnail-source-cache": result.sourceCache || "",
    "x-profile-nft-thumbnail-source-bytes": result.sourceBytes ? String(result.sourceBytes) : "",
  });
  res.end(result.bytes);
}

function sendProfileNftPfpWarming({ res, cid, size, format }) {
  const bytes = profileNftPfpPlaceholder({ cid, size });
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "x-profile-nft-thumbnail-size": String(size),
    "x-profile-nft-thumbnail-format": format,
    "x-profile-nft-thumbnail-cache": "warming",
    "retry-after": "5",
  });
  res.end(bytes);
}

function scheduleProfileNftPfpWarm({
  cid,
  size,
  format,
  env = process.env,
  fetchThumbnail = fetchProfileNftPfpThumbnail,
} = {}) {
  const key = `${cid}:${size}:${format}`;
  if (thumbnailWarmKeys.has(key)) return;
  thumbnailWarmKeys.add(key);
  void fetchThumbnail({ cid, size, format, env })
    .catch((error) => {
      console.warn("[profile-nft-pfp] async thumbnail warm failed", {
        cid: safeText(cid, 120),
        size,
        error: safeText(error?.message || "thumbnail_warm_failed", 120),
      });
    })
    .finally(() => {
      thumbnailWarmKeys.delete(key);
    });
}

export async function handleProfileNftImageRoute({ json, req, res, url, fetchImage = fetchProfileNftImage } = {}) {
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
  const normalizedCid = normalizeContextCid(safeText(cid, 180));
  const etag = profileNftImageEtag(normalizedCid);
  const cacheHeaders = {
    "cache-control": "public, max-age=31536000, immutable",
    etag,
    "x-content-type-options": "nosniff",
  };
  if (isValidContextCid(normalizedCid) && ifNoneMatchMatches(req.headers?.["if-none-match"], etag)) {
    res.writeHead(304, cacheHeaders);
    res.end();
    return true;
  }

  const result = await fetchImage({ cid: normalizedCid || cid });
  if (!result.ok) {
    json(res, result.status || 502, result);
    return true;
  }

  res.writeHead(200, {
    "content-type": result.contentType,
    "content-length": String(result.bytes.length),
    ...cacheHeaders,
    "x-profile-nft-image-cache": result.cache || "miss",
  });
  res.end(result.bytes);
  return true;
}

export async function handleProfileNftPfpRoute({
  json,
  req,
  res,
  url,
  env = process.env,
  fetchThumbnail = fetchProfileNftPfpThumbnail,
} = {}) {
  if (!url.pathname.startsWith("/api/profile/nft/pfp/")) return false;
  if (req.method !== "GET") {
    json(res, 405, {
      ok: false,
      error: "profile_nft_pfp_method_not_allowed",
      message: "Profile NFT PFP thumbnail proxy requires GET.",
    }, { allow: "GET" });
    return true;
  }

  const cid = decodeURIComponent(url.pathname.slice("/api/profile/nft/pfp/".length));
  const normalizedCid = normalizeContextCid(safeText(cid, 180));
  const size = normalizeThumbnailSize(url.searchParams.get("size") || url.searchParams.get("w") || 96);
  const format = normalizeThumbnailFormat(url.searchParams.get("format") || DEFAULT_THUMBNAIL_FORMAT);
  if (!isValidContextCid(normalizedCid)) {
    json(res, 400, {
      ok: false,
      error: "profile_nft_pfp_cid_invalid",
      message: "Profile NFT PFP image CID is not valid.",
      cid: normalizedCid,
    });
    return true;
  }

  const etag = profileNftThumbnailEtag({ cid: normalizedCid, size, format });
  const cacheHeaders = {
    "cache-control": "public, max-age=31536000, immutable",
    etag,
    "x-content-type-options": "nosniff",
    "x-profile-nft-thumbnail-size": String(size),
    "x-profile-nft-thumbnail-format": format,
  };
  if (isValidContextCid(normalizedCid) && ifNoneMatchMatches(req.headers?.["if-none-match"], etag)) {
    res.writeHead(304, cacheHeaders);
    res.end();
    return true;
  }

  const cached = await readThumbnailFromDisk({ cid: normalizedCid, size, format, env });
  if (cached) {
    sendProfileNftPfpResult({ res, result: cached, cacheHeaders });
    return true;
  }

  if (url.searchParams.get("cachedOnly") === "1") {
    json(res, 404, {
      ok: false,
      error: "profile_nft_pfp_cached_thumbnail_missing",
      message: "No cached thumbnail exists for this CID and size.",
      cid: normalizedCid,
      size,
    }, { "cache-control": "no-store, max-age=0" });
    return true;
  }

  if (!thumbnailSyncGenerateEnabled(env)) {
    scheduleProfileNftPfpWarm({ cid: normalizedCid, size, format, env, fetchThumbnail });
    sendProfileNftPfpWarming({ res, cid: normalizedCid, size, format });
    return true;
  }

  const result = await fetchThumbnail({ cid: normalizedCid, size, format, env });
  if (!result.ok) {
    json(res, result.status || 502, result);
    return true;
  }

  sendProfileNftPfpResult({ res, result, cacheHeaders });
  return true;
}
