import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { listDailyAirdropDebt } from "../server/profile-daily-airdrop-issuance.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const suffix = `${Date.now()}`;
const accountId = `acct_airdrop_debt_${suffix}`;
const runId = `airdrop_debt_run_${suffix}`;
const issuanceId = `airdrop_debt_issue_${suffix}`;
const observabilityEventId = `uobs_airdrop_debt_${suffix}`;
const recipientWallet = Wallet.generate().classicAddress;
const sourceWallet = Wallet.generate().classicAddress;

async function cleanup() {
  await query("DELETE FROM profile_daily_airdrop_issuances WHERE id = $1", [issuanceId]);
  await query("DELETE FROM profile_daily_airdrop_runs WHERE id = $1", [runId]);
  await query("DELETE FROM user_observability_events WHERE id = $1", [observabilityEventId]);
}

async function main() {
  if (!databaseEnabled()) {
    console.log("profile daily airdrop debt smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  try {
    await query(
      `INSERT INTO user_observability_events (
         id, event_type, account_id, public_handle, source_surface, source_route, result_status
       )
       VALUES ($1, 'user.profile.identity_seen', $2, 'airdrop_debt_smoke', 'smoke', 'profile-daily-airdrop-debt-smoke', 'ok')`,
      [observabilityEventId, accountId]
    );
    await query(
      `INSERT INTO profile_daily_airdrop_runs (
         id, account_id, run_date, run_mode, is_canonical, status,
         daily_airdrop_pft, retention_value_score, what_raised_today,
         input_hash, input_snapshot, provider, model, prompt_version, prompt_digest,
         completed_at
       )
       VALUES (
         $1, $2, '2026-01-17'::date, 'production', true, 'completed',
         9, 80, 'debt smoke', 'sha256:debt-smoke',
         $3::jsonb, 'smoke', 'smoke', 'daily_airdrop_v1', 'sha256:prompt', now()
       )`,
      [
        runId,
        accountId,
        JSON.stringify({ airdrop_recipient: { wallet_address: recipientWallet } }),
      ]
    );
    await query(
      `INSERT INTO profile_daily_airdrop_issuances (
         id, account_id, run_id, run_date, source_wallet, recipient_wallet,
         amount_pft, amount_drops, status, attempt_count,
         last_error_code, last_error_message, updated_at
       )
       VALUES (
         $1, $2, $3, '2026-01-17'::date, $4, $5,
         9, '9000000', 'failed_before_submit', 1,
         'smoke_pre_submit', 'smoke pre-submit failure', now()
       )`,
      [issuanceId, accountId, runId, sourceWallet, recipientWallet]
    );

    const debt = await listDailyAirdropDebt({ sinceDate: "2026-01-17", limit: 10 });
    const row = debt.find((item) => item.issuanceId === issuanceId);
    assert.ok(row);
    assert.equal(row.kind, "issuance");
    assert.equal(row.publicHandle, "airdrop_debt_smoke");
    assert.equal(row.status, "failed_before_submit");
    assert.equal(row.retryable, true);
    assert.equal(row.nextAction, "retry_issuance");
    assert.equal(row.amountPft, 9);

    console.log("profile daily airdrop debt smoke ok");
  } finally {
    await cleanup().catch(() => null);
    await closePool().catch(() => null);
  }
}

main().catch(async (error) => {
  await cleanup().catch(() => null);
  await closePool().catch(() => null);
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
