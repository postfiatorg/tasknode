import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import { databaseEnabled, transaction } from "./db/pool.js";
import { upsertIndex } from "./repositories/index-viewer.js";
import { BUNDLE_FILE_FORMAT, decryptBundleFile, encryptBundleFile, fetchBundleFile, validBundleFilePath } from "./validator-bundle-files.js";
import { LIBRARY_MANIFEST_PATH, TODAY_MANIFEST_PATH, libraryRestrictionsFromFiles } from "./finance-hub-library.js";

export const PUBLISH_SCHEMA_VERSION = "finance-hub.publish-payload.v1";
export const PUBLISH_SIGNING_INPUT_VERSION = "canonical-json-v1";
export const PUBLISH_MAX_TOTAL_BYTES = 67_108_864; // 64 MiB
export const PUBLISH_MAX_FILES = 5_000;
export const PUBLISH_MAX_CLOCK_SKEW_MS = 300_000; // ±300s
export const PUBLISH_MAX_TTL_MS = 600_000; // 600s
export const PUBLISH_NONCE_RETENTION_SECONDS = 900; // skew + ttl

const ALLOWED_INDICES = new Set(["ga-models", "goodbrief", "finance-hub-public"]);
const ALLOWED_GATED_BASES = new Set(["validator", "top30", "grace"]);
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;
const NONCE_RE = /^[A-Za-z0-9_-]{24,128}$/;
const KEY_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SIG_VALUE_RE = /^[A-Za-z0-9+/=_-]{64,256}$/;
const SAFE_FILE_PATH_RE = /^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "price_target", "target_price", "upside", "upside_pct", "downside_pct", "fair_value", "dcf_value",
  "model_estimate", "model_estimate_before", "market_consensus_before", "eps_estimate", "revenue_estimate",
  "bull_case_target", "bear_case_target", "base_case_target", "member_questions", "open_model_questions",
  "pooled_claims", "contributor_claims", "content_key", "api_key", "secret", "private_key", "mnemonic",
  "deep_memory", "agent_brief_members",
]);

const FORBIDDEN_PUBLIC_PATTERNS = [
  { name: "price_target_phrase", re: /\b(?:price\s+target|target\s+price)\b/i },
  { name: "pt_dollar_shorthand", re: /\bPT\s*(?:of|:|=)?\s*\$\s*\d/i },
  { name: "upside_downside_pct", re: /\b(?:upside|downside)\s+(?:of\s+)?[+-]?\d+(?:\.\d+)?%/i },
  { name: "proprietary_model_projection", re: /\bour\s+model\s+(?:projects|estimates|forecasts|targets)\b/i },
  { name: "gated_index_reference", re: /\b(?:ga-models|agent_brief_members)\b/i },
  { name: "private_key_pem", re: /BEGIN\s+[A-Z ]*PRIVATE KEY/ },
  { name: "openai_or_stripe_key", re: /\bsk-(?:live|test|proj)?-?[A-Za-z0-9]{16,}\b/ },
  { name: "github_pat", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "raw_html_or_js_uri", re: /<(?:script|iframe|img|svg|object)\b|onerror\s*=|javascript:/i },
];

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function scanForPublicLeaks(value, pointer = "$") {
  const leaks = [];
  if (typeof value === "string") {
    for (const rule of FORBIDDEN_PUBLIC_PATTERNS) {
      if (rule.re.test(value)) leaks.push(`${pointer}: matched ${rule.name}`);
    }
    return leaks;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => leaks.push(...scanForPublicLeaks(item, `${pointer}[${index}]`)));
    return leaks;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase())) leaks.push(`${pointer}.${key}: forbidden key`);
      leaks.push(...scanForPublicLeaks(entry, `${pointer}.${key}`));
    }
  }
  return leaks;
}

