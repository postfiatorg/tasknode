import { query, databaseEnabled } from "./db/pool.js";
import { listValidatorBindings } from "./repositories/validator-bindings.js";
import { usageSummary } from "./repositories/chat-billing.js";
import { dailyAgreement, fetchValidatorReports } from "./validator-identity.js";
import { l1BindingParticipation } from "./l1-validator-identity.js";
import { validatorEligibility } from "../shared/validator-display.js";
import { l1AccessRow } from "./l1-validator-access.js";

// What the signed uptime feed last said about a binding's validator, for the
// operator: the state, why, and when grace runs out.
function feedAccess(row, binding) {
  if (!row) return null;
  return { state: row.access_state, reason: row.access_state_reason, financeHubAccess: row.finance_hub_access,
    rewardEligible: row.reward_eligible, observedDays: row.observed_days,
    meanDailyParticipationBps: row.mean_daily_participation_bps, recoveryStreakDays: row.consecutive_passing_days,
    graceExpiresAt: row.grace_expires_at ? new Date(row.grace_expires_at).toISOString() : null,
    observedAt: new Date(row.feed_observed_at).toISOString(), agreeingObservers: row.agreeing_observer_ids,
    suspended: Boolean(binding.access_suspended_at) };
}

export async function validatorRewardHistory(accountId, queryImpl = query) {
  if (!databaseEnabled()) return [];
  const rows = (await queryImpl(`SELECT g.idempotency_key, g.master_public_key AS validator_id,
      COALESCE(g.evidence_json->>'network', b.network, 'ledger') AS network, NULL::text AS chain_id,
      g.reward_month,g.amount_usd,g.granted_at
    FROM validator_reward_grants g
    LEFT JOIN LATERAL (SELECT network FROM validator_bindings WHERE master_public_key=g.master_public_key
      ORDER BY bound_at DESC LIMIT 1) b ON true
    WHERE g.account_id=$1
    UNION ALL SELECT idempotency_key,validator_id,network,chain_id,reward_month,amount_usd,granted_at
    FROM l1_validator_reward_grants WHERE account_id=$1
    ORDER BY reward_month DESC,granted_at DESC`, [accountId])).rows;
  return rows.map(row => ({ id: row.idempotency_key, validatorId: row.validator_id, network: row.network,
    chainId: row.chain_id, month: row.reward_month, amountUsd: Number(row.amount_usd), status: "paid",
    paidAt: new Date(row.granted_at).toISOString(), reason: null }));
}

export async function validatorDashboard(accountId, {
  bindings = listValidatorBindings, history = validatorRewardHistory, balance = usageSummary,
  reports = fetchValidatorReports, participation = l1BindingParticipation, access = l1AccessRow, now = new Date(),
} = {}) {
  const [linked, rewardHistory, credit] = await Promise.all([bindings(accountId), history(accountId), balance({ accountId })]);
  const nextRewardDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const enriched = await Promise.all(linked.map(async binding => {
    let uptime = null;
    try { uptime = binding.network === "l1-devnet" ? await participation(binding, now)
      : dailyAgreement(await reports(binding.master_public_key, binding.network), now); } catch { /* Retain identity and receipts when history is down. */ }
    let feedRow = null;
    if (binding.network === "l1-devnet") { try { feedRow = await access(binding); } catch { /* The feed row is an addition; the rest stands without it. */ } }
    return { ...binding, uptime, ...(uptime ? {} : { uptimeError: "Validator history is temporarily unavailable." }),
      access: feedAccess(feedRow, binding),
      eligibility: validatorEligibility(uptime, nextRewardDate),
      rewardHistory: rewardHistory.filter(row => row.validatorId === (binding.validator_id || binding.master_public_key)
        && row.network === binding.network && (binding.network !== "l1-devnet" || row.chainId === binding.chain_id)) };
  }));
  return { bindings: enriched, badge: linked.length ? "Validator" : null, nextRewardDate, rewardHistory,
    rewardHistoryNote: "Only paid grants are saved. Unpaid months have no recorded eligibility decision.",
    availableCreditUsd: credit.availableCreditUsd };
}
