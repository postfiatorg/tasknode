import { createDecipheriv, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { query } from "./db/pool.js";
import { accountMeetsTier } from "./index-viewer-routes.js";
import { getIndex } from "./repositories/index-viewer.js";
import { validatorError } from "./validator-identity.js";
import { BUNDLE_FILE_FORMAT, createBundleFileLoader, fetchBundleFile, validBundleFilePath } from "./validator-bundle-files.js";

const MAX_CACHED_BUNDLES = 2;

// One load per bundle version, and one decrypt at a time across all bundles. Without this, a newly published
// bundle (the Finance Hub is ~22 MB) was fetched from the database and decrypted once per concurrent request: the
// hub opens with many parallel file requests, so a cold cache meant dozens of simultaneous multi-megabyte bytea
// reads (exhausting the pool for every other route) and dozens of decoded copies in memory (the web process aborted
// with exit 134 on 2026-11-04 01:32 UTC, then sat on pool timeouts until 01:56).
function createVersionLoader({ loadVersion, maxCached = MAX_CACHED_BUNDLES }) {
  const files = new Map();
  const inflight = new Map();
  let gate = Promise.resolve();
  const load = (indexId, index) => {
    const hit = files.get(index.contentHash);
    if (hit) return Promise.resolve(hit);
    const pending = inflight.get(index.contentHash);
    if (pending) return pending;
    const run = gate.then(async () => {
      const again = files.get(index.contentHash);
      if (again) return again;
      const ready = await loadVersion(indexId, index);
      while (files.size >= maxCached) files.delete(files.keys().next().value);
      files.set(index.contentHash, ready);
      return ready;
    });
    gate = run.catch(() => {});
    const shared = run.finally(() => inflight.delete(index.contentHash));
    inflight.set(index.contentHash, shared);
    return shared;
  };
  return { load, cached: files, inflight };
}

export function createBundleLoader({ fetchEncrypted, decrypt, maxCached }) {
  return createVersionLoader({ maxCached, loadVersion: async (indexId, index) => {
    const encrypted = await fetchEncrypted(indexId, index);
    if (!encrypted) throw validatorError("bundle_not_found", 404);
    const decoded = decrypt(encrypted, index.contentKey, index.contentHash);
    const ready = Object.create(null);
    for (const [name, b64] of Object.entries(decoded)) ready[name] = Buffer.from(b64, "base64");
    return ready;
  } });
}

export function createEncryptedBundleLoader({ fetchEncrypted, maxCached }) {
  return createVersionLoader({ maxCached, loadVersion: async (indexId, index) => {
    const bytes = await fetchEncrypted(indexId, index);
    if (!bytes) throw validatorError("bundle_not_found", 404);
    if (createHash("sha256").update(bytes).digest("hex") !== index.contentHash) throw validatorError("bundle_integrity_failed", 503);
    return bytes;
  } });
}

// Keep each bytea response bounded. A single ~19 MB row intermittently exceeds
// the existing driver read timeout even with no concurrent readers. 1 MiB chunks
// avoid the large text-protocol frame; the version hash pins every chunk.
export async function fetchEncryptedBundle(queryImpl, indexId, index, chunkBytes = 1024 * 1024) {
  const chunks = [];
  let offset = 0, total;
  do {
    const row = (await queryImpl(`SELECT octet_length(b.encrypted_bytes) AS total_bytes,
        substring(b.encrypted_bytes from $3 for $4) AS encrypted_bytes
      FROM index_viewer_bundles b JOIN index_viewer_indices i ON i.index_id=b.index_id
      WHERE b.index_id=$1 AND i.content_hash=$2`, [indexId, index.contentHash, offset + 1, chunkBytes])).rows[0];
    if (!row) throw validatorError("bundle_not_found", 404);
    if (!Number.isInteger(row.total_bytes) || row.total_bytes < 28 || row.total_bytes > 128 * 1024 * 1024 ||
        (total !== undefined && total !== row.total_bytes)) throw validatorError("bundle_integrity_failed", 503);
    total = row.total_bytes;
    const bytes = row.encrypted_bytes;
    if (!Buffer.isBuffer(bytes) || bytes.length !== Math.min(chunkBytes, total - offset)) throw validatorError("bundle_integrity_failed", 503);
    chunks.push(bytes);
    offset += bytes.length;
  } while (offset < total);
  return Buffer.concat(chunks, total);
}

const encryptedLoader = createEncryptedBundleLoader({
  fetchEncrypted: (indexId, index) => fetchEncryptedBundle(query, indexId, index),
});
const bundleLoader = createBundleLoader({
  fetchEncrypted: (indexId, index) => encryptedLoader.load(indexId, index),
  decrypt: (bytes, key, hash) => decryptValidatorBundle(bytes, key, hash),
});
const fileLoader = createBundleFileLoader({ fetchFile: (id, index, filePath) => fetchBundleFile(query, id, index, filePath) });
const mimeTypes = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  md: "text/markdown; charset=utf-8", json: "application/json", csv: "text/csv; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", txt: "text/plain; charset=utf-8" };

