import { query, transaction } from "./db/pool.js";
import { dailyAgreement, fetchValidatorReports, findRegisteredValidator, rewardMonthWindow, validatorError } from "./validator-identity.js";
import { insertLedgerEntry } from "./repositories/chat-billing.js";
import { l1BindingParticipation } from "./l1-validator-identity.js";
import { grantL1ValidatorReward } from "./l1-validator-rewards.js";

export async function grantValidatorReward(binding, month, evidence, dependencies = {}) {
  if (binding.network === "l1-devnet") return grantL1ValidatorReward(binding, month, dependencies);
  if (!evidence.eligible) return false;
  const key = `validator-reward:${binding.master_public_key}:${month}`;
  return transaction(async (client) => {
    const active = await client.query(`SELECT 1 FROM validator_bindings WHERE id=$1 AND account_id=$2 AND master_public_key=$3 AND network IN ('devnet','testnet') AND revoked_at IS NULL FOR UPDATE`, [binding.id, binding.account_id, binding.master_public_key]);
    if (!active.rowCount) return false;
    const granted = await client.query(`INSERT INTO validator_reward_grants(idempotency_key,master_public_key,account_id,reward_month,amount_usd,evidence_json)
      VALUES($1,$2,$3,$4,20,$5::jsonb) ON CONFLICT DO NOTHING RETURNING idempotency_key`,
    [key, binding.master_public_key, binding.account_id, month, JSON.stringify(evidence)]);
    if (!granted.rowCount) return false;
    await insertLedgerEntry(client, { kind: "reward_credit", accountId: binding.account_id, amountUsd: 20,
      source: "validator_reward", note: `Validator reward ${month}`, uniqueKey: key, onConflictUnique: true, metadata: evidence });
    return true;
  });
}

export async function runValidatorRewards({ month = new Date().toISOString().slice(0, 7), dryRun = true, accountId, now = new Date() } = {}, dependencies = {}) {
  if (!dryRun && process.env.TASKNODE_VALIDATOR_REWARDS_ENABLED !== "true") throw validatorError("validator_rewards_disabled", 403);
  const end = rewardMonthWindow(month, now);
  const rows = (await query(`SELECT * FROM validator_bindings WHERE revoked_at IS NULL${accountId ? " AND account_id=$1" : ""} ORDER BY master_public_key`, accountId ? [accountId] : [])).rows;
  const report = [];
  for (const binding of rows) {
    const item = { masterPublicKey: binding.master_public_key, accountId: binding.account_id, network: binding.network, month, eligible: false, granted: false };
    try {
      if (binding.network === "l1-devnet") {
        Object.assign(item, { validatorId: binding.validator_id, chainId: binding.chain_id }, await l1BindingParticipation(binding, end, dependencies.registryOptions));
        item.alreadyGranted = Boolean((await query(`SELECT 1 FROM l1_validator_reward_grants
          WHERE network=$1 AND reward_month=$2 AND ((chain_id=$3 AND validator_id=$4) OR ml_dsa_public_key=$5)`,
        [binding.network, month, binding.chain_id, binding.validator_id, binding.ml_dsa_public_key])).rowCount);
        if (!dryRun && item.eligible) item.granted = await grantL1ValidatorReward(binding, month, { registryOptions: dependencies.registryOptions, now });
        report.push(item);
        continue;
      }
      await (dependencies.lookup || findRegisteredValidator)(binding.master_public_key, { network: binding.network });
      const reports = await (dependencies.reports || fetchValidatorReports)(binding.master_public_key, binding.network);
      const evidence = dailyAgreement(reports, end);
      Object.assign(item, evidence);
      item.alreadyGranted = Boolean((await query(`SELECT 1 FROM validator_reward_grants WHERE master_public_key=$1 AND reward_month=$2`, [binding.master_public_key, month])).rowCount);
      if (!dryRun && evidence.eligible) item.granted = await grantValidatorReward(binding, month, { ...evidence, network: binding.network, source: "vhs_daily_reports" });
    } catch (error) { item.error = error.status ? error.message : "validator_history_unavailable"; }
    report.push(item);
  }
  return { month, dryRun, report, granted: report.filter((item) => item.granted).length };
}