export function buildPublishSigningMessage(payload) {
  const normalizedFiles = [...(payload.files || [])]
    .map(({ content_base64: _ignored, ...rest }) => rest)
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifestSha256 = sha256Hex(canonicalJson(normalizedFiles));
  const envelopeWithoutSig = { ...payload, manifest_sha256: manifestSha256, files: normalizedFiles };
  delete envelopeWithoutSig.signature;
  const payloadSha256 = sha256Hex(canonicalJson(envelopeWithoutSig));
  const message = [
    "postfiat.finance-hub.publish.v1",
    payload.index_id,
    String(payload.version),
    payload.nonce,
    payloadSha256,
  ].join("\n");
  return { manifestSha256, payloadSha256, message };
}

export function signPublishPayload(unsignedPayload, { algorithm, keyId, privateKey, hmacSecret }) {
  const { manifestSha256, payloadSha256, message } = buildPublishSigningMessage(unsignedPayload);
  const value = algorithm === "ed25519"
    ? cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url")
    : createHmac("sha256", hmacSecret).update(message, "utf8").digest("hex");
  return {
    ...unsignedPayload,
    manifest_sha256: manifestSha256,
    signature: {
      algorithm,
      key_id: keyId,
      signing_input_version: PUBLISH_SIGNING_INPUT_VERSION,
      payload_sha256: payloadSha256,
      value,
    },
  };
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "schema_version", "index_id", "tier", "allowed_bases", "version", "operation",
  "rollback_target_version", "rollback_of_manifest_sha256", "issued_at", "expires_at",
  "nonce", "title", "summary", "manifest_sha256", "total_bytes", "files", "render_gate", "signature",
]);
const ALLOWED_FILE_KEYS = new Set(["path", "sha256", "size_bytes", "content_type", "encoding", "content_base64"]);
const ALLOWED_RENDER_GATE_KEYS = new Set(["passed", "shrink_guard_passed", "public_leak_scan_passed", "file_count"]);
const ALLOWED_SIG_KEYS = new Set(["algorithm", "key_id", "signing_input_version", "payload_sha256", "value"]);

