import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { validatorError } from "./validator-identity.js";

export const BUNDLE_FILE_FORMAT = "tasknode-encrypted-file-v1";
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const context = (indexId, index, filePath) => Buffer.from(JSON.stringify([
  BUNDLE_FILE_FORMAT, indexId, index.contentHash, filePath,
]));

export function validBundleFilePath(filePath) {
  return typeof filePath === "string" && filePath.length > 0 &&
    !filePath.includes("\\") && !filePath.includes("\0") &&
    filePath.split("/").every((part) => part && part !== "." && part !== "..");
}

export function encryptBundleFile(bytes, indexId, index, filePath) {
  if (!validBundleFilePath(filePath) || bytes.length > MAX_FILE_BYTES) throw new Error("bundle_file_invalid");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(index.contentKey, "base64"), iv);
  cipher.setAAD(context(indexId, index, filePath));
  const encrypted = Buffer.concat([cipher.update(gzipSync(bytes)), cipher.final()]);
  const encryptedBytes = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  return { encryptedBytes, fileHash: digest(encryptedBytes) };
}

export function decryptBundleFile(record, indexId, index, filePath) {
  const bytes = record.encryptedBytes;
  if (!Buffer.isBuffer(bytes) || bytes.length < 28 || digest(bytes) !== record.fileHash) {
    throw validatorError("bundle_integrity_failed", 503);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(index.contentKey, "base64"), bytes.subarray(0, 12));
    decipher.setAAD(context(indexId, index, filePath));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const compressed = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    return gunzipSync(compressed, { maxOutputLength: MAX_FILE_BYTES });
  } catch {
    throw validatorError("bundle_integrity_failed", 503);
  }
}

// Authorization belongs to the request handler and runs even for cached files.
// Independent files can load concurrently; duplicate reads share a promise.
export function createBundleFileLoader({ fetchFile, maxBytes = 32 * 1024 * 1024, maxEntries = 256 }) {
  const cached = new Map(), inflight = new Map();
  let cachedBytes = 0;
  function load(indexId, index, filePath) {
    if (!validBundleFilePath(filePath)) return Promise.reject(validatorError("bundle_file_not_found", 404));
    const key = JSON.stringify([indexId, index.contentHash, filePath]);
    if (cached.has(key)) {
      const bytes = cached.get(key);
      cached.delete(key);
      cached.set(key, bytes);
      return Promise.resolve(bytes);
    }
    if (inflight.has(key)) return inflight.get(key);
    const pending = Promise.resolve().then(async () => {
      const record = await fetchFile(indexId, index, filePath);
      if (!record) throw validatorError("bundle_file_not_found", 404);
      const bytes = decryptBundleFile(record, indexId, index, filePath);
      if (bytes.length <= maxBytes && maxEntries > 0) {
        while (cached.size && (cachedBytes + bytes.length > maxBytes || cached.size >= maxEntries)) {
          const oldest = cached.keys().next().value;
          cachedBytes -= cached.get(oldest).length;
          cached.delete(oldest);
        }
        cached.set(key, bytes);
        cachedBytes += bytes.length;
      }
      return bytes;
    }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }
  return { load, cached, inflight, get cachedBytes() { return cachedBytes; } };
}

export async function fetchBundleFile(queryImpl, indexId, index, filePath) {
  const row = (await queryImpl(`SELECT encrypted_bytes, file_hash FROM index_viewer_bundle_files
    WHERE index_id=$1 AND bundle_hash=$2 AND file_path=$3`, [indexId, index.contentHash, filePath])).rows[0];
  return row ? { encryptedBytes: row.encrypted_bytes, fileHash: row.file_hash } : null;
}
