import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  clearLegacyTerminalAuthAfterMigration,
  consumeTerminalAuthRequestSession as consumeRuntimeRequest,
  createTerminalAuthRequest as createRuntimeRequest,
  getAccount as getRuntimeAccount,
  getTerminalAuthRequest as getRuntimeRequest,
  getTerminalSessionByToken as getRuntimeSession,
  legacyTerminalAuthSnapshotForMigration,
  revokeTerminalSessionByToken as revokeRuntimeSession,
} from "../runtime-store.js";
import { getAccount, getLinkedProviderForAccount } from "./accounts.js";

function hash(value = "") { return createHash("sha256").update(String(value || ""), "utf8").digest("hex"); }
function randomToken(prefix, bytes) { return `${prefix}_${randomBytes(bytes).toString("base64url")}`; }
function requestTtlSeconds() {
  const value = Number(process.env.TASKNODE_TERMINAL_AUTH_TTL_SECONDS || 600);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 3600) : 600;
}
function sessionTtlSeconds() {
  const value = Number(process.env.TASKNODE_TERMINAL_SESSION_TTL_SECONDS || 86_400);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 2_592_000) : 86_400;
}
function userCode() {
  return randomBytes(5).toString("base64url").replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8).replace(/^(.{4})(.+)$/, "$1-$2");
}
function safeEqual(left = "", right = "") {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
function terminalSessionPayload(row = null) {
  if (!row) return null;
  const payload = row.session_json && typeof row.session_json === "object" ? row.session_json : {};
  return {
    ...payload,
    id: row.session_id,
    accountId: row.account_id,
    provider: row.provider,
    githubUsername: row.provider_username || payload.githubUsername || "",
    scopes: Array.isArray(row.scopes_json) ? row.scopes_json : [],
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export async function createTerminalAuthRequest(options = {}) {
  if (!databaseEnabled()) return createRuntimeRequest(options);
  const provider = String(options.provider || "github").trim().toLowerCase() || "github";
  const requestId = randomToken("tnterm", 18); const pollToken = randomToken("tnpoll", 24);
  const createdAt = new Date(); const expiresAt = new Date(createdAt.getTime() + requestTtlSeconds() * 1000);
  const code = userCode();
  await query(
    `INSERT INTO terminal_auth_requests (
       request_hash, provider, status, user_code, poll_token_hash, request_json, created_at, expires_at
     ) VALUES ($1, $2, 'pending', $3, $4, $5::jsonb, $6, $7)`,
    [
      hash(requestId), provider, code, hash(pollToken), JSON.stringify({
        origin: String(options.origin || "").slice(0, 500),
        userAgent: String(options.userAgent || "").slice(0, 500),
        ip: String(options.ip || "").slice(0, 120),
      }), createdAt.toISOString(), expiresAt.toISOString(),
    ]
  );
  return { requestId, pollToken, userCode: code, expiresAt: expiresAt.toISOString(), provider };
}

export async function getTerminalAuthRequest({ requestId = "" } = {}) {
  if (!databaseEnabled()) return getRuntimeRequest({ requestId });
  const result = await query(
    `SELECT provider, status, user_code, account_id, request_json, error,
            created_at, expires_at, completed_at
       FROM terminal_auth_requests
      WHERE request_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [hash(requestId)]
  );
  const row = result.rows[0]; if (!row) return null;
  return {
    id: String(requestId), provider: row.provider, status: row.status, userCode: row.user_code,
    accountId: row.account_id || undefined, ...(row.request_json || {}), error: row.error || undefined,
    createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
  };
}

export async function completeTerminalAuthRequest({ requestId = "", accountId = "", provider = "github" } = {}) {
  if (!databaseEnabled()) {
    const { completeTerminalAuthRequest } = await import("../runtime-store.js");
    return completeTerminalAuthRequest({ requestId, accountId, provider });
  }
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedProvider = String(provider || "github").trim().toLowerCase();
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT provider, status FROM terminal_auth_requests
        WHERE request_hash = $1 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
      [hash(requestId)]
    );
    const request = current.rows[0];
    if (!request) return { ok: false, error: "terminal_auth_request_not_found" };
    if (request.status !== "pending") return { ok: false, error: "terminal_auth_request_not_pending" };
    if (!normalizedAccountId || !(await getLinkedProviderForAccount({ accountId: normalizedAccountId, provider: normalizedProvider }))) {
      await client.query(
        `UPDATE terminal_auth_requests SET status = 'failed', error = 'github_not_linked', completed_at = now()
          WHERE request_hash = $1`, [hash(requestId)]
      );
      return { ok: false, error: "github_not_linked" };
    }
    await client.query(
      `UPDATE terminal_auth_requests SET status = 'linked', account_id = $2,
       provider = $3, completed_at = now() WHERE request_hash = $1`,
      [hash(requestId), normalizedAccountId, normalizedProvider]
    );
    return {
      ok: true,
      request: {
        id: String(requestId),
        provider: normalizedProvider,
        status: "linked",
        accountId: normalizedAccountId,
        completedAt: new Date().toISOString(),
      },
    };
  });
}

export async function consumeTerminalAuthRequestSession({ requestId = "", pollToken = "" } = {}) {
  if (!databaseEnabled()) return consumeRuntimeRequest({ requestId, pollToken });
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT provider, status, user_code, poll_token_hash, account_id, error, expires_at
         FROM terminal_auth_requests WHERE request_hash = $1 AND consumed_at IS NULL FOR UPDATE`,
      [hash(requestId)]
    );
    const request = current.rows[0];
    if (!request || new Date(request.expires_at).getTime() <= Date.now()) return { ok: false, status: 404, error: "terminal_auth_request_not_found" };
    if (!safeEqual(request.poll_token_hash, hash(pollToken))) return { ok: false, status: 401, error: "terminal_auth_poll_denied" };
    if (request.status === "pending") return { ok: false, status: 202, error: "terminal_auth_pending", requestId, provider: request.provider, expiresAt: new Date(request.expires_at).toISOString() };
    if (request.status !== "linked" || !request.account_id) {
      await client.query("UPDATE terminal_auth_requests SET consumed_at = now() WHERE request_hash = $1", [hash(requestId)]);
      return { ok: false, status: 409, error: request.error || "terminal_auth_invalid_state" };
    }
    const linked = await getLinkedProviderForAccount({ accountId: request.account_id, provider: request.provider });
    if (!linked) return { ok: false, status: 409, error: "github_not_linked" };
    const token = randomToken("tns", 32); const sessionId = randomToken("tnsess", 18);
    const now = new Date(); const expiresAt = new Date(now.getTime() + sessionTtlSeconds() * 1000);
    const scopes = ["tasknode:read", "tasknode:tasks:write", "tasknode:balance:read"];
    const payload = { githubUsername: linked.username || "", account: await getAccount(request.account_id) };
    const inserted = await client.query(
      `INSERT INTO terminal_sessions (
         token_hash, session_id, account_id, provider, provider_username,
         scopes_json, session_json, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING *`,
      [hash(token), sessionId, request.account_id, request.provider, linked.username || "", JSON.stringify(scopes), JSON.stringify(payload), now.toISOString(), expiresAt.toISOString()]
    );
    await client.query("UPDATE terminal_auth_requests SET consumed_at = now() WHERE request_hash = $1", [hash(requestId)]);
    return { ok: true, status: 200, terminalToken: token, session: terminalSessionPayload(inserted.rows[0]) };
  });
}

export async function getTerminalSessionByToken(token = "") {
  if (!databaseEnabled()) return getRuntimeSession(token);
  if (!token) return null;
  const result = await query(
    `SELECT * FROM terminal_sessions WHERE token_hash = $1
      AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
    [hash(token)]
  );
  const session = terminalSessionPayload(result.rows[0]);
  if (!session || !(await getLinkedProviderForAccount({ accountId: session.accountId, provider: session.provider }))) return null;
  return session;
}

export async function revokeTerminalSessionByToken(token = "") {
  if (!databaseEnabled()) return revokeRuntimeSession(token);
  if (!token) return false;
  const result = await query(
    "UPDATE terminal_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING token_hash",
    [hash(token)]
  );
  return result.rowCount > 0;
}

export async function migrateLegacyTerminalAuth() {
  if (!databaseEnabled()) return { migrated: false, adapter: "runtime", requests: 0, sessions: 0 };
  const snapshot = legacyTerminalAuthSnapshotForMigration();
  const result = await transaction(async (client) => {
    const name = "terminal_auth_to_postgres_v1";
    const marker = await client.query("SELECT metadata_json FROM runtime_state_migrations WHERE name = $1 FOR UPDATE", [name]);
    if (marker.rows[0]) return { migrated: false, adapter: "postgres", ...(marker.rows[0].metadata_json || {}) };
    let requests = 0; let sessions = 0;
    for (const [requestId, request] of Object.entries(snapshot.requests || {})) {
      if (!request?.pollTokenHash || !request?.expiresAt) continue;
      const payload = { origin: request.origin || "", userAgent: request.userAgent || "", ip: request.ip || "" };
      await client.query(
        `INSERT INTO terminal_auth_requests (
           request_hash, provider, status, user_code, poll_token_hash, account_id,
           request_json, error, created_at, expires_at, completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [hash(requestId), request.provider || "github", request.status || "pending", request.userCode || "", request.pollTokenHash, request.accountId || null, JSON.stringify(payload), request.error || "", request.createdAt, request.expiresAt, request.completedAt || null]
      ); requests += 1;
    }
    for (const [sessionId, session] of Object.entries(snapshot.sessions || {})) {
      if (!session?.tokenHash || !session?.accountId || !session?.expiresAt) continue;
      const scopes = Array.isArray(session.scopes) ? session.scopes : [];
      await client.query(
        `INSERT INTO terminal_sessions (
           token_hash, session_id, account_id, provider, provider_username,
           scopes_json, session_json, created_at, expires_at, revoked_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [session.tokenHash, sessionId, session.accountId, session.provider || "github", session.providerUsername || "", JSON.stringify(scopes), JSON.stringify({ account: getRuntimeAccount(session.accountId) }), session.createdAt, session.expiresAt, session.revokedAt || null]
      ); sessions += 1;
    }
    const metadata = { requests, sessions };
    await client.query("INSERT INTO runtime_state_migrations (name, record_count, metadata_json) VALUES ($1,$2,$3::jsonb)", [name, requests + sessions, JSON.stringify(metadata)]);
    return { migrated: true, adapter: "postgres", ...metadata };
  });
  clearLegacyTerminalAuthAfterMigration(); return result;
}

export function terminalAuthStorageStatus() {
  return { adapter: databaseEnabled() ? "postgres" : "runtime", tokenStorage: databaseEnabled() ? "sha256" : "sha256-local" };
}
