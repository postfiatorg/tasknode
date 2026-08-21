import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { listDailyAirdropDebt } from "../server/profile-daily-airdrop-issuance.js";
import {
  DAILY_AIRDROP_DEBT_SUMMARY_SQL,
  dailyAirdropDebtStaleThresholds,
} from "../server/system-status.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const suffix = `${Date.now()}`;
const accountId = `acct_airdrop_debt_${suffix}`;
const runId = `airdrop_debt_run_${suffix}`;
const issuanceId = `airdrop_debt_issue_${suffix}`;
const orphanAccountId = `acct_airdrop_debt_orphan_${suffix}`;
const orphanRunId = `airdrop_debt_orphan_run_${suffix}`;
const failedScoringAccountId = `acct_airdrop_debt_scorefail_${suffix}`;
const failedScoringRunId = `airdrop_debt_scorefail_run_${suffix}`;
const freshRunningAccountId = `acct_airdrop_debt_running_${suffix}`;
const freshRunningRunId = `airdrop_debt_running_run_${suffix}`;
const freshPreSubmitAccountId = `acct_airdrop_debt_presubmit_${suffix}`;
const freshPreSubmitRunId = `airdrop_debt_presubmit_run_${suffix}`;
const freshPreSubmitIssuanceId = `airdrop_debt_presubmit_issue_${suffix}`;
const observabilityEventId = `uobs_airdrop_debt_${suffix}`;
const recipientWallet = Wallet.generate().classicAddress;
const sourceWallet = Wallet.generate().classicAddress;

async function cleanup() {
  await query("DELETE FROM profile_daily_airdrop_issuances WHERE id = ANY($1::text[])", [
    [issuanceId, freshPreSubmitIssuanceId],
  ]);
  await query("DELETE FROM profile_daily_airdrop_runs WHERE id = ANY($1::text[])", [
    [runId, orphanRunId, failedScoringRunId, freshRunningRunId, freshPreSubmitRunId],
  ]);
  await query("DELETE FROM user_observability_events WHERE id = $1", [observabilityEventId]);
}

