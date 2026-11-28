import { query, transaction } from "./db/pool.js";
import { fetchL1Registry, l1RewardEligibility, registeredL1Validator } from "./l1-validator-identity.js";
import { rewardMonthWindow } from "./validator-identity.js";
import { insertLedgerEntry } from "./repositories/chat-billing.js";
import { creditFromFeedRow, feedLockKey, l1AccessRow, l1FeedState, l1UptimeFeedConfig } from "./l1-validator-access.js";

export async function grantL1ValidatorReward(binding, month, { registryOptions, now = new Date() } = {}) {
  const end = rewardMonthWindow(month, now);
  const current = (await query(`SELECT * FROM validator_bindings
    WHERE id=$1 AND account_id=$2 AND network='l1-devnet' AND revoked_at IS NULL`, [binding.id, binding.account_id])).rows[0];
  if (!current) return false;
  // Never accept an eligible flag supplied by a caller. Recheck the canonical
  // stored identity and actual observed daily vote counts at the grant boundary.
  const registry = await fetchL1Registry(registryOptions);
  const registered = registeredL1Validator(registry, { validatorId: current.validator_id, publicKey: current.ml_dsa_public_key, chainId: current.chain_id });
  let evidence = l1RewardEligibility(registered, end);
  // With the signed feed enforced, the credit follows the feed: the row two
  // observers agreed on, read within the last hour. Otherwise the rule of
  // before applies unchanged.
  const feed = l1UptimeFeedConfig();
  if (feed.enforced) {
    const row = await l1AccessRow(current);
    const fromFeed = creditFromFeedRow(row, now, await l1FeedState(feed.keyset.keyset_id));
    evidence = { ...evidence, eligible: fromFeed.eligible, eligibilityReason: fromFeed.reason,
      policy: "l1-uptime-feed-v1", source: "postfiat-validator-uptime-v1", feedRow: row };
  }
  if (!evidence.eligible) return false;
  const key = `validator-reward:l1-devnet:${current.chain_id}:${current.validator_id}:${month}`;
  return transaction(async client => {
    // With the feed enforced, the credit and a refresh of the feed never
    // interleave, and everything the credit rests on is read again here,
    // under the lock that the ledger entry is written under.
    if (feed.enforced) await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [feedLockKey(feed.keyset.keyset_id)]);
    const active = await client.query(`SELECT access_suspended_at FROM validator_bindings
      WHERE id=$1 AND account_id=$2 AND network='l1-devnet' AND chain_id=$3 AND validator_id=$4
        AND ml_dsa_public_key=$5 AND revoked_at IS NULL FOR UPDATE`,
    [current.id, current.account_id, current.chain_id, current.validator_id, current.ml_dsa_public_key]);
    if (!active.rowCount) return false;
    if (feed.enforced) {
      const run = client.query.bind(client);
      if (active.rows[0].access_suspended_at) return false;
      if (!creditFromFeedRow(await l1AccessRow(current, run), now, await l1FeedState(feed.keyset.keyset_id, run)).eligible) return false;
    }
    const audit = { ...evidence, network: current.network, chainId: current.chain_id, validatorId: current.validator_id,
      publicKey: current.ml_dsa_public_key, source: evidence.source,
      registry: { generatedAt: registry.generated_at, height: registry.height, registryRoot: registry.registry_root, genesisHash: registry.genesis_hash },
      daily: evidence.daily };
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
