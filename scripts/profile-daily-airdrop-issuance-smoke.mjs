import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  claimDailyAirdropIssuanceForPublish,
  markDailyAirdropIssuancePublishFailure,
} from "../server/profile-daily-airdrop-issuance.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

process.env.TASKNODE_DAILY_AIRDROP_SEED ||= Wallet.generate().seed;

const suffix = `${Date.now()}`;
const accountId = `acct_airdrop_issuance_${suffix}`;
const runId = `airdrop_run_${suffix}`;
const retryAccountId = `acct_airdrop_retry_${suffix}`;
const retryRunId = `airdrop_run_retry_${suffix}`;
const recipientWallet = Wallet.generate().classicAddress;

async function cleanup() {
  await query("DELETE FROM profile_daily_airdrop_issuances WHERE account_id = ANY($1::text[])", [
    [accountId, retryAccountId],
  ]);
  await query("DELETE FROM profile_daily_airdrop_runs WHERE account_id = ANY($1::text[])", [[accountId, retryAccountId]]);
}

async function insertCompletedRun({ id = runId, account = accountId } = {}) {
  await query(
    `INSERT INTO profile_daily_airdrop_runs (
       id, account_id, run_date, run_mode, is_canonical, status,
       daily_airdrop_pft, retention_value_score, what_raised_today,
       input_hash, input_snapshot, provider, model, prompt_version, prompt_digest,
       completed_at
     )
     VALUES (
       $1, $2, timezone('UTC', now())::date, 'dry_run', false, 'completed',
       42, 80, 'smoke', 'sha256:airdrop-smoke',
       $3::jsonb, 'smoke', 'smoke', 'daily_airdrop_v1', 'sha256:prompt', now()
     )`,
    [
      id,
      account,
      JSON.stringify({
        airdrop_recipient: {
          wallet_address: recipientWallet,
        },
      }),
    ]
  );
}

async function main() {
  if (!databaseEnabled()) {
    console.log("profile daily airdrop issuance smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  try {
    await insertCompletedRun();

    const firstClaim = await claimDailyAirdropIssuanceForPublish({ accountId, runId });
    assert.equal(firstClaim.alreadySubmitted, false);
    assert.equal(firstClaim.issuance.status, "processing_pre_submit");
    assert.equal(firstClaim.issuance.recipient_wallet, recipientWallet);

    await assert.rejects(
      () => claimDailyAirdropIssuanceForPublish({ accountId, runId }),
      /daily_airdrop_issuance_blocked:processing_pre_submit/
    );

    await markDailyAirdropIssuancePublishFailure({
      issuanceId: firstClaim.issuance.id,
      error: new Error("smoke_submit_timeout"),
      submissionAttempted: true,
    });
    await assert.rejects(
      () => claimDailyAirdropIssuanceForPublish({ accountId, runId }),
      /daily_airdrop_issuance_blocked:submit_unknown/
    );

    await query(
      `UPDATE profile_daily_airdrop_issuances
          SET status = 'submitted',
              tx_hash = 'AIR_DROP_ISSUANCE_SMOKE_TX',
              source_cid = 'QmAirdropIssuanceSmoke',
              payload_digest = 'sha256:airdrop-issuance-smoke',
              submitted_at = now(),
              completed_at = now(),
              updated_at = now()
        WHERE run_id = $1`,
      [runId]
    );

    const replayClaim = await claimDailyAirdropIssuanceForPublish({ accountId, runId });
    assert.equal(replayClaim.alreadySubmitted, true);
    assert.equal(replayClaim.issuance.status, "submitted");
    assert.equal(replayClaim.issuance.tx_hash, "AIR_DROP_ISSUANCE_SMOKE_TX");

    await insertCompletedRun({ id: retryRunId, account: retryAccountId });
    const retryClaim = await claimDailyAirdropIssuanceForPublish({
      accountId: retryAccountId,
      runId: retryRunId,
    });
    await markDailyAirdropIssuancePublishFailure({
      issuanceId: retryClaim.issuance.id,
      error: new Error("smoke_pre_submit_error"),
      submissionAttempted: false,
    });
    const retryAfterSafeFailure = await claimDailyAirdropIssuanceForPublish({
      accountId: retryAccountId,
      runId: retryRunId,
    });
    assert.equal(retryAfterSafeFailure.alreadySubmitted, false);
    assert.equal(retryAfterSafeFailure.issuance.status, "processing_pre_submit");
    assert.equal(retryAfterSafeFailure.issuance.attempt_count, 2);

    console.log("profile daily airdrop issuance smoke ok");
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