async function debtSummary() {
  const { scoringStaleMinutes, preSubmitStaleMinutes } = dailyAirdropDebtStaleThresholds();
  const result = await query(DAILY_AIRDROP_DEBT_SUMMARY_SQL, [scoringStaleMinutes, preSubmitStaleMinutes]);
  return result.rows[0];
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

    await query(
      `INSERT INTO profile_daily_airdrop_runs (
         id, account_id, run_date, run_mode, is_canonical, status,
         daily_airdrop_pft, retention_value_score, what_raised_today,
         input_hash, input_snapshot, provider, model, prompt_version, prompt_digest,
         completed_at
       )
       VALUES (
         $1, $2, '2026-01-17'::date, 'production', true, 'completed',
         7, 80, 'debt smoke orphan', 'sha256:debt-smoke-orphan',
         $3::jsonb, 'smoke', 'smoke', 'daily_airdrop_v1', 'sha256:prompt', now()
       )`,
      [
        orphanRunId,
        orphanAccountId,
        JSON.stringify({ airdrop_recipient: { wallet_address: recipientWallet } }),
      ]
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

    const orphanRow = debt.find((item) => item.runId === orphanRunId);
    assert.ok(orphanRow, "completed positive run with no issuance row must appear as debt");
    assert.equal(orphanRow.kind, "issuance_missing");
    assert.equal(orphanRow.status, "missing_issuance");
    assert.equal(orphanRow.issuanceId, "");
    assert.equal(orphanRow.retryable, true);
    assert.equal(orphanRow.nextAction, "retry_issuance");
    assert.equal(orphanRow.amountPft, 7);
    assert.equal(orphanRow.recipientWallet, recipientWallet);

    // A failed production scoring run must keep its raw run status so the
    // repair action is retry_scoring, never retry_issuance.
    await query(
      `INSERT INTO profile_daily_airdrop_runs (
         id, account_id, run_date, run_mode, is_canonical, status,
         daily_airdrop_pft, retention_value_score,
         input_hash, input_snapshot, provider, model, prompt_version, prompt_digest,
         error_message, completed_at
       )
       VALUES (
         $1, $2, '2026-01-17'::date, 'production', true, 'failed',
         0, 0,
         'sha256:debt-smoke-scorefail', '{}'::jsonb, 'smoke', 'smoke', 'daily_airdrop_v1', 'sha256:prompt',
         'daily_airdrop_model_output_not_json', now()
       )`,
      [failedScoringRunId, failedScoringAccountId]
    );
    const debtWithFailedScoring = await listDailyAirdropDebt({ sinceDate: "2026-01-17", limit: 20 });
    const failedScoringRow = debtWithFailedScoring.find((item) => item.runId === failedScoringRunId);
    assert.ok(failedScoringRow, "failed production scoring run must appear as debt");
    assert.equal(failedScoringRow.kind, "scoring");
    assert.equal(failedScoringRow.status, "failed");
    assert.equal(failedScoringRow.nextAction, "retry_scoring");

    // System-status debt predicate: fresh in-flight rows are not debt; rows older
    // than the worker stale thresholds are.
    const baseSummary = await debtSummary();
    assert.equal(Number(baseSummary.scoring_debt_count) >= 1, true, "failed scoring run counts as scoring debt");

    await query(
      `INSERT INTO profile_daily_airdrop_runs (
         id, account_id, run_date, run_mode, is_canonical, status,
         daily_airdrop_pft, retention_value_score,
         input_hash, input_snapshot, provider, model, prompt_version, prompt_digest
       )
       VALUES (
         $1, $2, '2026-01-17'::date, 'production', true, 'running',
         0, 0,
         'sha256:debt-smoke-running', '{}'::jsonb, 'smoke', 'smoke', 'daily_airdrop_v1', 'sha256:prompt'
       )`,
      [freshRunningRunId, freshRunningAccountId]
    );
    await query(
      `INSERT INTO profile_daily_airdrop_runs (
         id, account_id, run_date, run_mode, is_canonical, status,
         daily_airdrop_pft, retention_value_score,
         input_hash, input_snapshot, provider, model, prompt_version, prompt_digest,
         completed_at
       )
       VALUES (
         $1, $2, '2026-01-17'::date, 'production', true, 'completed',
         11, 80,
         'sha256:debt-smoke-presubmit', $3::jsonb, 'smoke', 'smoke', 'daily_airdrop_v1', 'sha256:prompt', now()
       )`,
      [
        freshPreSubmitRunId,
        freshPreSubmitAccountId,
        JSON.stringify({ airdrop_recipient: { wallet_address: recipientWallet } }),
      ]
    );
    await query(
      `INSERT INTO profile_daily_airdrop_issuances (
         id, account_id, run_id, run_date, source_wallet, recipient_wallet,
         amount_pft, amount_drops, status, attempt_count, updated_at
       )
       VALUES (
         $1, $2, $3, '2026-01-17'::date, $4, $5,
         11, '11000000', 'processing_pre_submit', 1, now()
       )`,
      [freshPreSubmitIssuanceId, freshPreSubmitAccountId, freshPreSubmitRunId, sourceWallet, recipientWallet]
    );

    const freshSummary = await debtSummary();
    assert.equal(
      Number(freshSummary.scoring_debt_count),
      Number(baseSummary.scoring_debt_count),
      "a fresh running scoring run must not count as debt"
    );
    assert.equal(
      Number(freshSummary.issuance_debt_count),
      Number(baseSummary.issuance_debt_count),
      "a fresh processing_pre_submit issuance must not count as debt"
    );
    assert.equal(
      Number(freshSummary.blocked_count),
      Number(baseSummary.blocked_count),
      "fresh in-flight rows must not count as blocked debt"
    );

    await query(
      "UPDATE profile_daily_airdrop_runs SET updated_at = now() - interval '2 hours' WHERE id = $1",
      [freshRunningRunId]
    );
    await query(
      "UPDATE profile_daily_airdrop_issuances SET updated_at = now() - interval '2 hours' WHERE id = $1",
      [freshPreSubmitIssuanceId]
    );
    const staleSummary = await debtSummary();
    assert.equal(
      Number(staleSummary.scoring_debt_count),
      Number(baseSummary.scoring_debt_count) + 1,
      "a 2h-old running scoring run must count as debt"
    );
    assert.equal(
      Number(staleSummary.issuance_debt_count),
      Number(baseSummary.issuance_debt_count) + 1,
      "a 2h-old processing_pre_submit issuance must count as debt"
    );
    assert.equal(
      Number(staleSummary.blocked_count),
      Number(baseSummary.blocked_count) + 2,
      "stale running and stale pre-submit rows count as blocked debt"
    );

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
