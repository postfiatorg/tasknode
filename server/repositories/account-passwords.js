import { Algorithm, hash, verify } from "@node-rs/argon2";
import { databaseEnabled, query } from "../db/pool.js";

const runtimeCredentials = new Map();
const ARGON2_OPTIONS = Object.freeze({
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
});

let dummyHashPromise = null;

function normalizedAccountId(value = "") {
  return String(value || "").trim();
}

export function validateAccountPassword(password = "") {
  const value = String(password || "");
  const byteLength = Buffer.byteLength(value, "utf8");
  if (value.length < 12) return { ok: false, error: "password_too_short" };
  if (byteLength > 1024) return { ok: false, error: "password_too_long" };
  return { ok: true, password: value };
}

async function passwordHash(password) {
  return hash(password, ARGON2_OPTIONS);
}

async function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = passwordHash("tasknode-password-verification-dummy-value");
  }
  return dummyHashPromise;
}

function passwordHashNeedsUpgrade(encoded = "") {
  const parts = String(encoded || "").split("$");
  if (parts[1] !== "argon2id") return true;
  const parameters = Object.fromEntries(
    String(parts[3] || "").split(",").map((entry) => {
      const [key, value] = entry.split("=");
      return [key, Number(value)];
    })
  );
  return parameters.m < ARGON2_OPTIONS.memoryCost
    || parameters.t < ARGON2_OPTIONS.timeCost
    || parameters.p < ARGON2_OPTIONS.parallelism;
}

export async function passwordCredentialStatus({ accountId = "" } = {}) {
  const normalized = normalizedAccountId(accountId);
  if (!normalized) return { enabled: false, credentialVersion: 0 };
  if (!databaseEnabled()) {
    const credential = runtimeCredentials.get(normalized);
    return {
      enabled: Boolean(credential && !credential.disabledAt),
      credentialVersion: Number(credential?.credentialVersion || 0),
      createdAt: credential?.createdAt || null,
      updatedAt: credential?.updatedAt || null,
      lastUsedAt: credential?.lastUsedAt || null,
    };
  }
  const result = await query(
    `SELECT credential_version, created_at, updated_at, last_used_at, disabled_at
       FROM account_password_credentials WHERE account_id = $1`,
    [normalized]
  );
  const row = result.rows[0];
  return {
    enabled: Boolean(row && !row.disabled_at),
    credentialVersion: Number(row?.credential_version || 0),
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    lastUsedAt: row?.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

export function runtimePasswordCredentialEnabled(accountId = "") {
  const credential = runtimeCredentials.get(normalizedAccountId(accountId));
  return Boolean(credential && !credential.disabledAt);
}

export async function setAccountPassword({ accountId = "", password = "" } = {}) {
  const normalized = normalizedAccountId(accountId);
  if (!normalized) return { ok: false, error: "password_account_required" };
  const validated = validateAccountPassword(password);
  if (!validated.ok) return validated;
  const hash = await passwordHash(validated.password);
  const now = new Date().toISOString();
  if (!databaseEnabled()) {
    const prior = runtimeCredentials.get(normalized);
    const credentialVersion = Number(prior?.credentialVersion || 0) + 1;
    runtimeCredentials.set(normalized, {
      passwordHash: hash,
      credentialVersion,
      createdAt: prior?.createdAt || now,
      updatedAt: now,
      lastUsedAt: prior?.lastUsedAt || null,
      disabledAt: null,
    });
    return { ok: true, credentialVersion };
  }
  const result = await query(
    `INSERT INTO account_password_credentials (
       account_id, password_hash, credential_version, created_at, updated_at, disabled_at
     ) VALUES ($1, $2, 1, now(), now(), NULL)
     ON CONFLICT (account_id) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       credential_version = account_password_credentials.credential_version + 1,
       updated_at = now(),
       disabled_at = NULL
     RETURNING credential_version`,
    [normalized, hash]
  );
  return { ok: true, credentialVersion: Number(result.rows[0]?.credential_version || 1) };
}

export async function verifyAccountPassword({ accountId = "", password = "" } = {}) {
  const normalized = normalizedAccountId(accountId);
  let credential = null;
  if (!databaseEnabled()) {
    credential = runtimeCredentials.get(normalized) || null;
  } else if (normalized) {
    const result = await query(
      `SELECT password_hash, credential_version, disabled_at
         FROM account_password_credentials WHERE account_id = $1`,
      [normalized]
    );
    const row = result.rows[0];
    if (row) {
      credential = {
        passwordHash: row.password_hash,
        credentialVersion: Number(row.credential_version || 1),
        disabledAt: row.disabled_at,
      };
    }
  }
  const hash = credential?.passwordHash || await dummyHash();
  let valid = false;
  try {
    valid = await verify(hash, String(password || ""));
  } catch {
    valid = false;
  }
  if (!credential || credential.disabledAt || !valid) {
    return { ok: false, error: "password_login_invalid" };
  }
  const now = new Date().toISOString();
  const upgradedHash = passwordHashNeedsUpgrade(credential.passwordHash)
    ? await passwordHash(String(password || ""))
    : "";
  if (!databaseEnabled()) {
    credential.lastUsedAt = now;
    if (upgradedHash) {
      credential.passwordHash = upgradedHash;
      credential.updatedAt = now;
      credential.credentialVersion = Number(credential.credentialVersion || 0) + 1;
    }
    runtimeCredentials.set(normalized, credential);
  } else {
    await query(
      `UPDATE account_password_credentials SET
         last_used_at = now(),
         password_hash = CASE WHEN $2 = '' THEN password_hash ELSE $2 END,
         updated_at = CASE WHEN $2 = '' THEN updated_at ELSE now() END,
         credential_version = CASE WHEN $2 = '' THEN credential_version ELSE credential_version + 1 END
       WHERE account_id = $1`,
      [normalized, upgradedHash]
    );
  }
  return { ok: true, credentialVersion: Number(credential.credentialVersion || 1) };
}

export async function disableAccountPassword({ accountId = "" } = {}) {
  const normalized = normalizedAccountId(accountId);
  if (!normalized) return { ok: false, error: "password_account_required" };
  if (!databaseEnabled()) {
    const credential = runtimeCredentials.get(normalized);
    if (!credential || credential.disabledAt) return { ok: false, error: "password_not_enabled" };
    credential.disabledAt = new Date().toISOString();
    credential.updatedAt = credential.disabledAt;
    credential.credentialVersion = Number(credential.credentialVersion || 0) + 1;
    runtimeCredentials.set(normalized, credential);
    return { ok: true, credentialVersion: credential.credentialVersion };
  }
  const result = await query(
    `UPDATE account_password_credentials
        SET disabled_at = now(), updated_at = now(), credential_version = credential_version + 1
      WHERE account_id = $1 AND disabled_at IS NULL
      RETURNING credential_version`,
    [normalized]
  );
  if (!result.rows[0]) return { ok: false, error: "password_not_enabled" };
  return { ok: true, credentialVersion: Number(result.rows[0].credential_version || 1) };
}

export async function __resetRuntimePasswordCredentialsForTests() {
  runtimeCredentials.clear();
  dummyHashPromise = null;
}
