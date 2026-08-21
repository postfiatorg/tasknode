#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) throw new Error("profile_account_recovery_smoke_database_url_required");
process.env.TASKNODE_DATABASE_ENABLED = "true";

const { closePool, transaction } = await import("../server/db/pool.js");
const profileMigration = await readFile(new URL("../server/db/migrations/121_recover_profile_accounts.sql", import.meta.url), "utf8");
const observedHandleMigration = await readFile(new URL("../server/db/migrations/122_recover_observed_account_handles.sql", import.meta.url), "utf8");
const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const accountId = `acct_recovery_smoke_${suffix}`;
const handle = `recovery-${Math.random().toString(36).slice(2, 10)}`;

try {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO recommended_connection_profiles (
         account_id, wallet_address, display_name, hive_handle, visibility, discoverable,
         embedding_model, embedding
       ) VALUES ($1, $2, $3, $4, 'public', true, 'recovery-smoke',
         array_fill(0::real, ARRAY[1536])::vector)`,
      [accountId, `rRecoverySmoke${suffix}`, "Recovery Smoke", handle]
    );
    await client.query(profileMigration);
    const recovered = await client.query(
      "SELECT account_json, hive_handle FROM app_accounts WHERE account_id = $1",
      [accountId]
    );
    assert.equal(recovered.rows.length, 1, "durable profile census must restore a missing app account");
    assert.equal(recovered.rows[0].hive_handle, handle);
    assert.equal(recovered.rows[0].account_json.recoverySource, "durable_profile_census");
    assert.equal(recovered.rows[0].account_json.profileVisibility, "public");
    throw Object.assign(new Error("rollback_profile_account_recovery_smoke"), { expectedRollback: true });
  }).catch((error) => {
    if (!error?.expectedRollback) throw error;
  });

  await transaction(async (client) => {
    const observedAccountId = `acct_observed_recovery_smoke_${suffix}`;
    const observedHandle = `observed-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    await client.query(
      `INSERT INTO app_accounts (account_id, account_json, status, created_at, updated_at)
       VALUES ($1, $2::jsonb, 'active', $3, $3)`,
      [observedAccountId, JSON.stringify({ id: observedAccountId, displayName: "Observed Recovery", linkedProviders: [] }), now]
    );
    await client.query(
      `INSERT INTO auth_sessions (
         token_hash, account_id, primary_provider, assurance, session_json, created_at, expires_at
       ) VALUES ($1, $2, 'github', 'medium', $3::jsonb, $4, $5)`,
      [`observed-recovery-${suffix}`, observedAccountId, JSON.stringify({ accountId: observedAccountId, hiveHandle: "" }), now, expiresAt]
    );
    await client.query(
      `INSERT INTO user_observability_events (
         id, occurred_at, event_type, account_id, public_handle, result_status
       ) VALUES ($1, $2, 'user.session.started', $3, $4, 'started')`,
      [`observed-recovery-event-${suffix}`, now, observedAccountId, observedHandle]
    );
    await client.query(observedHandleMigration);
    const recovered = await client.query(
      `SELECT accounts.hive_handle, accounts.account_json, sessions.session_json
       FROM app_accounts accounts
       JOIN auth_sessions sessions ON sessions.account_id = accounts.account_id
       WHERE accounts.account_id = $1`,
      [observedAccountId]
    );
    assert.equal(recovered.rows[0].hive_handle, observedHandle);
    assert.equal(recovered.rows[0].account_json.hiveHandle, observedHandle);
    assert.equal(recovered.rows[0].session_json.hiveHandle, observedHandle, "live sessions must stop prompting immediately");
    throw Object.assign(new Error("rollback_observed_handle_recovery_smoke"), { expectedRollback: true });
  }).catch((error) => {
    if (!error?.expectedRollback) throw error;
  });

  await transaction(async (client) => {
    const ambiguousAccountId = `acct_ambiguous_recovery_smoke_${suffix}`;
    const conflictOwnerId = `acct_conflict_owner_smoke_${suffix}`;
    const conflictAccountId = `acct_conflict_recovery_smoke_${suffix}`;
    const conflictHandle = `owned-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date();
    for (const [id, ownedHandle] of [
      [ambiguousAccountId, ""],
      [conflictOwnerId, conflictHandle],
      [conflictAccountId, ""],
    ]) {
      await client.query(
        `INSERT INTO app_accounts (account_id, account_json, hive_handle, status, created_at, updated_at)
         VALUES ($1, $2::jsonb, nullif($3, ''), 'active', $4, $4)`,
        [id, JSON.stringify({ id, ...(ownedHandle ? { hiveHandle: ownedHandle } : {}), linkedProviders: [] }), ownedHandle, now]
      );
    }
    await client.query(
      `INSERT INTO user_observability_events (
         id, occurred_at, event_type, account_id, public_handle, result_status
       ) VALUES
         ($1, $2, 'user.session.started', $3, 'first-observed', 'started'),
         ($4, $2, 'user.session.started', $3, 'second-observed', 'started'),
         ($5, $2, 'user.session.started', $6, $7, 'started')`,
      [
        `ambiguous-recovery-a-${suffix}`, now, ambiguousAccountId,
        `ambiguous-recovery-b-${suffix}`,
        `conflict-recovery-${suffix}`, conflictAccountId, conflictHandle,
      ]
    );
    await client.query(observedHandleMigration);
    const unrecovered = await client.query(
      "SELECT account_id, hive_handle FROM app_accounts WHERE account_id = ANY($1::text[]) ORDER BY account_id",
      [[ambiguousAccountId, conflictAccountId]]
    );
    assert.equal(unrecovered.rows.length, 2);
    assert.ok(unrecovered.rows.every((row) => !row.hive_handle), "ambiguous or already-owned handles must never be restored automatically");
    throw Object.assign(new Error("rollback_observed_handle_guard_smoke"), { expectedRollback: true });
  }).catch((error) => {
    if (!error?.expectedRollback) throw error;
  });

  console.log("profile account recovery smoke ok: durable profiles and unambiguous observed handles restore account identity transactionally");
} finally {
  await closePool();
}
