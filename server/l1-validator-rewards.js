import { query, transaction } from "./db/pool.js";
import { fetchL1Registry, l1Participation, registeredL1Validator } from "./l1-validator-identity.js";
import { rewardMonthWindow } from "./validator-identity.js";
import { insertLedgerEntry } from "./repositories/chat-billing.js";

export async function grantL1ValidatorReward(binding, month, { registryOptions, now = new Date() } = {}) {
  const end = rewardMonthWindow(month, now);
  const current = (await query(`SELECT * FROM validator_bindings
    WHERE id=$1 AND account_id=$2 AND network='l1-devnet' AND revoked_at IS NULL`, [binding.id, binding.account_id])).rows[0];
  if (!current) return false;
  // Never accept an eligible flag supplied by a caller. Recheck the canonical
  // stored identity and actual observed daily vote counts at the grant boundary.
  const registry = await fetchL1Registry(registryOptions);
  const registered = registeredL1Validator(registry, { validatorId: current.validator_id, publicKey: current.ml_dsa_public_key, chainId: current.chain_id });
  const evidence = l1Participation(registered.participation, end);
  if (!evidence.eligible) return false;
  const key = `validator-reward:l1-devnet:${current.chain_id}:${current.validator_id}:${month}`;
  return transaction(async client => {
    const active = await client.query(`SELECT 1 FROM validator_bindings
      WHERE id=$1 AND account_id=$2 AND network='l1-devnet' AND chain_id=$3 AND validator_id=$4
        AND ml_dsa_public_key=$5 AND revoked_at IS NULL FOR UPDATE`,
    [current.id, current.account_id, current.chain_id, current.validator_id, current.ml_dsa_public_key]);
    if (!active.rowCount) return false;
    const audit = { ...evidence, network: current.network, chainId: current.chain_id, validatorId: current.validator_id,
      publicKey: current.ml_dsa_public_key, source: "l1_observed_precommit_votes",
      registry: { generatedAt: registry.generated_at, height: registry.height, registryRoot: registry.registry_root, genesisHash: registry.genesis_hash },
      daily: registered.participation.daily };
    const receipt = await client.query(`INSERT INTO l1_validator_reward_grants
      (idempotency_key,network,chain_id,validator_id,ml_dsa_public_key,account_id,reward_month,amount_usd,evidence_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,20,$8::jsonb) ON CONFLICT DO NOTHING RETURNING idempotency_key`,
    [key, current.network, current.chain_id, current.validator_id, current.ml_dsa_public_key, current.account_id, month, JSON.stringify(audit)]);
    if (!receipt.rowCount) return false;
    await insertLedgerEntry(client, { kind: "reward_credit", accountId: current.account_id, amountUsd: 20,
      source: "validator_reward", note: `L1 validator reward ${month}`, uniqueKey: key, onConflictUnique: true, metadata: audit });
    return true;
  });
}