export function decryptValidatorBundle(bytes, key, contentHash) {
  if (createHash("sha256").update(bytes).digest("hex") !== contentHash) throw validatorError("bundle_integrity_failed", 503);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const compressed = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  const bundle = JSON.parse(gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 }).toString("utf8"));
  if (bundle.version !== 1 || !bundle.files || typeof bundle.files !== "object") throw validatorError("bundle_invalid", 503);
  return bundle.files;
}

export function createValidatorBundleHandler({ readIndex = getIndex, meetsTier = accountMeetsTier,
  loadEncrypted = (id, index) => encryptedLoader.load(id, index),
  loadFile = (id, index, filePath) => fileLoader.load(id, index, filePath),
  loadFiles = (id, index) => bundleLoader.load(id, index), logFailure = console.warn } = {}) {
  return async function handleValidatorBundleRoute({ json, req, res, session, url }) {
    const parts = url.pathname.split("/").filter(Boolean);
    const content = parts[0] === "api" && parts[1] === "index-viewer" && parts[2] === "indices" && parts[4] === "content" && parts.length === 5;
    const viewer = parts[0] === "api" && parts[1] === "research" && parts[2] === "bundles";
    if (!content && !viewer) return false;
    try {
      if (req.method !== "GET") throw validatorError("method_not_allowed", 405);
      const indexId = decodeURIComponent(parts[3] || "");
      const index = await readIndex(indexId);
      if (!index || new Date(index.availableAt).getTime() > Date.now()) throw validatorError("bundle_not_found", 404);
      if (viewer) {
        const eligibility = await meetsTier({ accountId: session?.accountId, tier: index.tier });
        if (!eligibility.ok) throw validatorError(eligibility.reason, 403);
      }
      if (content) {
        const bytes = await loadEncrypted(indexId, index);
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "public,max-age=300", "x-content-type-options": "nosniff" });
        res.end(bytes);
        return true;
      }
      const filePath = parts.slice(4).map(decodeURIComponent).join("/") || "index.html";
      if (!validBundleFilePath(filePath)) throw validatorError("bundle_file_not_found", 404);
      let bytes;
      if (index.metadata?.fileFormat === BUNDLE_FILE_FORMAT) {
        bytes = await loadFile(indexId, index, filePath);
      } else {
        const files = await loadFiles(indexId, index);
        if (!Object.hasOwn(files, filePath)) throw validatorError("bundle_file_not_found", 404);
        bytes = files[filePath];
      }
      const type = mimeTypes[filePath.split(".").at(-1).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "private,no-store", "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://api.hyperliquid.xyz; frame-ancestors 'self'; base-uri 'self'; form-action 'none'; object-src 'none'" });
      res.end(bytes);
    } catch (error) {
      if (!error.status) logFailure("validator_bundle_load_failed", {
        route: content ? "content" : "viewer",
        reason: error.message === "Query read timeout" ? "query_read_timeout" : "load_failed",
      });
      json(res, error.status || 503, { ok: false, error: error.status ? error.message : "bundle_unavailable" }, { "cache-control": "no-store" });
    }
    return true;
  };

}

export const handleValidatorBundleRoute = createValidatorBundleHandler();
