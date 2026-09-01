import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  consumeEmailChallenge as consumeRuntimeEmailChallenge,
  consumeOAuthState as consumeRuntimeOAuthState,
  consumeWalletChallenge as consumeRuntimeWalletChallenge,
  consumeWalletLoginChallenge as consumeRuntimeWalletLoginChallenge,
  createEmailChallenge as createRuntimeEmailChallenge,
  createOAuthState as createRuntimeOAuthState,
  createWalletChallenge as createRuntimeWalletChallenge,
  createWalletLoginChallenge as createRuntimeWalletLoginChallenge,
  getEmailChallenge as getRuntimeEmailChallenge,
} from "../runtime-store.js";

function challengeHash(id = "") {
  return createHash("sha256").update(String(id || ""), "utf8").digest("hex");
}

function safeEqualHex(left = "", right = "") {
  const a = Buffer.from(String(left || ""), "hex");
  const b = Buffer.from(String(right || ""), "hex");
  return Boolean(a.length && a.length === b.length && timingSafeEqual(a, b));
}

function payload(row) {
  return row?.payload_json && typeof row.payload_json === "object" ? row.payload_json : {};
}

const runtimeAddAccountIntents = new Map();

function walletLoginChallengeCap() {
  const parsed = Number(process.env.TASKNODE_WALLET_LOGIN_CHALLENGE_CAP || 3000);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 3000;
}

function walletChallengeMessage({ accountId, challengeId, purpose, issuedAt, expiresAt }) {
  return [
    "Post Fiat Task Node wallet proof",
    `Purpose: ${purpose}`,
    `Account: ${accountId}`,
    `Challenge: ${challengeId}`,
    `Issued: ${issuedAt}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

function walletLoginChallengeMessage({ address, challengeId, issuedAt, expiresAt }) {
  return [
    "Post Fiat Task Node wallet login",
    "Purpose: wallet_login",
    `Address: ${address}`,
    `Challenge: ${challengeId}`,
    `Issued: ${issuedAt}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

export async function createOAuthState(options = {}) {
  if (!databaseEnabled()) return createRuntimeOAuthState(options);
  const id = randomUUID();
  const provider = String(options.provider || "").trim().toLowerCase();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (Number(options.expiresInSeconds) || 600) * 1000).toISOString();
  const state = {
    id,
    provider,
    redirectPath: String(options.redirectPath || "/").startsWith("/") ? String(options.redirectPath || "/") : "/",
    redirectUri: String(options.redirectUri || ""),
    linkAccountId: String(options.linkAccountId || "").trim(),
    metadata: options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata) ? { ...options.metadata } : {},
    createdAt,
    expiresAt,
  };
  const stored = { ...state };
  delete stored.id;
  await query(
    `INSERT INTO auth_challenges (challenge_hash, kind, provider, subject_key, payload_json, max_attempts, created_at, expires_at)
     VALUES ($1, 'oauth_state', $2, $3, $4::jsonb, 1, $5, $6)`,
    [challengeHash(id), provider, state.linkAccountId, JSON.stringify(stored), createdAt, expiresAt]
  );
  return state;
}

export async function consumeOAuthState({ provider = "", stateId = "", peek = false } = {}) {
  if (!databaseEnabled()) return consumeRuntimeOAuthState({ provider, stateId, peek });
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT provider, payload_json, created_at, expires_at
         FROM auth_challenges
        WHERE challenge_hash = $1 AND kind = 'oauth_state'
          AND consumed_at IS NULL AND replaced_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [challengeHash(stateId)]
    );
    const row = result.rows[0];
    if (!row || row.provider !== String(provider || "").trim().toLowerCase()) return null;
    if (!peek) await client.query("UPDATE auth_challenges SET consumed_at = now() WHERE challenge_hash = $1", [challengeHash(stateId)]);
    return {
      ...payload(row),
      id: stateId,
      provider: row.provider,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  });
}

export async function createAddAccountIntent({ accountId = "", setId = "", expiresInSeconds = 600 } = {}) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Math.min(Math.max(Number(expiresInSeconds) || 600, 60), 900) * 1000).toISOString();
  const intent = {
    id,
    kind: "add_account",
    accountId: String(accountId || "").trim(),
    setId: String(setId || "").trim(),
    createdAt,
    expiresAt,
  };
  if (!databaseEnabled()) {
    runtimeAddAccountIntents.set(id, intent);
    return intent;
  }
  await query(
    `INSERT INTO auth_challenges (
       challenge_hash, kind, subject_key, payload_json, max_attempts, created_at, expires_at
     ) VALUES ($1, 'account_add_intent', $2, $3::jsonb, 10, $4, $5)`,
    [challengeHash(id), intent.accountId, JSON.stringify(intent), createdAt, expiresAt]
  );
  return intent;
}

