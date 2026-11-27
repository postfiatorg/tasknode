// Validator access from the signed uptime feed.
//
// Every five minutes the worker fetches the feed, reads it the way the
// contract says a consumer must (server/l1-uptime-feed.js), stores the rows two
// observers agreed on, and, when enforcement is on, suspends the bindings of
// revoked validators and restores those that have access again.
//
// Three rules from the contract hold here whatever else happens:
//   - an indeterminate feed (fewer than two attestations count) changes nothing;
//   - a validator without a quorum changes nothing;
//   - new credit is granted only on a determinate feed.
//
// Off by default. TASKNODE_L1_UPTIME_FEED_URL and
// TASKNODE_L1_UPTIME_FEED_KEYSET_JSON switch the reading on;
// TASKNODE_L1_UPTIME_FEED_ENFORCED=true switches the enforcement on.

import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "./db/pool.js";
import { L1_NETWORK } from "./l1-validator-identity.js";
import { FeedRejected, validateKeyset, verifyUptimeFeed } from "./l1-uptime-feed.js";

const MAX_FEED_BYTES = 16 * 1024 * 1024;

export function l1UptimeFeedConfig(env = process.env) {
  const url = env.TASKNODE_L1_UPTIME_FEED_URL || "";
  const keysetJson = env.TASKNODE_L1_UPTIME_FEED_KEYSET_JSON || "";
  if ((!url || !keysetJson) && env.TASKNODE_L1_UPTIME_FEED_ENFORCED === "true") {
    throw new Error("Enforced validator access requires a feed URL and pinned keyset");
  }
  if (!url || !keysetJson) return { configured: false, enforced: false };
  if (!url.startsWith("https://")) throw new Error("TASKNODE_L1_UPTIME_FEED_URL must be https");
  return { configured: true, url, keyset: validateKeyset(JSON.parse(keysetJson)),
    enforced: env.TASKNODE_L1_UPTIME_FEED_ENFORCED === "true" };
}

export async function fetchUptimeFeed(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel();
    throw new Error("l1_uptime_feed_unavailable");
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) throw new Error("l1_uptime_feed_too_large");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * What to do with each binding, given the rows of a determinate feed.
 * `suspend` when the feed says the validator has no access; `restore` when a
 * suspended binding has access again; `keep` otherwise. A binding whose
 * validator has no row (no quorum, or not in the feed) is kept as it is.
 */
export function accessDecisions(rows, bindings, chain) {
  const byValidator = new Map(rows.map(row => [row.validator_id, row]));
  return bindings.filter(binding => binding.network === chain.network && binding.chain_id === chain.chain_id).map(binding => {
    const row = byValidator.get(binding.validator_id);
    // A row under another key is another validator; it says nothing about this binding.
    if (!row || row.ml_dsa_public_key !== binding.ml_dsa_public_key) return { binding, action: "keep", row: null };
    if (!row.finance_hub_access && !binding.access_suspended_at) return { binding, action: "suspend", row };
    if (row.finance_hub_access && row.access_state_reason !== "insufficient_observed_days" && binding.access_suspended_at) return { binding, action: "restore", row };
    return { binding, action: "keep", row };
  });
}

/**
 * Read the feed once and apply it. Returns what was read and what changed.
 * Never throws for a bad or missing feed: that is reported, and nothing changes.
 */
