import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { databaseEnabled, query } from "../db/pool.js";

const CODE_TTL_SECONDS = 300;
const TOKEN_TTL_SECONDS = 60 * 60 * 6;

export function hashOpaque(value = "") {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function newOpaqueSecret() {
  return randomBytes(32).toString("base64url");
}

/** Constant-time compare so a token check cannot be probed byte by byte. */
export function secretsMatch(left = "", right = "") {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function indexFromRow(row) {
  if (!row) return null;
  return {
    indexId: row.index_id,
    title: row.title || "",
    summary: row.summary || "",
    tier: row.tier || "tasknode-active-wallet",
    contentKey: row.content_key,
    contentUrl: row.content_url || "",
    contentHash: row.content_hash || "",
    availableAt: row.available_at,
    publishedAt: row.published_at,
    metadata: row.metadata_json || {},
  };
}

export async function getIndex(indexId = "") {
  if (!databaseEnabled() || !indexId) return null;
  const result = await query(
    `SELECT * FROM index_viewer_indices WHERE index_id = $1 LIMIT 1`,
    [String(indexId)]
  );
  return indexFromRow(result.rows[0]);
}

/** Catalog never exposes content keys. */
export async function listIndices() {
  if (!databaseEnabled()) return [];
  const result = await query(
    `SELECT index_id, title, summary, tier, content_url, content_hash,
            available_at, published_at, metadata_json
       FROM index_viewer_indices
      WHERE available_at <= now()
      ORDER BY published_at DESC`
  );
  return result.rows.map((row) => ({
    indexId: row.index_id,
    title: row.title || "",
    summary: row.summary || "",
    tier: row.tier || "tasknode-active-wallet",
    contentUrl: row.content_url || "",
    contentHash: row.content_hash || "",
    availableAt: row.available_at,
    publishedAt: row.published_at,
    metadata: row.metadata_json || {},
  }));
}

export async function upsertIndex({
  indexId,
  title = "",
  summary = "",
  tier = "tasknode-active-wallet",
  contentKey,
  contentUrl = "",
  contentHash = "",
  availableAt = null,
  metadata = {},
} = {}) {
  if (!indexId || !contentKey) throw new Error("index_id_and_content_key_required");
  const result = await query(
    `INSERT INTO index_viewer_indices
       (index_id, title, summary, tier, content_key, content_url, content_hash,
        available_at, published_at, metadata_json, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now()), now(), $9::jsonb, now())
     ON CONFLICT (index_id) DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       tier = EXCLUDED.tier,
       content_key = EXCLUDED.content_key,
       content_url = EXCLUDED.content_url,
       content_hash = EXCLUDED.content_hash,
       available_at = EXCLUDED.available_at,
       published_at = now(),
       metadata_json = EXCLUDED.metadata_json,
       updated_at = now()
     RETURNING *`,
    [
      String(indexId),
      String(title),
      String(summary),
      String(tier),
      String(contentKey),
      String(contentUrl),
      String(contentHash),
      availableAt,
      JSON.stringify(metadata || {}),
    ]
  );
  return indexFromRow(result.rows[0]);
}

export async function issueCode({ indexId, accountId, returnOrigin = "" } = {}) {
  const code = newOpaqueSecret();
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);
  await query(
    `INSERT INTO index_viewer_codes (code_hash, index_id, account_id, return_origin, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [hashOpaque(code), String(indexId), String(accountId), String(returnOrigin), expiresAt]
  );
  return { code, expiresAt };
}

/** Single use: the same code can never mint a second token. */
export async function consumeCode({ code = "", indexId = "" } = {}) {
  if (!code) return null;
  const result = await query(
    `UPDATE index_viewer_codes
        SET consumed_at = now()
      WHERE code_hash = $1
        AND index_id = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING account_id, return_origin`,
    [hashOpaque(code), String(indexId)]
  );
  const row = result.rows[0];
  return row ? { accountId: row.account_id, returnOrigin: row.return_origin || "" } : null;
}

export async function issueViewerToken({ indexId, accountId, walletAddress = "" } = {}) {
  const token = newOpaqueSecret();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);
  await query(
    `INSERT INTO index_viewer_tokens (token_hash, index_id, account_id, wallet_address, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [hashOpaque(token), String(indexId), String(accountId), String(walletAddress), expiresAt]
  );
  return { token, expiresAt };
}

export async function resolveViewerToken({ token = "", indexId = "" } = {}) {
  if (!token) return null;
  const result = await query(
    `UPDATE index_viewer_tokens
        SET last_used_at = now()
      WHERE token_hash = $1
        AND index_id = $2
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING account_id, wallet_address, expires_at`,
    [hashOpaque(token), String(indexId)]
  );
  const row = result.rows[0];
  return row
    ? { accountId: row.account_id, walletAddress: row.wallet_address || "", expiresAt: row.expires_at }
    : null;
}

export async function purgeExpiredIndexViewerGrants() {
  if (!databaseEnabled()) return { codes: 0, tokens: 0 };
  const codes = await query(
    `DELETE FROM index_viewer_codes WHERE expires_at < now() - interval '1 day'`
  );
  const tokens = await query(
    `DELETE FROM index_viewer_tokens WHERE expires_at < now() - interval '7 days'`
  );
  return { codes: codes.rowCount || 0, tokens: tokens.rowCount || 0 };
}
