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
import { refreshL1ValidatorAccess, requireFeedForNewBinding } from "../server/l1-validator-access.js";
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
const refresh = (enforced, at = now) => refreshL1ValidatorAccess({ env: env(enforced), now: at,
  fetchImpl: async () => new Response(JSON.stringify(feed)) });

await migrateDatabase();
// The fixture's validator ids are fixed; leave no earlier run's bindings in the way.
await query(`UPDATE validator_bindings SET revoked_at=now() WHERE network='l1-devnet' AND revoked_at IS NULL
  AND validator_id = ANY($1::text[])`, [feed.validators.map(row => row.validator_id)]);
await query(`DELETE FROM l1_uptime_feed_observers WHERE keyset_id=$1`, [keyset.keyset_id]);

async function bind(validatorId) {
  const account = `access_smoke_${run}_${validatorId}`, challenge = `pf-tasknode:${randomUUID()}:${account}`;
  await query(`INSERT INTO validator_challenges(challenge,account_id,expires_at,consumed_at) VALUES($1,$2,now()+interval '10 minutes',now())`,
    [challenge, account]);
  await query(`INSERT INTO validator_bindings(id,account_id,network,signature,challenge,chain_id,validator_id,ml_dsa_public_key,registry_evidence)
    VALUES($1,$2,'l1-devnet','fixture',$3,$4,$5,$6,'{}'::jsonb)`,
  [`vb_${randomUUID()}`, account, challenge, keyset.chain.chain_id, validatorId, keyOf(validatorId)]);
  return account;
}
const healthy = await bind("validator-0"), lapsed = await bind("validator-3"), revoked = await bind("validator-4");
const keys = Object.fromEntries(await Promise.all([healthy, lapsed, revoked].map(async account => [account, (await createResearchKey(account, "smoke")).key])));
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
assert.deepEqual([result.suspended, result.restored, result.researchKeysRevoked], [["validator-4"], [], 1]);
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

// 4. A stale feed changes nothing, and blocks new bindings while enforced.
result = await refresh(true, new Date(now.getTime() + 2 * 3600000));
assert.equal(result.status, "indeterminate");
assert.deepEqual(await access(revoked), shut);
assert.equal(await hasValidatorBinding(lapsed), true);
await assert.rejects(requireFeedForNewBinding({ env: env(true), now }), {status: 503});
await assert.rejects(requireFeedForNewBinding({ env: env(true), now: new Date(now.getTime() + 2 * 3600000) }),
  error => error.status === 503 && error.message === "l1_uptime_feed_indeterminate");
await requireFeedForNewBinding({ env: env(false), now: new Date(now.getTime() + 2 * 3600000) });

// 5. An older feed cannot replace a newer one.
await query(`UPDATE l1_uptime_feed_observers SET last_observed_at='2026-11-27T01:45:00Z' WHERE keyset_id=$1`, [keyset.keyset_id]);
assert.equal((await refresh(true)).status, "indeterminate");

await query(`UPDATE validator_bindings SET revoked_at=now() WHERE account_id = ANY($1::text[])`, [[healthy, lapsed, revoked]]);
await query(`DELETE FROM l1_uptime_feed_observers WHERE keyset_id=$1`, [keyset.keyset_id]);
await closePool();
console.log("l1-validator-access-postgres-smoke ok: rows stored without enforcement, revoked suspended with its research keys, grace keeps access, restore, stale changes nothing and blocks new bindings, replay refused");