export function validatePublishPayloadShape(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ["payload must be an object"];
  }
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) errors.push(`unexpected property: ${key}`);
  }
  if (payload.schema_version !== PUBLISH_SCHEMA_VERSION) errors.push("schema_version mismatch");
  if (!ALLOWED_INDICES.has(payload.index_id)) errors.push("invalid index_id");
  if (!Number.isInteger(payload.version) || payload.version < 1) errors.push("version must be integer >= 1");
  if (!["publish", "rollback"].includes(payload.operation)) errors.push("invalid operation");
  if (typeof payload.issued_at !== "string" || !ISO_UTC.test(payload.issued_at) || !Number.isFinite(Date.parse(payload.issued_at))) {
    errors.push("invalid issued_at");
  }
  if (typeof payload.expires_at !== "string" || !ISO_UTC.test(payload.expires_at) || !Number.isFinite(Date.parse(payload.expires_at))) {
    errors.push("invalid expires_at");
  }
  if (typeof payload.nonce !== "string" || !NONCE_RE.test(payload.nonce)) errors.push("invalid nonce");
  if (typeof payload.title !== "string" || payload.title.length < 1 || payload.title.length > 160) errors.push("invalid title");
  if (payload.summary !== undefined && (typeof payload.summary !== "string" || payload.summary.length > 500)) errors.push("invalid summary");
  if (typeof payload.manifest_sha256 !== "string" || !HEX64.test(payload.manifest_sha256)) errors.push("invalid manifest_sha256");
  if (!Number.isInteger(payload.total_bytes) || payload.total_bytes < 1 || payload.total_bytes > PUBLISH_MAX_TOTAL_BYTES) {
    errors.push("invalid total_bytes");
  }

  // Index <-> tier & allowed_bases isolation.
  const bases = Array.isArray(payload.allowed_bases) ? payload.allowed_bases : null;
  if (!bases || bases.length < 1 || bases.length > 4 || new Set(bases).size !== bases.length) {
    errors.push("invalid allowed_bases");
  } else if (payload.index_id === "finance-hub-public") {
    if (payload.tier !== "public_safe") errors.push("finance-hub-public requires tier public_safe");
    if (!bases.every((base) => base === "public")) errors.push("finance-hub-public allows only public basis");
  } else if (ALLOWED_INDICES.has(payload.index_id)) {
    if (!["finance_hub", "validator"].includes(payload.tier)) errors.push("gated index requires finance_hub or validator tier");
    if (!bases.every((base) => ALLOWED_GATED_BASES.has(base))) errors.push("gated index cannot include public basis");
  }

  // Rollback fields.
  if (payload.operation === "rollback") {
    if (!Number.isInteger(payload.rollback_target_version) || payload.rollback_target_version < 1) {
      errors.push("rollback_target_version required");
    }
    if (typeof payload.rollback_of_manifest_sha256 !== "string" || !HEX64.test(payload.rollback_of_manifest_sha256)) {
      errors.push("rollback_of_manifest_sha256 required");
    }
  }

  // Render gate.
  const gate = payload.render_gate;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    errors.push("render_gate required");
  } else {
    for (const key of Object.keys(gate)) {
      if (!ALLOWED_RENDER_GATE_KEYS.has(key)) errors.push(`unexpected render_gate.${key}`);
    }
    if (gate.passed !== true) errors.push("render_gate.passed must be true");
    if (gate.shrink_guard_passed !== true) errors.push("render_gate.shrink_guard_passed must be true");
    if (typeof gate.public_leak_scan_passed !== "boolean") errors.push("render_gate.public_leak_scan_passed must be boolean");
    if (payload.index_id === "finance-hub-public" && gate.public_leak_scan_passed !== true) {
      errors.push("finance-hub-public requires public_leak_scan_passed=true");
    }
    if (!Number.isInteger(gate.file_count) || gate.file_count < 1 || gate.file_count > PUBLISH_MAX_FILES) {
      errors.push("invalid render_gate.file_count");
    }
  }

  // Signature block.
  const sig = payload.signature;
  if (!sig || typeof sig !== "object" || Array.isArray(sig)) {
    errors.push("signature required");
  } else {
    for (const key of Object.keys(sig)) {
      if (!ALLOWED_SIG_KEYS.has(key)) errors.push(`unexpected signature.${key}`);
    }
    if (!["ed25519", "hmac-sha256"].includes(sig.algorithm)) errors.push("invalid signature.algorithm");
    if (typeof sig.key_id !== "string" || !KEY_ID_RE.test(sig.key_id)) errors.push("invalid signature.key_id");
    if (sig.signing_input_version !== PUBLISH_SIGNING_INPUT_VERSION) errors.push("invalid signing_input_version");
    if (typeof sig.payload_sha256 !== "string" || !HEX64.test(sig.payload_sha256)) errors.push("invalid payload_sha256");
    if (typeof sig.value !== "string" || !SIG_VALUE_RE.test(sig.value)) errors.push("invalid signature.value");
  }

  // Files array.
  if (!Array.isArray(payload.files) || payload.files.length < 1 || payload.files.length > PUBLISH_MAX_FILES) {
    errors.push("files must contain 1..5000 entries");
  } else {
    const seenPaths = new Set();
    for (let i = 0; i < payload.files.length; i += 1) {
      const file = payload.files[i];
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        errors.push(`files[${i}] must be object`);
        continue;
      }
      for (const key of Object.keys(file)) {
        if (!ALLOWED_FILE_KEYS.has(key)) errors.push(`unexpected files[${i}].${key}`);
      }
      if (typeof file.path !== "string" || !SAFE_FILE_PATH_RE.test(file.path) || !validBundleFilePath(file.path) || file.path.split("/").some((seg) => seg.startsWith("."))) {
        errors.push(`invalid files[${i}].path`);
      } else if (seenPaths.has(file.path)) {
        errors.push(`duplicate file path ${file.path}`);
      } else {
        seenPaths.add(file.path);
      }
      if (typeof file.sha256 !== "string" || !HEX64.test(file.sha256)) errors.push(`invalid files[${i}].sha256`);
      if (!Number.isInteger(file.size_bytes) || file.size_bytes < 0 || file.size_bytes > PUBLISH_MAX_TOTAL_BYTES) {
        errors.push(`invalid files[${i}].size_bytes`);
      }
      if (typeof file.content_type !== "string" || file.content_type.length < 1 || file.content_type.length > 120) {
        errors.push(`invalid files[${i}].content_type`);
      }
      if (!["identity", "gzip"].includes(file.encoding)) errors.push(`invalid files[${i}].encoding`);
      if (file.content_base64 !== undefined && (typeof file.content_base64 !== "string" || !/^[A-Za-z0-9+/=]*$/.test(file.content_base64))) {
        errors.push(`invalid files[${i}].content_base64`);
      }
    }
  }
  return errors;
}

