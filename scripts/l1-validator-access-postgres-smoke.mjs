// The uptime feed's enforcement against a real Postgres: migration 171, the
// refresh, suspension and restoration of a binding, the research keys, the
// dashboard, and the block on new bindings.
//
//   DATABASE_URL=... TASKNODE_DATABASE_ENABLED=true node scripts/l1-validator-access-postgres-smoke.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { closePool, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { l1FeedState, refreshL1ValidatorAccess, requireFeedForNewBinding } from "../server/l1-validator-access.js";
import { grantL1ValidatorReward } from "../server/l1-validator-rewards.js";
import { finishValidatorConnect, issueValidatorConnect, validatorConnectChallenge } from "../server/repositories/validator-connect.js";
import { l1Fixture } from "./fixtures/l1-validator-fixture.mjs";
import { hasValidatorBinding, listValidatorBindings } from "../server/repositories/validator-bindings.js";
import { authenticateResearchKey, createResearchKey } from "../server/repositories/research-gateway.js";
import { accountMeetsTier } from "../server/index-viewer-routes.js";
import { validatorDashboard } from "../server/validator-dashboard.js";

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/l1-uptime-feed/${name}`, import.meta.url), "utf8"));
// A feed for the devnet chain with one validator in every state, signed by
// postfiat-node with keys made for this fixture and thrown away.
const feed = load("devnet-lifecycle.feed.json");
const keyset = load("devnet-lifecycle.keyset.json");
const now = new Date("2026-11-27T01:40:40Z");
const run = randomUUID().slice(0, 8);
const keyOf = id => feed.validators.find(row => row.validator_id === id).ml_dsa_public_key;
const env = enforced => ({ TASKNODE_L1_UPTIME_FEED_URL: "https://feed.example/validator-uptime-feed.json",
  TASKNODE_L1_UPTIME_FEED_KEYSET_JSON: JSON.stringify(keyset), ...(enforced ? { TASKNODE_L1_UPTIME_FEED_ENFORCED: "true" } : {}) });
const refresh = (enforced, at = now, fetchImpl = async () => new Response(JSON.stringify(feed))) =>
  refreshL1ValidatorAccess({ env: env(enforced), now: at, fetchImpl });
const forget = () => query(`DELETE FROM l1_uptime_feed_state WHERE keyset_id=$1`, [keyset.keyset_id]);

await migrateDatabase();
// The fixture's validator ids are fixed; leave no earlier run's bindings in the way.
await query(`UPDATE validator_bindings SET revoked_at=now() WHERE network='l1-devnet' AND revoked_at IS NULL
  AND validator_id = ANY($1::text[])`, [feed.validators.map(row => row.validator_id)]);
await query(`DELETE FROM l1_uptime_feed_observers WHERE keyset_id=$1`, [keyset.keyset_id]);
await forget();

async function bind(validatorId, account = `access_smoke_${run}_${validatorId}`) {
  const challenge = `pf-tasknode:${randomUUID()}:${account}`;
  await query(`INSERT INTO validator_challenges(challenge,account_id,expires_at,consumed_at) VALUES($1,$2,now()+interval '10 minutes',now())`,
    [challenge, account]);
  await query(`INSERT INTO validator_bindings(id,account_id,network,signature,challenge,chain_id,validator_id,ml_dsa_public_key,registry_evidence)
    VALUES($1,$2,'l1-devnet','fixture',$3,$4,$5,$6,'{}'::jsonb)`,
  [`vb_${randomUUID()}`, account, challenge, keyset.chain.chain_id, validatorId, keyOf(validatorId)]);
  return account;
}
const healthy = await bind("validator-0"), lapsed = await bind("validator-3"), revoked = await bind("validator-4");
// One account with two validators: one the feed gives no access (pending), one
// suspended earlier that the feed gives access again.
const mixed = await bind("validator-5", `access_smoke_${run}_mixed`);
await bind("validator-1", mixed);
await query(`UPDATE validator_bindings SET access_suspended_at=now() WHERE account_id=$1 AND validator_id='validator-1'`, [mixed]);
const keys = Object.fromEntries(await Promise.all([healthy, lapsed, revoked, mixed].map(async account => [account, (await createResearchKey(account, "smoke")).key])));
const access = async account => ({ binding: await hasValidatorBinding(account),
  hub: (await accountMeetsTier({ accountId: account, tier: "validator" })).ok,
  key: await authenticateResearchKey(keys[account]).then(() => true, () => false) });
const open = { binding: true, hub: true, key: true }, shut = { binding: false, hub: false, key: false };

// 1. Reading without enforcement stores the rows and changes nobody's access.
let result = await refresh(false);
assert.deepEqual([result.status, result.enforced, result.validators], ["applied", false, 6]);
assert.equal((await query(`SELECT count(*)::int AS n FROM l1_validator_access WHERE chain_id=$1`, [keyset.chain.chain_id])).rows[0].n, 6);
for (const account of [healthy, lapsed, revoked]) assert.deepEqual(await access(account), open);

// 2. Enforced: the revoked validator loses access and its research keys. Grace keeps access.
result = await refresh(true);
assert.deepEqual([result.suspended.sort(), result.restored, result.researchKeysRevoked], [["validator-4", "validator-5"], ["validator-1"], 1]);
// The account that lost one validator and got another back in the same read keeps its keys.
assert.deepEqual(await access(mixed), open);
assert.deepEqual(await access(healthy), open);
assert.deepEqual(await access(lapsed), open);
assert.deepEqual(await access(revoked), shut);
// The binding is still the operator's, and the dashboard says why it opens nothing.
assert.equal((await listValidatorBindings(revoked)).length, 1);
const dashboard = await validatorDashboard(revoked, { participation: async () => null, reports: async () => [] });
assert.deepEqual([dashboard.bindings[0].access.state, dashboard.bindings[0].access.reason, dashboard.bindings[0].access.suspended],
  ["revoked", "grace_expired", true]);
const grace = (await validatorDashboard(lapsed, { participation: async () => null, reports: async () => [] })).bindings[0].access;
assert.deepEqual([grace.state, grace.graceExpiresAt, grace.suspended], ["lapsed", "2026-12-08T00:00:00.000Z", false]);
// A second read of the same feed suspends nobody twice.
result = await refresh(true);
assert.deepEqual([result.suspended, result.restored, result.researchKeysRevoked], [[], [], 0]);

// 3. A suspended binding whose validator has access again is restored. New keys are the operator's to create.
await query(`UPDATE validator_bindings SET access_suspended_at=now() WHERE account_id=$1`, [healthy]);
assert.equal(await hasValidatorBinding(healthy), false);
result = await refresh(true);
assert.deepEqual(result.restored, ["validator-0"]);
assert.equal(await hasValidatorBinding(healthy), true);

// 4. The latest read decides new actions. A read that fails one minute after a
// good one stops new bindings and new credit at once, although two observers
// were accepted a minute ago. Existing access stays.
const indeterminate = error => error.status === 503 && error.message === "l1_uptime_feed_indeterminate";
const minute = new Date(now.getTime() + 60000), two = new Date(now.getTime() + 120000);
Object.assign(process.env, env(true));
const registry = l1Fixture(two).registry;
registry.validators[0].validator_id = "validator-0"; registry.validators[0].ml_dsa_public_key = keyOf("validator-0");
registry.source_heights[0].validator_id = "validator-0"; registry.latest_commit.precommit_signers[0] = "validator-0";
const registryOptions = { now: two, fetchImpl: async () => new Response(JSON.stringify(registry)) };
const healthyBinding = (await listValidatorBindings(healthy))[0];
const grant = at => grantL1ValidatorReward(healthyBinding, "2026-11", { registryOptions, now: at });
await requireFeedForNewBinding({ env: env(true), now });
result = await refresh(true, minute, async () => { throw new Error("connect refused"); });
assert.equal(result.status, "feed_unavailable");
assert.equal((await l1FeedState(keyset.keyset_id)).status, "feed_unavailable");
await assert.rejects(requireFeedForNewBinding({ env: env(true), now: minute }), indeterminate);
assert.equal(await grant(minute), false, "no credit after a failed read");
assert.deepEqual(await access(healthy), open);
assert.deepEqual(await access(revoked), shut);
// The next good read allows them again. The credit is granted once.
assert.equal((await refresh(true, two)).status, "applied");
await requireFeedForNewBinding({ env: env(true), now: two });
assert.equal(await grant(two), true, "credit on a current, verified feed");
assert.equal(await grant(two), false, "once a month");
// A suspended binding earns nothing, even with an eligible row in the table.
await query(`DELETE FROM l1_validator_reward_grants WHERE account_id=$1`, [healthy]);
await query(`DELETE FROM billing_ledger_entries WHERE account_id=$1`, [healthy]);
await query(`UPDATE validator_bindings SET access_suspended_at=now() WHERE account_id=$1`, [healthy]);
assert.equal(await grant(two), false, "no credit for a suspended binding");
await query(`UPDATE validator_bindings SET access_suspended_at=NULL WHERE account_id=$1`, [healthy]);

// 5. A stale feed changes nothing, and blocks new bindings while enforced.
const later = new Date(now.getTime() + 2 * 3600000);
result = await refresh(true, later);
assert.equal(result.status, "indeterminate");
assert.deepEqual(await access(revoked), shut);
assert.equal(await hasValidatorBinding(lapsed), true);
await assert.rejects(requireFeedForNewBinding({ env: env(true), now: later }), indeterminate);
await requireFeedForNewBinding({ env: env(false), now: later });

// 6. A read that a later one has overtaken is not applied, and an older feed cannot replace a newer one.
assert.equal((await refresh(true)).status, "superseded");
await forget();
await query(`UPDATE l1_uptime_feed_observers SET last_observed_at='2026-11-27T01:45:00Z' WHERE keyset_id=$1`, [keyset.keyset_id]);
assert.equal((await refresh(true)).status, "indeterminate");

// 7. A validator the feed has revoked is bound suspended, not bound with access until the next read.
const real = new Date(), proof = l1Fixture(real), fixtureId = `fixture_${run}`, newcomer = `access_smoke_${run}_newcomer`;
proof.registry.validators[0].validator_id = fixtureId; proof.registry.source_heights[0].validator_id = fixtureId;
proof.registry.latest_commit.precommit_signers[0] = fixtureId;
const proofOptions = { now: real, fetchImpl: async () => new Response(JSON.stringify(proof.registry)) };
await forget();
await query(`INSERT INTO l1_uptime_feed_state(keyset_id,status,decided_at) VALUES($1,'applied',now())`, [keyset.keyset_id]);
await query(`UPDATE l1_uptime_feed_observers SET last_observed_at=$2 WHERE keyset_id=$1`, [keyset.keyset_id, real.toISOString()]);
await query(`INSERT INTO l1_validator_access SELECT network,chain_id,$1,$2,access_state,access_state_reason,finance_hub_access,
  research_api_keys_active,reward_eligible,removal_proposal_eligible,observed_days,mean_daily_participation_bps,consecutive_passing_days,
  grace_started_at,grace_expires_at,window_end,source_observer_id,agreeing_observer_ids,feed_observed_at
  FROM l1_validator_access WHERE chain_id=$3 AND validator_id='validator-4'`, [fixtureId, proof.publicKey, keyset.chain.chain_id]);
const token = await issueValidatorConnect(newcomer);
const { challenge: connectChallenge } = await validatorConnectChallenge(token.token);
await finishValidatorConnect({ token: token.token, network: "l1-devnet", validatorId: fixtureId, mlDsaPublicKey: proof.publicKey,
  signature: proof.sign(connectChallenge) }, { registryOptions: proofOptions });
assert.equal((await listValidatorBindings(newcomer)).length, 1);
assert.equal(await hasValidatorBinding(newcomer), false, "bound, and suspended from the start");
await query(`DELETE FROM l1_validator_access WHERE validator_id=$1`, [fixtureId]);

await query(`UPDATE validator_bindings SET revoked_at=now() WHERE account_id = ANY($1::text[])`, [[healthy, lapsed, revoked, mixed, newcomer]]);
for (const table of ["l1_validator_reward_grants", "billing_ledger_entries", "validator_connect_tokens"]) {
  await query(`DELETE FROM ${table} WHERE account_id = ANY($1::text[])`, [[healthy, newcomer]]);
}
await query(`DELETE FROM l1_uptime_feed_observers WHERE keyset_id=$1`, [keyset.keyset_id]);
await forget();
await closePool();
console.log("l1-validator-access-postgres-smoke ok: rows stored without enforcement, revoked suspended with its research keys, grace keeps access, restore, two bindings of one account settled before its keys, a failed read stops new bindings and credit at once, credit once and never for a suspended binding, overtaken read not applied, replay refused, a revoked validator bound suspended");
