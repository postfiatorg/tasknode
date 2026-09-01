import { createHash, randomUUID } from "node:crypto";
import { accountIdentityProfile } from "../account-identity.js";
import { databaseEnabled, query } from "../db/pool.js";
import {
  createAccountSession as createRuntimeAccountSession,
  createDevSession as createRuntimeDevSession,
  destroySession as destroyRuntimeSession,
  getSession as getRuntimeSession,
  revokeRuntimeSessionsForAccount,
  sessionTtlSeconds,
} from "../runtime-store.js";

function tokenHash(token = "") {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function publicSession(session = null) {
  if (!session) return null;
  const { id: _sessionToken, deviceAccountSetId: _deviceAccountSetId, ...payload } = session;
  return payload;
}

function sessionForAccount(account, { provider = "email", assurance = "low", deviceAccountSetId = "", sessionId, createdAt, expiresAt } = {}) {
  const profile = accountIdentityProfile(account) || {};
  return {
    id: sessionId,
    accountId: account.id,
    authenticated: true,
    displayName: profile.displayName || account.displayName || "Task Node member",
    hiveHandle: profile.hiveHandle || "",
    publicDisplayName: profile.publicDisplayName || "",
    profileVisibility: profile.profileVisibility || account.profileVisibility || "public",
    primaryProvider: provider,
    linkedProviders: Array.isArray(account.linkedProviders) ? account.linkedProviders : [],
    assurance,
    deviceAccountSetId: deviceAccountSetId || null,
    createdAt,
    expiresAt,
  };
}

function rowSession(row, sessionId = "") {
  if (!row) return null;
  const payload = row.session_json && typeof row.session_json === "object" ? row.session_json : {};
  return {
    ...payload,
    id: sessionId,
    accountId: row.account_id,
    authenticated: true,
    primaryProvider: row.primary_provider || payload.primaryProvider || "",
    assurance: row.assurance || payload.assurance || "low",
    deviceAccountSetId: row.device_account_set_id || payload.deviceAccountSetId || null,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

async function persistSession({ sessionId, session }) {
  const storedSession = { ...session };
  delete storedSession.id;
  await query(
    `INSERT INTO auth_sessions (
       token_hash, account_id, primary_provider, assurance, session_json,
       device_account_set_id, created_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [
      tokenHash(sessionId),
      session.accountId,
      session.primaryProvider || "",
      session.assurance || "low",
      JSON.stringify(storedSession),
      session.deviceAccountSetId || null,
      session.createdAt,
      session.expiresAt,
    ]
  );
  return { sessionId, session: publicSession(session) };
}

export async function createAccountSession(account, options = {}) {
  if (!databaseEnabled()) {
    const created = createRuntimeAccountSession(account, options);
    return { ...created, session: publicSession(created.session) };
  }
  if (!account?.id) throw new Error("session_account_required");
  const sessionId = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000).toISOString();
  const session = sessionForAccount(account, { ...options, sessionId, createdAt, expiresAt });
  return persistSession({ sessionId, session });
}

export async function createDevSession(options = {}) {
  const created = createRuntimeDevSession(options);
  if (!databaseEnabled()) return { ...created, session: publicSession(created.session) };
  await persistSession(created);
  destroyRuntimeSession(created.sessionId);
  return { ...created, session: publicSession(created.session) };
}

export async function getSession(sessionId = "") {
  if (!sessionId) return null;
  if (!databaseEnabled()) return getRuntimeSession(sessionId);
  const result = await query(
    `SELECT account_id, primary_provider, assurance, session_json, device_account_set_id, created_at, expires_at
       FROM auth_sessions
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()`,
    [tokenHash(sessionId)]
  );
  return rowSession(result.rows[0], sessionId);
}

export async function destroySession(sessionId = "") {
  if (!sessionId) return false;
  if (!databaseEnabled()) return destroyRuntimeSession(sessionId);
  const result = await query(
    `UPDATE auth_sessions
        SET revoked_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
      RETURNING token_hash`,
    [tokenHash(sessionId)]
  );
  return result.rowCount > 0;
}

export async function revokeSessionsForAccount({ accountId = "", exceptSessionId = "" } = {}) {
  const normalized = String(accountId || "").trim();
  if (!normalized) return { revoked: 0 };
  if (!databaseEnabled()) {
    return { ...revokeRuntimeSessionsForAccount({ accountId: normalized, exceptSessionId }), adapter: "runtime" };
  }
  const exceptHash = exceptSessionId ? tokenHash(exceptSessionId) : "";
  const result = await query(
    `UPDATE auth_sessions SET revoked_at = now()
      WHERE account_id = $1 AND revoked_at IS NULL
        AND ($2 = '' OR token_hash <> $2)`,
    [normalized, exceptHash]
  );
  return { revoked: result.rowCount, adapter: "postgres" };
}

export async function deleteExpiredSessions() {
  if (!databaseEnabled()) return { deleted: 0, adapter: "runtime" };
  const result = await query(
    `DELETE FROM auth_sessions
      WHERE expires_at <= now()
         OR revoked_at < now() - interval '7 days'`
  );
  return { deleted: result.rowCount, adapter: "postgres" };
}

export function authSessionStorageStatus() {
  return { adapter: databaseEnabled() ? "postgres" : "runtime", tokenStorage: databaseEnabled() ? "sha256" : "opaque-local" };
}
