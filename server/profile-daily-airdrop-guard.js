import { dailyAirdropDigest, dailyAirdropPftToDrops } from "./profile-daily-airdrop-payload.js";

export function dailyAirdropRecoveryDigest(run, issuance) {
  return dailyAirdropDigest({ runId: run.id, accountId: run.account_id, runMode: run.run_mode,
    recipient: run.input_snapshot?.airdrop_recipient?.wallet_address || "",
    amountDrops: dailyAirdropPftToDrops(run.daily_airdrop_pft), issuanceId: issuance.id,
    status: issuance.status, attemptCount: issuance.attempt_count });
}

// Shared by the read-only recovery preview, the locked claim and the final
// submission transition. A retryable label alone is not non-payment evidence.
export function dailyAirdropHasSubmissionEvidence(row = {}) {
  return Boolean(row.submission_attempted_at || row.submitted_at ||
    row.signed_tx_hash || row.tx_hash);
}

export async function assertDailyAirdropPaymentAllowed(client, { run, issuance = {}, recipientWallet }) {
  if (dailyAirdropHasSubmissionEvidence(issuance)) {
    throw new Error("daily_airdrop_submission_evidence_requires_reconciliation");
  }
  const blocked = await client.query(`SELECT id FROM account_blacklist
    WHERE status='active' AND (account_id=$1 OR $2=ANY(wallet_addresses)) LIMIT 1`,
  [run.account_id, recipientWallet]);
  if (blocked.rows.length) throw new Error("daily_airdrop_account_blacklisted");
  // Even an unvalidated indexed pointer requires reconciliation. A negative
  // cache result does not clear an attempted-submission marker above.
  const indexed = await client.query(`SELECT tx_hash FROM pftl_pointer_memos
    WHERE context_id=$1 OR ($2::text<>'' AND cid=$2) LIMIT 1`, [run.id, issuance.source_cid || ""]);
  if (indexed.rows.length) throw new Error("daily_airdrop_indexed_reward_requires_reconciliation");
}