/**
 * Parses `FINANCE_HUB_PUBLISH_KEYS_JSON` supporting 2-key rotation per index.
 * Format: `{ "ga-models": [{ key_id, algorithm, public_key_pem | hmac_secret_hex | hmac_secret }] }`
 */
export function parsePublishKeyRingFromEnv(env = process.env) {
  const ring = new Map();
  const raw = String(env.FINANCE_HUB_PUBLISH_KEYS_JSON || "").trim();
  if (!raw) return ring;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ring;
  }
  for (const [indexId, entries] of Object.entries(parsed || {})) {
    if (!ALLOWED_INDICES.has(indexId) || !Array.isArray(entries)) continue;
    for (const entry of entries.slice(0, 2)) {
      if (!entry?.key_id || !["ed25519", "hmac-sha256"].includes(entry.algorithm)) continue;
      if (entry.algorithm === "ed25519" && entry.public_key_pem) {
        ring.set(`${indexId}:${entry.key_id}`, {
          algorithm: "ed25519",
          publicKey: createPublicKey(entry.public_key_pem),
        });
      } else if (entry.algorithm === "hmac-sha256" && (entry.hmac_secret_hex || entry.hmac_secret)) {
        const secret = entry.hmac_secret_hex
          ? Buffer.from(entry.hmac_secret_hex, "hex")
          : Buffer.from(String(entry.hmac_secret), "utf8");
        ring.set(`${indexId}:${entry.key_id}`, { algorithm: "hmac-sha256", hmacSecret: secret });
      }
    }
  }
  return ring;
}

function verifyHmacSignature(secret, message, providedValue) {
  const expectedHex = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const expectedHexBuf = Buffer.from(expectedHex, "utf8");
  const providedBuf = Buffer.from(String(providedValue || ""), "utf8");
  if (providedBuf.length === expectedHexBuf.length && timingSafeEqual(expectedHexBuf, providedBuf)) {
    return true;
  }
  const expectedB64 = createHmac("sha256", secret).update(message, "utf8").digest("base64");
  const expectedB64Buf = Buffer.from(expectedB64, "utf8");
  return providedBuf.length === expectedB64Buf.length && timingSafeEqual(expectedB64Buf, providedBuf);
}

function verifyEd25519Signature(publicKey, message, providedValue) {
  const messageBuf = Buffer.from(message, "utf8");
  for (const encoding of ["base64url", "base64"]) {
    try {
      const sigBuf = Buffer.from(providedValue, encoding);
      if (sigBuf.length === 64 && cryptoVerify(null, messageBuf, publicKey, sigBuf)) return true;
    } catch {
      // try next encoding
    }
  }
  return false;
}

