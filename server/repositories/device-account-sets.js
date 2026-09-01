import { createHash, randomBytes, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  attachRuntimeSessionToDeviceAccountSet,
  revokeRuntimeSessionsForDeviceAccountSet,
} from "../runtime-store.js";

export const deviceAccountSetTtlSeconds = 60 * 60 * 24 * 30;

const runtimeSetsByHash = new Map();
const runtimeSetsById = new Map();

function tokenHash(token = "") {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

function normalizedAccountId(value = "") {
  return String(value || "").trim();
}

function runtimeActiveSet(token = "") {
  const set = runtimeSetsByHash.get(tokenHash(token));
  if (!set || set.revokedAt || Date.parse(set.expiresAt) <= Date.now()) return null;
  return set;
}

function rotateRuntimeSet(set) {
  runtimeSetsByHash.delete(set.tokenHash);
  const token = newToken();
  set.tokenHash = tokenHash(token);
  set.rotationVersion += 1;
  set.lastUsedAt = new Date().toISOString();
  runtimeSetsByHash.set(set.tokenHash, set);
  return token;
}

export async function ensureDeviceAccountSet({ token = "", accountId = "", metadata = {} } = {}) {
  const normalized = normalizedAccountId(accountId);
  if (!normalized) return { ok: false, error: "account_set_account_required" };
  if (!databaseEnabled()) {
    let set = runtimeActiveSet(token);
    if (!set) {
      const setId = randomUUID();
      const createdAt = new Date().toISOString();
      set = {
        setId,
        tokenHash: "",
        metadata: { ...metadata },
        rotationVersion: 0,
        createdAt,
        lastUsedAt: createdAt,
        expiresAt: new Date(Date.now() + deviceAccountSetTtlSeconds * 1000).toISOString(),
        revokedAt: null,
        members: new Map(),
      };
      runtimeSetsById.set(setId, set);
    }
    const now = new Date().toISOString();
    const prior = set.members.get(normalized);
    const added = !prior || Boolean(prior.revokedAt);
    set.members.set(normalized, {
      accountId: normalized,
      addedAt: prior?.addedAt || now,
      lastAuthenticatedAt: now,
      lastSelectedAt: prior?.lastSelectedAt || now,
      revokedAt: null,
    });
    return { ok: true, setId: set.setId, token: rotateRuntimeSet(set), adapter: "runtime", added };
  }

  return transaction(async (client) => {
    let row = null;
    if (token) {
      const found = await client.query(
        `SELECT set_id, rotation_version
           FROM device_account_sets
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [tokenHash(token)]
      );
      row = found.rows[0] || null;
    }
    const setId = row?.set_id || randomUUID();
    const replacementToken = newToken();
    if (row) {
      await client.query(
        `UPDATE device_account_sets
            SET token_hash = $2, rotation_version = rotation_version + 1,
                last_used_at = now(), expires_at = now() + ($3 * interval '1 second')
          WHERE set_id = $1`,
        [setId, tokenHash(replacementToken), deviceAccountSetTtlSeconds]
      );
    } else {
      await client.query(
        `INSERT INTO device_account_sets (
           set_id, token_hash, metadata_json, expires_at
         ) VALUES ($1, $2, $3::jsonb, now() + ($4 * interval '1 second'))`,
        [setId, tokenHash(replacementToken), JSON.stringify(metadata || {}), deviceAccountSetTtlSeconds]
      );
    }
    const priorMember = await client.query(
      "SELECT revoked_at FROM device_account_set_members WHERE set_id = $1 AND account_id = $2 FOR UPDATE",
      [setId, normalized]
    );
    const added = !priorMember.rows[0] || Boolean(priorMember.rows[0].revoked_at);
    await client.query(
      `INSERT INTO device_account_set_members (
         set_id, account_id, added_at, last_authenticated_at, last_selected_at, revoked_at
       ) VALUES ($1, $2, now(), now(), now(), NULL)
       ON CONFLICT (set_id, account_id) DO UPDATE SET
         last_authenticated_at = now(), last_selected_at = now(), revoked_at = NULL`,
      [setId, normalized]
    );
    return { ok: true, setId, token: replacementToken, adapter: "postgres", added };
  });
}

export async function resolveDeviceAccountSet({ token = "" } = {}) {
  if (!token) return null;
  if (!databaseEnabled()) {
    const set = runtimeActiveSet(token);
    return set ? { setId: set.setId, rotationVersion: set.rotationVersion } : null;
  }
  const result = await query(
    `SELECT set_id, rotation_version FROM device_account_sets
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash(token)]
  );
  return result.rows[0]
    ? { setId: result.rows[0].set_id, rotationVersion: Number(result.rows[0].rotation_version || 1) }
    : null;
}

export async function listDeviceAccounts({ token = "", selectedAccountId = "" } = {}) {
  const set = await resolveDeviceAccountSet({ token });
  if (!set) return { ok: false, error: "account_switch_membership_required", accounts: [] };
  if (!databaseEnabled()) {
    const runtime = runtimeSetsById.get(set.setId);
    const accounts = Array.from(runtime?.members.values() || [])
      .filter((member) => !member.revokedAt)
      .sort((left, right) => String(right.lastSelectedAt || "").localeCompare(String(left.lastSelectedAt || "")))
      .map((member) => ({ accountId: member.accountId, selected: member.accountId === selectedAccountId }));
    return { ok: true, setId: set.setId, accounts };
  }
  const result = await query(
    `SELECT members.account_id, members.added_at, members.last_authenticated_at,
            members.last_selected_at, accounts.account_json,
            wallets.wallet_address
       FROM device_account_set_members members
       JOIN app_accounts accounts ON accounts.account_id = members.account_id
       LEFT JOIN account_linked_wallets wallets
         ON wallets.account_id = members.account_id AND wallets.status = 'linked'
      WHERE members.set_id = $1 AND members.revoked_at IS NULL
      ORDER BY members.last_selected_at DESC NULLS LAST, members.added_at DESC`,
    [set.setId]
  );
  return {
    ok: true,
    setId: set.setId,
    accounts: result.rows.map((row) => ({
      accountId: row.account_id,
      selected: row.account_id === selectedAccountId,
      displayName: row.account_json?.publicDisplayName || row.account_json?.displayName || "Member",
      hiveHandle: row.account_json?.hiveHandle || "",
      maskedEmail: row.account_json?.primaryEmailCanonical
        ? `${String(row.account_json.primaryEmailCanonical).slice(0, 1)}***${String(row.account_json.primaryEmailCanonical).slice(String(row.account_json.primaryEmailCanonical).lastIndexOf("@"))}`
        : "",
      walletAddress: row.wallet_address || "",
      addedAt: row.added_at ? new Date(row.added_at).toISOString() : null,
      lastSelectedAt: row.last_selected_at ? new Date(row.last_selected_at).toISOString() : null,
    })),
  };
}

export async function selectDeviceAccount({ token = "", accountId = "" } = {}) {
  const normalized = normalizedAccountId(accountId);
  const set = await resolveDeviceAccountSet({ token });
  if (!set || !normalized) return { ok: false, error: "account_switch_membership_required" };
  if (!databaseEnabled()) {
    const runtime = runtimeSetsById.get(set.setId);
    const member = runtime?.members.get(normalized);
    if (!member || member.revokedAt) return { ok: false, error: "account_switch_membership_required" };
    member.lastSelectedAt = new Date().toISOString();
    return { ok: true, setId: set.setId, token: rotateRuntimeSet(runtime) };
  }
  return transaction(async (client) => {
    const member = await client.query(
      `SELECT account_id FROM device_account_set_members
        WHERE set_id = $1 AND account_id = $2 AND revoked_at IS NULL FOR UPDATE`,
      [set.setId, normalized]
    );
    if (!member.rows[0]) return { ok: false, error: "account_switch_membership_required" };
    await client.query(
      "UPDATE device_account_set_members SET last_selected_at = now() WHERE set_id = $1 AND account_id = $2",
      [set.setId, normalized]
    );
    const replacementToken = newToken();
    await client.query(
      `UPDATE device_account_sets
          SET token_hash = $2, rotation_version = rotation_version + 1,
              last_used_at = now(), expires_at = now() + ($3 * interval '1 second')
        WHERE set_id = $1`,
      [set.setId, tokenHash(replacementToken), deviceAccountSetTtlSeconds]
    );
    return { ok: true, setId: set.setId, token: replacementToken };
  });
}

export async function removeDeviceAccount({ token = "", accountId = "" } = {}) {
  const normalized = normalizedAccountId(accountId);
  const set = await resolveDeviceAccountSet({ token });
  if (!set || !normalized) return { ok: false, error: "account_switch_membership_required" };
  if (!databaseEnabled()) {
    const runtime = runtimeSetsById.get(set.setId);
    const member = runtime?.members.get(normalized);
    if (!member || member.revokedAt) return { ok: false, error: "account_switch_membership_required" };
    member.revokedAt = new Date().toISOString();
    const sessions = revokeRuntimeSessionsForDeviceAccountSet({ setId: set.setId, accountId: normalized });
    return { ok: true, setId: set.setId, revokedSessions: sessions.revoked };
  }
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE device_account_set_members SET revoked_at = now()
        WHERE set_id = $1 AND account_id = $2 AND revoked_at IS NULL
        RETURNING account_id`,
      [set.setId, normalized]
    );
    if (!result.rows[0]) return { ok: false, error: "account_switch_membership_required" };
    const sessions = await client.query(
      `UPDATE auth_sessions SET revoked_at = now()
        WHERE device_account_set_id = $1 AND account_id = $2 AND revoked_at IS NULL`,
      [set.setId, normalized]
    );
    return { ok: true, setId: set.setId, revokedSessions: sessions.rowCount };
  });
}

export async function attachSessionToDeviceAccountSet({ sessionId = "", setId = "" } = {}) {
  if (!sessionId || !setId) return { attached: false };
  if (!databaseEnabled()) return attachRuntimeSessionToDeviceAccountSet({ sessionId, setId });
  const result = await query(
    "UPDATE auth_sessions SET device_account_set_id = $2 WHERE token_hash = $1",
    [tokenHash(sessionId), setId]
  );
  return { attached: result.rowCount > 0 };
}

export async function revokeDeviceAccountSet({ token = "" } = {}) {
  const set = await resolveDeviceAccountSet({ token });
  if (!set) return { ok: true, revokedSessions: 0 };
  if (!databaseEnabled()) {
    const runtime = runtimeSetsById.get(set.setId);
    if (runtime) runtime.revokedAt = new Date().toISOString();
    const sessions = revokeRuntimeSessionsForDeviceAccountSet({ setId: set.setId });
    return { ok: true, revokedSessions: sessions.revoked };
  }
  return transaction(async (client) => {
    await client.query("UPDATE device_account_sets SET revoked_at = now() WHERE set_id = $1", [set.setId]);
    const sessions = await client.query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE device_account_set_id = $1 AND revoked_at IS NULL",
      [set.setId]
    );
    return { ok: true, revokedSessions: sessions.rowCount };
  });
}

export async function __resetRuntimeDeviceAccountSetsForTests() {
  runtimeSetsByHash.clear();
  runtimeSetsById.clear();
}