export async function getAddAccountIntent(intentId = "") {
  const id = String(intentId || "").trim();
  if (!id) return null;
  if (!databaseEnabled()) {
    const intent = runtimeAddAccountIntents.get(id) || null;
    if (!intent || Date.parse(intent.expiresAt) <= Date.now()) {
      runtimeAddAccountIntents.delete(id);
      return null;
    }
    return { ...intent };
  }
  const result = await query(
    `SELECT payload_json, created_at, expires_at FROM auth_challenges
      WHERE challenge_hash = $1 AND kind = 'account_add_intent'
        AND consumed_at IS NULL AND replaced_at IS NULL AND expires_at > now()`,
    [challengeHash(id)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...payload(row),
    id,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export async function consumeAddAccountIntent(intentId = "") {
  const id = String(intentId || "").trim();
  if (!id) return false;
  if (!databaseEnabled()) return runtimeAddAccountIntents.delete(id);
  const result = await query(
    `UPDATE auth_challenges SET consumed_at = now()
      WHERE challenge_hash = $1 AND kind = 'account_add_intent'
        AND consumed_at IS NULL AND replaced_at IS NULL AND expires_at > now()`,
    [challengeHash(id)]
  );
  return result.rowCount > 0;
}

export async function createEmailChallenge(options = {}) {
  if (!databaseEnabled()) return createRuntimeEmailChallenge(options);
  const id = options.id || randomUUID();
  const canonicalEmail = String(options.canonicalEmail || "").trim();
  const purpose = String(options.purpose || "login");
  const createdAt = new Date().toISOString();
  const value = {
    email: options.email,
    canonicalEmail,
    maskedEmail: options.maskedEmail,
    deliveryMode: options.deliveryMode,
    requestIp: String(options.requestIp || "").slice(0, 80),
    userAgent: String(options.userAgent || "").slice(0, 240),
    purpose,
    expectedAccountId: String(options.expectedAccountId || "").trim(),
  };
  await transaction(async (client) => {
    await client.query(
      `UPDATE auth_challenges SET replaced_at = now()
        WHERE kind = 'email_login' AND subject_key = $1
          AND COALESCE(payload_json->>'purpose', 'login') = $2
          AND consumed_at IS NULL AND replaced_at IS NULL`,
      [canonicalEmail, purpose]
    );
    await client.query(
      `INSERT INTO auth_challenges (
         challenge_hash, kind, subject_key, secret_hash, payload_json,
         attempts, max_attempts, created_at, expires_at
       ) VALUES ($1, 'email_login', $2, $3, $4::jsonb, 0, 6, $5, $6)`,
      [challengeHash(id), canonicalEmail, options.codeHash, JSON.stringify(value), createdAt, options.expiresAt]
    );
  });
  return { id, maskedEmail: options.maskedEmail, expiresAt: options.expiresAt, deliveryMode: options.deliveryMode };
}

export async function getEmailChallenge(challengeId = "") {
  if (!databaseEnabled()) return getRuntimeEmailChallenge(challengeId);
  const result = await query(
    `SELECT payload_json, attempts, max_attempts, created_at, expires_at
       FROM auth_challenges
      WHERE challenge_hash = $1 AND kind = 'email_login'
        AND consumed_at IS NULL AND replaced_at IS NULL AND expires_at > now()`,
    [challengeHash(challengeId)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: challengeId,
    ...payload(row),
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 6),
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    consumedAt: null,
    replacedAt: null,
  };
}

export async function consumeEmailChallenge({ challengeId = "", codeHash = "", purpose = "", expectedAccountId = "" } = {}) {
  if (!databaseEnabled()) return consumeRuntimeEmailChallenge({ challengeId, codeHash, purpose, expectedAccountId });
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT secret_hash, payload_json, attempts, max_attempts
         FROM auth_challenges
        WHERE challenge_hash = $1 AND kind = 'email_login'
          AND consumed_at IS NULL AND replaced_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [challengeHash(challengeId)]
    );
    const row = result.rows[0];
    if (!row) return { ok: false, error: "email_challenge_invalid" };
    const value = payload(row);
    if (purpose && value.purpose !== purpose) return { ok: false, error: "email_challenge_invalid" };
    if (expectedAccountId && value.expectedAccountId !== expectedAccountId) {
      return { ok: false, error: "email_challenge_invalid" };
    }
    if (Number(row.attempts || 0) >= Number(row.max_attempts || 6)) {
      return { ok: false, error: "email_challenge_attempts_exceeded" };
    }
    if (!safeEqualHex(row.secret_hash, codeHash)) {
      await client.query("UPDATE auth_challenges SET attempts = attempts + 1 WHERE challenge_hash = $1", [challengeHash(challengeId)]);
      return { ok: false, error: "email_challenge_invalid" };
    }
    const consumedAt = new Date().toISOString();
    await client.query("UPDATE auth_challenges SET consumed_at = $2 WHERE challenge_hash = $1", [challengeHash(challengeId), consumedAt]);
    return { ok: true, challenge: { id: challengeId, ...value, consumedAt } };
  });
}