export async function verifySignedPublishRequest(payload, {
  keyRing = new Map(),
  currentVersion = 0,
  hasSeenNonce = async () => false,
  hasHistoricalManifest = async () => null,
  nowMs = Date.now(),
} = {}) {
  const shapeErrors = validatePublishPayloadShape(payload);
  if (shapeErrors.length) {
    return { ok: false, status: 400, error: "schema_invalid", details: shapeErrors };
  }

  // 1. Key lookup scoped strictly to `index_id` (prevents cross-index key reuse).
  const keyEntry = keyRing.get(`${payload.index_id}:${payload.signature.key_id}`);
  if (!keyEntry || keyEntry.algorithm !== payload.signature.algorithm) {
    return { ok: false, status: 401, error: "unknown_or_mismatched_key" };
  }

  // 2. Cryptographic digest & signature check BEFORE state mutations.
  const { manifestSha256, payloadSha256, message } = buildPublishSigningMessage(payload);
  if (payload.manifest_sha256 !== manifestSha256 || payload.signature.payload_sha256 !== payloadSha256) {
    return { ok: false, status: 401, error: "digest_mismatch" };
  }
  const sigValid = keyEntry.algorithm === "ed25519"
    ? verifyEd25519Signature(keyEntry.publicKey, message, payload.signature.value)
    : verifyHmacSignature(keyEntry.hmacSecret, message, payload.signature.value);
  if (!sigValid) {
    return { ok: false, status: 401, error: "signature_invalid" };
  }

  // 3. Timestamp freshness & TTL replay window (±300s skew, <= 600s TTL, unexpired).
  const issuedMs = Date.parse(payload.issued_at);
  const expiresMs = Date.parse(payload.expires_at);
  if (Math.abs(nowMs - issuedMs) > PUBLISH_MAX_CLOCK_SKEW_MS) {
    return { ok: false, status: 401, error: "issued_at_out_of_window" };
  }
  if (expiresMs <= issuedMs || expiresMs - issuedMs > PUBLISH_MAX_TTL_MS || nowMs > expiresMs) {
    return { ok: false, status: 401, error: "envelope_expired_or_invalid_ttl" };
  }

  // 4. Single-use nonce & strict monotonic version.
  if (payload.version <= currentVersion) {
    return { ok: false, status: 409, error: "version_not_monotonic" };
  }
  if (await hasSeenNonce(payload.index_id, payload.nonce)) {
    return { ok: false, status: 409, error: "nonce_replayed" };
  }

  // 5. File count, total bytes, per-file SHA-256, rollback manifest & public anti-leak checks.
  if (payload.render_gate.file_count !== payload.files.length) {
    return { ok: false, status: 400, error: "file_count_mismatch" };
  }

  if (payload.operation === "rollback") {
    if (payload.rollback_target_version >= payload.version) {
      return { ok: false, status: 400, error: "rollback_target_not_older" };
    }
    const historical = await hasHistoricalManifest(payload.index_id, payload.rollback_of_manifest_sha256);
    if (!historical) {
      return { ok: false, status: 404, error: "rollback_manifest_not_found" };
    }
    return {
      ok: true,
      status: 200,
      manifestSha256,
      payloadSha256,
      decodedFiles: null,
      historicalManifest: historical,
    };
  }

  let computedTotal = 0;
  const decodedFiles = [];
  for (const file of payload.files) {
    if (typeof file.content_base64 !== "string") {
      return { ok: false, status: 400, error: "file_content_required", details: [file.path] };
    }
    const bytes = Buffer.from(file.content_base64, "base64");
    if (bytes.length !== file.size_bytes) {
      return { ok: false, status: 400, error: "file_size_mismatch", details: [file.path] };
    }
    if (sha256Hex(bytes) !== file.sha256) {
      return { ok: false, status: 400, error: "file_hash_mismatch", details: [file.path] };
    }
    computedTotal += bytes.length;
    if (computedTotal > PUBLISH_MAX_TOTAL_BYTES) {
      return { ok: false, status: 413, error: "bundle_exceeds_64_mib" };
    }

    // Strict server-side leak scan on every file published to `finance-hub-public`.
    if (payload.index_id === "finance-hub-public") {
      const text = bytes.toString("utf8");
      let scanTarget = text;
      if (file.path.endsWith(".json") || file.content_type.includes("json")) {
        try {
          scanTarget = JSON.parse(text);
        } catch {
          return { ok: false, status: 400, error: "invalid_public_json", details: [file.path] };
        }
      }
      const leaks = scanForPublicLeaks(scanTarget, file.path);
      if (leaks.length) {
        return { ok: false, status: 403, error: "public_leak_detected", details: leaks.slice(0, 10) };
      }
    }

    decodedFiles.push({ path: file.path, bytes, sha256: file.sha256, contentType: file.content_type });
  }

  if (computedTotal !== payload.total_bytes) {
    return { ok: false, status: 400, error: "total_bytes_mismatch" };
  }
  try {
    libraryRestrictionsFromFiles(decodedFiles, payload.index_id);
  } catch {
    return { ok: false, status: 400, error: "library_manifest_invalid" };
  }

  return { ok: true, status: 200, manifestSha256, payloadSha256, decodedFiles, historicalManifest: null };
}