export async function refreshL1ValidatorAccess({ env = process.env, fetchImpl = fetch, now = new Date(),
  db = { query, transaction, enabled: databaseEnabled } } = {}) {
  const config = l1UptimeFeedConfig(env);
  if (!config.configured || !db.enabled()) return { status: "not_configured" };
  const chain = config.keyset.chain;
  return db.transaction(async client => {
    // Refresh, admission and settlement take this lock first. Fetch is bounded to 15s.
    await lockFeed(client.query.bind(client));
    const pollId = randomUUID();
    const accepted = (await client.query(`SELECT observer_id,last_observed_at FROM l1_uptime_feed_observers WHERE keyset_id=$1`,
      [config.keyset.keyset_id])).rows;
    const persist = async (status, observers = {}) => client.query(`INSERT INTO l1_feed_decisions
      (network,chain_id,keyset_id,poll_id,status,accepted) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT(network,chain_id) DO UPDATE SET keyset_id=excluded.keyset_id,poll_id=excluded.poll_id,
        status=excluded.status,accepted=excluded.accepted`,
    [chain.network, chain.chain_id, config.keyset.keyset_id, pollId, status, JSON.stringify(observers)]);
    let result;
    try {
      result = verifyUptimeFeed(await fetchUptimeFeed(config.url, fetchImpl), { keyset: config.keyset, now,
        lastAccepted: Object.fromEntries(accepted.map(row => [row.observer_id, row.last_observed_at])) });
    } catch (error) {
      const status = error instanceof FeedRejected ? "feed_rejected" : "feed_unavailable";
      await persist(status);
      return { status, reason: error.message };
    }
    if (result.indeterminate) {
      await persist("indeterminate");
      return { status: "indeterminate", rejectedObservers: result.rejectedObservers };
    }
    await persist("applied", result.accepted);
    for (const [observerId, at] of Object.entries(result.accepted)) {
      await client.query(`INSERT INTO l1_uptime_feed_observers(keyset_id,observer_id,last_observed_at) VALUES($1,$2,$3)
        ON CONFLICT (keyset_id,observer_id) DO UPDATE SET last_observed_at=EXCLUDED.last_observed_at, updated_at=now()`,
      [config.keyset.keyset_id, observerId, at]);
    }
    for (const row of result.validators) {
      await client.query(`INSERT INTO l1_validator_access(network,chain_id,validator_id,ml_dsa_public_key,access_state,
          access_state_reason,finance_hub_access,research_api_keys_active,reward_eligible,removal_proposal_eligible,
          observed_days,mean_daily_participation_bps,consecutive_passing_days,grace_started_at,grace_expires_at,window_end,
          source_observer_id,agreeing_observer_ids,feed_observed_at,poll_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)
        ON CONFLICT (network,chain_id,validator_id) DO UPDATE SET ml_dsa_public_key=EXCLUDED.ml_dsa_public_key,
          access_state=EXCLUDED.access_state, access_state_reason=EXCLUDED.access_state_reason,
          finance_hub_access=EXCLUDED.finance_hub_access, research_api_keys_active=EXCLUDED.research_api_keys_active,
          reward_eligible=EXCLUDED.reward_eligible, removal_proposal_eligible=EXCLUDED.removal_proposal_eligible,
          observed_days=EXCLUDED.observed_days, mean_daily_participation_bps=EXCLUDED.mean_daily_participation_bps,
          consecutive_passing_days=EXCLUDED.consecutive_passing_days, grace_started_at=EXCLUDED.grace_started_at,
          grace_expires_at=EXCLUDED.grace_expires_at, window_end=EXCLUDED.window_end,
          source_observer_id=EXCLUDED.source_observer_id, agreeing_observer_ids=EXCLUDED.agreeing_observer_ids,
          poll_id=EXCLUDED.poll_id, feed_observed_at=EXCLUDED.feed_observed_at, updated_at=now()`,
      [chain.network, chain.chain_id, row.validator_id, row.ml_dsa_public_key, row.access_state, row.access_state_reason,
        row.finance_hub_access, row.research_api_keys_active, row.reward_eligible, row.removal_proposal_eligible,
        row.observed_days, row.mean_daily_participation_bps, row.consecutive_passing_days, row.grace_started_at,
        row.grace_expires_at, result.windowEnd, row.source_observer_id, JSON.stringify(row.agreeing_observer_ids),
        row.agreeing_observer_ids.map(id => result.accepted[id]).sort().at(-2), pollId]);
    }
    const summary = { status: "applied", enforced: config.enforced, validators: result.validators.length,
      withoutQuorum: result.validatorsWithoutQuorum, suspended: [], restored: [], researchKeysRevoked: 0 };
    if (!config.enforced) return summary;
    const bindings = (await client.query(`SELECT id,account_id,network,chain_id,validator_id,ml_dsa_public_key,access_suspended_at
      FROM validator_bindings WHERE network=$1 AND revoked_at IS NULL FOR UPDATE`, [L1_NETWORK])).rows;
    const suspendedAccounts = new Set();
    for (const { binding, action } of accessDecisions(result.validators, bindings, chain)) {
      if (action === "suspend") {
        await client.query(`UPDATE validator_bindings SET access_suspended_at=now() WHERE id=$1`, [binding.id]);
        summary.suspended.push(binding.validator_id);
        suspendedAccounts.add(binding.account_id);
      } else if (action === "restore") {
        await client.query(`UPDATE validator_bindings SET access_suspended_at=NULL WHERE id=$1`, [binding.id]);
        summary.restored.push(binding.validator_id);
      }
    }
    for (const account of suspendedAccounts) {
      const revoked = await client.query(`UPDATE research_api_keys SET revoked_at=now()
        WHERE account_id=$1 AND revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM validator_bindings
        WHERE account_id=$1 AND revoked_at IS NULL AND access_suspended_at IS NULL)`, [account]);
      summary.researchKeysRevoked += revoked.rowCount;
    }
    return summary;
  });
}