export async function createWalletChallenge({ accountId = "", purpose = "wallet_link" } = {}) {
  if (!databaseEnabled()) return createRuntimeWalletChallenge({ accountId, purpose });
  if (!accountId) return { ok: false, status: 401, error: "wallet_login_required" };
  const id = randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const value = { accountId: String(accountId), purpose, issuedAt };
  await query(
    `INSERT INTO auth_challenges (challenge_hash, kind, subject_key, payload_json, max_attempts, created_at, expires_at)
     VALUES ($1, 'wallet_proof', $2, $3::jsonb, 1, $4, $5)`,
    [challengeHash(id), String(accountId), JSON.stringify(value), issuedAt, expiresAt]
  );
  return { ok: true, challenge: { id, ...value, expiresAt, message: walletChallengeMessage({ accountId, challengeId: id, purpose, issuedAt, expiresAt }) } };
}

export async function createWalletLoginChallenge({ address = "", publicKey = "", expiresInSeconds = 300, expiresAt = "" } = {}) {
  if (!databaseEnabled()) return createRuntimeWalletLoginChallenge({ address, publicKey, expiresInSeconds, expiresAt });
  const normalizedAddress = String(address || "").trim();
  if (!normalizedAddress) return { ok: false, status: 400, error: "wallet_address_required" };
  const id = randomUUID();
  const issuedAt = new Date().toISOString();
  const ttlMs = Math.min(Math.max(Number(expiresInSeconds) || 300, 1), 600) * 1000;
  const resolvedExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : new Date(Date.now() + ttlMs).toISOString();
  const value = { address: normalizedAddress, publicKey: String(publicKey || "").trim(), purpose: "wallet_login", issuedAt };
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO auth_challenges (challenge_hash, kind, subject_key, payload_json, max_attempts, created_at, expires_at)
       VALUES ($1, 'wallet_login', $2, $3::jsonb, 1, $4, $5)`,
      [challengeHash(id), normalizedAddress, JSON.stringify(value), issuedAt, resolvedExpiresAt]
    );
    await client.query(
      `DELETE FROM auth_challenges WHERE challenge_hash IN (
         SELECT challenge_hash FROM auth_challenges
          WHERE kind = 'wallet_login' AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC, challenge_hash DESC OFFSET $1
       )`,
      [walletLoginChallengeCap()]
    );
  });
  return { ok: true, challenge: { id, ...value, expiresAt: resolvedExpiresAt, message: walletLoginChallengeMessage({ address: normalizedAddress, challengeId: id, issuedAt, expiresAt: resolvedExpiresAt }) } };
}

export async function consumeWalletChallenge({ accountId = "", challengeId = "", purpose = "wallet_link" } = {}) {
  if (!databaseEnabled()) return consumeRuntimeWalletChallenge({ accountId, challengeId, purpose });
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT payload_json, expires_at FROM auth_challenges
        WHERE challenge_hash = $1 AND kind = 'wallet_proof' AND consumed_at IS NULL
        FOR UPDATE`,
      [challengeHash(challengeId)]
    );
    const row = result.rows[0];
    if (!row) return { ok: false, status: 400, error: "wallet_challenge_invalid" };
    const value = payload(row);
    const allowed = Array.isArray(purpose) ? purpose : [purpose];
    if (value.accountId !== String(accountId) || !allowed.includes(value.purpose)) {
      return { ok: false, status: 400, error: "wallet_challenge_mismatch" };
    }
    if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, status: 400, error: "wallet_challenge_expired" };
    await client.query("UPDATE auth_challenges SET consumed_at = now() WHERE challenge_hash = $1", [challengeHash(challengeId)]);
    const expiresAt = new Date(row.expires_at).toISOString();
    return { ok: true, challenge: { id: challengeId, ...value, expiresAt, message: walletChallengeMessage({ accountId, challengeId, purpose: value.purpose, issuedAt: value.issuedAt, expiresAt }) } };
  });
}

export async function consumeWalletLoginChallenge({ challengeId = "", address = "" } = {}) {
  if (!databaseEnabled()) return consumeRuntimeWalletLoginChallenge({ challengeId, address });
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT payload_json, expires_at FROM auth_challenges
        WHERE challenge_hash = $1 AND kind = 'wallet_login' AND consumed_at IS NULL
        FOR UPDATE`,
      [challengeHash(challengeId)]
    );
    const row = result.rows[0];
    if (!row) return { ok: false, status: 400, error: "invalid_or_expired_challenge" };
    await client.query("UPDATE auth_challenges SET consumed_at = now() WHERE challenge_hash = $1", [challengeHash(challengeId)]);
    const value = payload(row);
    const expiresAt = new Date(row.expires_at).toISOString();
    if (value.address !== String(address || "").trim() || Date.parse(row.expires_at) <= Date.now()) {
      return { ok: false, status: 400, error: "invalid_or_expired_challenge" };
    }
    return { ok: true, challenge: { id: challengeId, ...value, expiresAt, message: walletLoginChallengeMessage({ address: value.address, challengeId, issuedAt: value.issuedAt, expiresAt }) } };
  });
}

export function authChallengeStorageStatus() {
  return { adapter: databaseEnabled() ? "postgres" : "runtime", idStorage: databaseEnabled() ? "sha256" : "opaque-local" };
}