async function readRetainedManifests(client, indexId, bundle) {
  const files = [];
  for (const filePath of [LIBRARY_MANIFEST_PATH, TODAY_MANIFEST_PATH]) {
    const record = await fetchBundleFile((text, params) => client.query(text, params), indexId, bundle, filePath);
    if (record) files.push({ path: filePath, bytes: decryptBundleFile(record, indexId, bundle, filePath) });
  }
  return files;
}

export function createPostgresPublishStore() {
  return {
    async withIndexLock(indexId, work) {
      if (!databaseEnabled()) throw Object.assign(new Error("database_unavailable"), { status: 503 });
      return transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`finance-hub-publish:${indexId}`]);
        const versionRes = await client.query(
          "SELECT COALESCE(MAX(version), 0)::integer AS current_version FROM finance_hub_publish_manifests WHERE index_id = $1",
          [indexId]
        );
        const currentVersion = versionRes.rows[0]?.current_version || 0;
        return work({
          currentVersion,
          hasSeenNonce: async (id, nonce) => {
            const hit = await client.query(
              "SELECT 1 FROM finance_hub_publish_nonces WHERE index_id = $1 AND nonce = $2 AND expires_at > now() LIMIT 1",
              [id, nonce]
            );
            return hit.rowCount > 0;
          },
          hasHistoricalManifest: async (id, manifestSha256) => {
            const hit = await client.query(
              `SELECT version, manifest_sha256, bundle_hash, file_count, total_bytes
                 FROM finance_hub_publish_manifests
                WHERE index_id = $1 AND manifest_sha256 = $2
                ORDER BY version DESC LIMIT 1`,
              [id, manifestSha256]
            );
            return hit.rows[0] || null;
          },
          commitPublish: async ({ payload, manifestSha256, decodedFiles, historicalManifest }) => {
            const existingIndex = (await client.query(
              "SELECT content_key, content_hash FROM index_viewer_indices WHERE index_id = $1 LIMIT 1",
              [payload.index_id]
            )).rows[0] || null;
            const contentKey = existingIndex?.content_key || randomBytes(32).toString("base64");
            const bundleHash = payload.operation === "rollback"
              ? historicalManifest.bundle_hash
              : sha256Hex(`${payload.index_id}:${payload.version}:${manifestSha256}`);
            // A rollback restores the historical bundle's own Library restrictions.
            const restrictionFiles = payload.operation === "rollback"
              ? await readRetainedManifests(client, payload.index_id, { contentHash: bundleHash, contentKey })
              : decodedFiles || [];

            await upsertIndex({
              indexId: payload.index_id,
              title: payload.title,
              summary: payload.summary || "",
              tier: payload.tier,
              contentKey,
              contentHash: bundleHash,
              contentUrl: "",
              metadata: {
                format: "tasknode-signed-publish-v1",
                fileFormat: BUNDLE_FILE_FORMAT,
                wholeBundleDisabled: payload.index_id !== "finance-hub-public",
                allowedBases: payload.allowed_bases,
                libraryRestrictions: libraryRestrictionsFromFiles(restrictionFiles, payload.index_id),
                version: payload.version,
                operation: payload.operation,
                manifestSha256,
                viewerUrl: `/api/research/bundles/${payload.index_id}/index.html`,
              },
            }, { client });

            if (payload.operation === "publish" && decodedFiles) {
              for (const file of decodedFiles) {
                const encrypted = encryptBundleFile(file.bytes, payload.index_id, { contentHash: bundleHash, contentKey }, file.path);
                await client.query(
                  `INSERT INTO index_viewer_bundle_files (index_id, bundle_hash, file_path, file_hash, encrypted_bytes)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (index_id, bundle_hash, file_path) DO UPDATE SET
                     file_hash = EXCLUDED.file_hash,
                     encrypted_bytes = EXCLUDED.encrypted_bytes`,
                  [payload.index_id, bundleHash, file.path, encrypted.fileHash, encrypted.encryptedBytes]
                );
              }
            }

            const nonceExpiresAt = new Date(Date.now() + PUBLISH_NONCE_RETENTION_SECONDS * 1000);
            await client.query(
              `INSERT INTO finance_hub_publish_nonces (index_id, nonce, version, issued_at, expires_at)
               VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
              [payload.index_id, payload.nonce, payload.version, payload.issued_at, nonceExpiresAt]
            );
            await client.query(
              `INSERT INTO finance_hub_publish_manifests
                 (index_id, version, operation, manifest_sha256, bundle_hash, rollback_target_version,
                  file_count, total_bytes, allowed_bases, key_id, algorithm)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
              [
                payload.index_id,
                payload.version,
                payload.operation,
                manifestSha256,
                bundleHash,
                payload.rollback_target_version || null,
                payload.files.length,
                payload.total_bytes,
                JSON.stringify(payload.allowed_bases),
                payload.signature.key_id,
                payload.signature.algorithm,
              ]
            );
            await client.query("DELETE FROM finance_hub_publish_nonces WHERE expires_at < now()");
            return { bundleHash };
          },
        });
      });
    },
  };
}