/**
 * Whether a new validator may be bound now. The contract blocks new bindings
 * while the feed is indeterminate: at least two pinned observers must have had
 * an attestation accepted within the last hour.
 */
export function feedAllowsNewBindings(observerRows, keyset, now = new Date()) {
  const pinned = new Set(keyset.observers.map(observer => observer.observer_id));
  const fresh = observerRows.filter(row => pinned.has(row.observer_id) &&
    new Date(now).getTime() - Date.parse(row.last_observed_at) <= 3600000 &&
    Date.parse(row.last_observed_at) - new Date(now).getTime() <= 60000);
  return new Set(fresh.map(row => row.observer_id)).size >= 2;
}

export async function lockFeed(queryImpl) {
  await queryImpl("SELECT pg_advisory_xact_lock(173814210, 1)");
}

export async function requireFeedForNewBinding({ env = process.env, now = new Date(), queryImpl = query, binding } = {}) {
  const config = l1UptimeFeedConfig(env);
  if (!config.enforced) return;
  await lockFeed(queryImpl);
  const { chain, keyset_id } = config.keyset;
  const decision = (await queryImpl(`SELECT poll_id,accepted FROM l1_feed_decisions
    WHERE network=$1 AND chain_id=$2 AND keyset_id=$3 AND status='applied'`,
  [chain.network, chain.chain_id, keyset_id])).rows[0];
  const observers = Object.entries(decision?.accepted || {}).map(([observer_id,last_observed_at]) => ({observer_id,last_observed_at}));
  if (!feedAllowsNewBindings(observers, config.keyset, now)) {
    throw Object.assign(new Error("l1_uptime_feed_indeterminate"), { status: 503 });
  }
  if (binding) {
    const row = await l1AccessRow(binding, queryImpl);
    if (row?.poll_id !== decision.poll_id || !row.finance_hub_access || row.access_state_reason === "insufficient_observed_days" || !freshFeedRow(row, now)) {
      throw Object.assign(new Error("l1_validator_access_unavailable"), { status: 403 });
    }
  }
  return decision.poll_id;
}

function freshFeedRow(row, now) {
  const age = new Date(now).getTime() - new Date(row.feed_observed_at).getTime();
  return age >= -60000 && age <= 3600000;
}

/** The stored row for a binding, for the dashboard and for the credit. */
export async function l1AccessRow(binding, queryImpl = query) {
  const row = (await queryImpl(`SELECT * FROM l1_validator_access WHERE network=$1 AND chain_id=$2 AND validator_id=$3
    AND ml_dsa_public_key=$4`, [binding.network, binding.chain_id, binding.validator_id, binding.ml_dsa_public_key])).rows[0];
  return row || null;
}

/**
 * Whether the monthly credit may be granted from the feed: the stored row is
 * from a feed read within the last hour and says the validator is eligible.
 */
export function creditFromFeedRow(row, now = new Date()) {
  if (!row) return { eligible: false, reason: "no_feed_row" };
  if (!freshFeedRow(row, now)) return { eligible: false, reason: "feed_stale" };
  return { eligible: row.reward_eligible === true, reason: row.reward_eligible ? "eligible" : row.access_state_reason };
}
