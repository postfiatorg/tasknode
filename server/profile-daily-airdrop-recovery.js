import { query } from "./db/pool.js";
import { assertDailyAirdropPaymentAllowed, dailyAirdropRecoveryDigest } from "./profile-daily-airdrop-guard.js";
import { dailyAirdropIssuanceRetryable } from "./profile-daily-airdrop-issuance-state.js";
import { dailyAirdropDigest, dailyAirdropPftToDrops } from "./profile-daily-airdrop-payload.js";
import { issueLatestDailyAirdrop } from "./profile-daily-airdrop-issuance.js";

export async function recoverDailyAirdropDebt({ runId, execute = false, expectedDigest = "" }, {
  read = query, issue = issueLatestDailyAirdrop,
} = {}) {
  if (!runId) throw new Error("daily_airdrop_exact_run_required");
  const found = await read(`SELECT row_to_json(r) AS run, row_to_json(i) AS issuance,
    (SELECT hive_handle FROM app_accounts a WHERE a.account_id=r.account_id) AS handle
    FROM profile_daily_airdrop_runs r JOIN profile_daily_airdrop_issuances i ON i.run_id=r.id
    WHERE r.id=$1`, [runId]);
  const { run, issuance, handle } = found.rows[0] || {};
  if (!run || !issuance) throw new Error("daily_airdrop_recovery_target_missing");
  const recipientWallet = run.input_snapshot?.airdrop_recipient?.wallet_address || "";
  const previewDigest = dailyAirdropRecoveryDigest(run, issuance);
  const preview = { runId, issuanceId: issuance.id, accountId: run.account_id, handle: handle || "",
    recipient: recipientWallet ? `${recipientWallet.slice(0, 5)}…${recipientWallet.slice(-4)}` : "",
    recipientDigest: dailyAirdropDigest(recipientWallet), amountPft: Number(run.daily_airdrop_pft),
    amountDrops: dailyAirdropPftToDrops(run.daily_airdrop_pft), status: issuance.status,
    attemptCount: issuance.attempt_count, previewDigest, payable: false, blockers: [] };
  if (run.run_mode !== "production" || run.status !== "completed" || !(preview.amountPft > 0)) preview.blockers.push("completed_production_run_required");
  if (!dailyAirdropIssuanceRetryable(issuance)) preview.blockers.push("issuance_not_retryable");
  if (!recipientWallet || recipientWallet !== issuance.recipient_wallet ||
      preview.amountDrops !== issuance.amount_drops || run.account_id !== issuance.account_id) preview.blockers.push("issuance_snapshot_mismatch");
  try { await assertDailyAirdropPaymentAllowed({ query: read }, { run, issuance, recipientWallet }); }
  catch (error) { preview.blockers.push(error.message); }
  const conflict = await read(`SELECT id FROM profile_daily_airdrop_issuances
    WHERE account_id=$1 AND run_date=$2::date AND run_id<>$3 AND status='submitted' LIMIT 1`,
  [run.account_id, run.run_date, runId]);
  if (conflict.rows.length) preview.blockers.push("account_day_already_submitted");
  preview.payable = preview.blockers.length === 0;
  if (!execute) return { dryRun: true, ...preview };
  if (!expectedDigest || previewDigest !== expectedDigest) throw new Error("daily_airdrop_recovery_preview_changed");
  if (!preview.payable) return { dryRun: false, ...preview, paid: false };
  const result = await issue({ accountId: run.account_id, runId, expectedRecoveryDigest: expectedDigest });
  return { dryRun: false, ...preview, paid: result.issuance?.status === "submitted", alreadySubmitted: result.alreadySubmitted,
    txHash: result.issuance?.txHash, ledgerIndex: result.issuance?.ledgerIndex };
}