export function createFinanceHubPublishHandler({
  getKeyRing = () => parsePublishKeyRingFromEnv(process.env),
  store = createPostgresPublishStore(),
  now = () => Date.now(),
} = {}) {
  return async function handleFinanceHubPublishRoute({ json, readJson, req, res, url }) {
    if (url.pathname !== "/api/research/publish") return false;
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST", "cache-control": "no-store" });
      return true;
    }
    try {
      const payload = await readJson(req, 96 * 1024 * 1024);
      const shapeErrors = validatePublishPayloadShape(payload);
      if (shapeErrors.length) {
        json(res, 400, { ok: false, error: "schema_invalid", details: shapeErrors }, { "cache-control": "no-store" });
        return true;
      }

      const keyRing = getKeyRing();
      const result = await store.withIndexLock(payload.index_id, async (tx) => {
        const verification = await verifySignedPublishRequest(payload, {
          keyRing,
          currentVersion: tx.currentVersion,
          hasSeenNonce: tx.hasSeenNonce,
          hasHistoricalManifest: tx.hasHistoricalManifest,
          nowMs: now(),
        });
        if (!verification.ok) return verification;
        const committed = await tx.commitPublish({
          payload,
          manifestSha256: verification.manifestSha256,
          decodedFiles: verification.decodedFiles,
          historicalManifest: verification.historicalManifest,
        });
        return {
          ok: true,
          status: 201,
          body: {
            ok: true,
            index_id: payload.index_id,
            version: payload.version,
            operation: payload.operation,
            manifest_sha256: verification.manifestSha256,
            bundle_hash: committed.bundleHash,
            file_count: payload.files.length,
            allowed_bases: payload.allowed_bases,
          },
        };
      });

      if (!result.ok) {
        json(
          res,
          result.status || 403,
          { ok: false, error: result.error, ...(result.details ? { details: result.details } : {}) },
          { "cache-control": "no-store" }
        );
        return true;
      }
      json(res, result.status || 201, result.body, { "cache-control": "no-store" });
      return true;
    } catch (error) {
      json(
        res,
        error?.status || 503,
        { ok: false, error: error?.status ? error.message : "publish_unavailable" },
        { "cache-control": "no-store" }
      );
      return true;
    }
  };
}

export const handleFinanceHubPublishRoute = createFinanceHubPublishHandler();
