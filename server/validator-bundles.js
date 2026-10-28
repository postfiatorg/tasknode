import { createDecipheriv, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { query } from "./db/pool.js";
import { accountMeetsTier } from "./index-viewer-routes.js";
import { getIndex } from "./repositories/index-viewer.js";
import { validatorError } from "./validator-identity.js";

const cache = new Map();
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

export async function handleValidatorBundleRoute({ json, req, res, session, url }) {
  const parts = url.pathname.split("/").filter(Boolean);
  const content = parts[0] === "api" && parts[1] === "index-viewer" && parts[2] === "indices" && parts[4] === "content" && parts.length === 5;
  const viewer = parts[0] === "api" && parts[1] === "research" && parts[2] === "bundles";
  if (!content && !viewer) return false;
  try {
    if (req.method !== "GET") throw validatorError("method_not_allowed", 405);
    const indexId = decodeURIComponent(parts[3] || "");
    const index = await getIndex(indexId);
    if (!index || new Date(index.availableAt).getTime() > Date.now()) throw validatorError("bundle_not_found", 404);
    if (viewer) {
      const eligibility = await accountMeetsTier({ accountId: session?.accountId, tier: index.tier });
      if (!eligibility.ok) throw validatorError(eligibility.reason, 403);
    }
    let files = cache.get(index.contentHash);
    if (content || !files) {
      const bundle = (await query(`SELECT encrypted_bytes FROM index_viewer_bundles WHERE index_id=$1`, [indexId])).rows[0];
      if (!bundle) throw validatorError("bundle_not_found", 404);
      if (content) {
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "public,max-age=300", "x-content-type-options": "nosniff" });
        res.end(bundle.encrypted_bytes);
        return true;
      }
      files = decryptValidatorBundle(bundle.encrypted_bytes, index.contentKey, index.contentHash);
      if (cache.size >= 2) cache.delete(cache.keys().next().value);
      cache.set(index.contentHash, files);
    }
    const filePath = parts.slice(4).map(decodeURIComponent).join("/") || "index.html";
    if (filePath.split("/").some((part) => part === "." || part === ".." || part.includes("\\")) || !Object.hasOwn(files, filePath)) throw validatorError("bundle_file_not_found", 404);
    const type = mimeTypes[filePath.split(".").at(-1).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "private,no-store", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'none'; object-src 'none'" });
    res.end(Buffer.from(files[filePath], "base64"));
  } catch (error) { json(res, error.status || 503, { ok: false, error: error.status ? error.message : "bundle_unavailable" }, { "cache-control": "no-store" }); }
  return true;
}
