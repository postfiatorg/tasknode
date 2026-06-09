import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  claimDailyAirdropIssuanceForPublish,
  listDailyAirdropDebt,
  listOrphanedDailyAirdropRuns,
  listRetryableDailyAirdropIssuances,
  recoverStaleDailyAirdropIssuances,
} from "../server/profile-daily-airdrop-issuance.js";
import { reclaimStaleDailyAirdropRuns } from "../server/repositories/profile-daily-airdrop.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

process.env.TASKNODE_DAILY_AIRDROP_SEED ||= Wallet.generate().seed;

const suffix = `${Date.now()}`;
const accountId = `acct_airdrop_recovery_${suffix}`;
const runIds = [
  `airdrop_recovery_running_${suffix}`,
  `airdrop_recovery_presubmit_${suffix}`,
  `airdrop_recovery_submitting_${suffix}`,
  `airdrop_recovery_orphan_${suffix}`,
];
const orphanRunId = runIds[3];
const issuanceIds = [
  `airdrop_issue_presubmit_${suffix}`,
  `airdrop_issue_submitting_${suffix}`,
];
const recipientWallet = Wallet.generate().classicAddress;

async function cleanup() {
  await query("DELETE FROM profile_daily_airdrop_issuances WHERE id = ANY($1::text[])", [issuanceIds]);
  await query("DELETE FROM profile_daily_airdrop_issuances WHERE run_id = ANY($1::text[])", [runIds]);
  await query("DELETE FROM profile_daily_airdrop_runs WHERE id = ANY($1::text[])", [runIds]);
}

async function insertRun({
  id,
  runDate = "2026-01-15",
  status = "completed",
  dailyAirdropPft = 12,
  updatedAt = "now() - interval '2 hours'",
} = {}) {
  await query(
    `INSERT INTO profile_daily_airdrop_runs (
       id, account_id, run_date, run_mode, is_canonical, status,
       daily_airdrop_pft, retention_value_score, what_raised_today,
       input_hash, input_snapshot, provider, model, prompt_version, prompt_digest,
       updated_at, completed_at
     )
     VALUES (
       $1, $2, $3::date, 'production', true, $4,
       $5, 80, 'recovery smoke', 'sha256:recovery-smoke',
       $6::jsonb, 'smoke', 'smoke', 'daily_airdrop_v1', 'sha256:prompt',
       ${updatedAt}, CASE WHEN $4 = 'completed' THEN ${updatedAt} ELSE NULL END
     )`,
    [
      id,
      `${accountId}_${id}`,
      runDate,
      status,
      dailyAirdropPft,
      JSON.stringify({ airdrop_recipient: { wallet_address: recipientWallet } }),
    ]
  );
}

async function insertIssuance({
  id,
  runId,
  status,
  submissionAttempted = false,
} = {}) {
  await query(
    `INSERT INTO profile_daily_airdrop_issuances (
       id, account_id, run_id, run_date, source_wallet, recipient_wallet,
       amount_pft, amount_drops, status, attempt_count,
       submission_attempted_at, updated_at
     )
     SELECT $1, account_id, id, run_date, $2, $3, 12, '12000000', $4, 1,
            CASE WHEN $5 THEN now() - interval '2 hours' ELSE NULL END,
            now() - interval '2 hours'
       FROM profile_daily_airdrop_runs
      WHERE id = $6`,
    [id, Wallet.generate().classicAddress, recipientWallet, status, Boolean(submissionAttempted), runId]
  );
}

async function main() {
  if (!databaseEnabled()) {
    console.log("profile daily airdrop recovery smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  try {
    await insertRun({ id: runIds[0], status: "running" });
    await insertRun({ id: runIds[1] });
    await insertRun({ id: runIds[2] });
    await insertRun({ id: orphanRunId });
    await insertIssuance({ id: issuanceIds[0], runId: runIds[1], status: "processing_pre_submit" });
    await insertIssuance({
      id: issuanceIds[1],
      runId: runIds[2],
      status: "submitting",
      submissionAttempted: true,
    });

    const recoveredRuns = await reclaimStaleDailyAirdropRuns({ staleMinutes: 30, limit: 10 });
    assert.equal(recoveredRuns.length, 1);
    assert.equal(recoveredRuns[0].status, "failed");

    const recoveredIssuances = await recoverStaleDailyAirdropIssuances({
      preSubmitStaleMinutes: 30,
      submittingStaleMinutes: 30,
      limit: 10,
    });
    assert.equal(recoveredIssuances.preSubmit.length, 1);
    assert.equal(recoveredIssuances.preSubmit[0].status, "failed_before_submit");
    assert.equal(recoveredIssuances.submitting.length, 1);
    assert.equal(recoveredIssuances.submitting[0].status, "submit_unknown");

    const debt = await listDailyAirdropDebt({ sinceDate: "2026-01-15", limit: 10 });
    assert.ok(debt.some((item) => item.issuanceId === issuanceIds[0] && item.nextAction === "retry_issuance"));
    assert.ok(debt.some((item) => item.issuanceId === issuanceIds[1] && item.nextAction === "reconcile_before_retry"));
    assert.ok(
      debt.some((item) => item.runId === orphanRunId && item.kind === "issuance_missing" && item.nextAction === "retry_issuance"),
      "orphaned completed run must appear as missing-issuance debt"
    );

    const retryable = await listRetryableDailyAirdropIssuances({ runDate: "2026-01-15", limit: 10 });
    assert.ok(
      !retryable.some((item) => item.runId === orphanRunId),
      "orphaned run has no issuance row, so the issuance retry list cannot recover it"
    );

    const orphans = await listOrphanedDailyAirdropRuns({ runDate: "2026-01-15", limit: 10 });
    const orphan = orphans.find((item) => item.runId === orphanRunId);
    assert.ok(orphan, "orphaned completed run must be listed for recovery");
    assert.equal(orphan.recipientWallet, recipientWallet);
    assert.equal(orphan.amountPft, 12);
    assert.ok(
      !orphans.some((item) => item.runId === runIds[1] || item.runId === runIds[2]),
      "runs that already have issuance rows are not orphans"
    );

    const claim = await claimDailyAirdropIssuanceForPublish({
      accountId: orphan.accountId,
      runId: orphan.runId,
    });
    assert.equal(claim.issuance.status, "processing_pre_submit");
    assert.equal(claim.issuance.run_id, orphanRunId);

    const orphansAfterClaim = await listOrphanedDailyAirdropRuns({ runDate: "2026-01-15", limit: 10 });
    assert.ok(
      !orphansAfterClaim.some((item) => item.runId === orphanRunId),
      "claimed run is no longer an orphan"
    );

    console.log("profile daily airdrop recovery smoke ok");
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
