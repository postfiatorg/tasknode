import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { encodeNodePublic } from "ripple-address-codec";
import { query, transaction, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { bindValidator, issueValidatorChallenge, publicValidatorBindingsByAccount, revokeValidatorBinding } from "../server/repositories/validator-bindings.js";
import { getDirectoryLeaderboardDocument } from "../server/repositories/directory-leaderboard.js";
import { publicNetworkBadgesForAccount } from "../server/repositories/network-badges.js";
import { insertLedgerEntry } from "../server/repositories/chat-billing.js";
import { handleValidatorResearchRoute } from "../server/validator-research-routes.js";
import { l1Fixture } from "./fixtures/l1-validator-fixture.mjs";
import { L1_REGISTRY_URL } from "../server/l1-validator-identity.js";

const owner = `validator_ux_${randomUUID()}`, other = `${owner}_private`;
const now = new Date(), month = now.toISOString().slice(0, 7);
const originalFetch = globalThis.fetch;
const fixture = l1Fixture(now);
const validatorId = `ux-${randomUUID()}`;
fixture.registry.validators[0].validator_id = validatorId;
fixture.registry.source_heights[0].validator_id = validatorId;
fixture.registry.latest_commit.precommit_signers[0] = validatorId;
const participation = fixture.registry.validators[0].participation;
function observed(days, score = .99) {
  participation.available = days >= 25;
  participation.daily = Array.from({ length: days }, (_, i) => ({ date: new Date(+now - (i + 1) * 86400000).toISOString().slice(0, 10),
    complete: true, reported: true, committed_blocks: 100, signed_blocks: Math.round(100 * score), score,
    from_height: i * 100 + 1, to_height: (i + 1) * 100 }));
}
const key = deriveKeypair(generateSeed({ algorithm: "ed25519" }));
const masterPublicKey = encodeNodePublic(Buffer.from(key.publicKey, "hex"));
const registryOptions = { now, fetchImpl: async () => Response.json(fixture.registry) };
let historyOffline = false;
async function route(accountId = owner) {
  let result;
  await handleValidatorResearchRoute({ req: { method: "GET", headers: {} }, res: {}, session: accountId ? { accountId } : null,
    url: new URL("https://example.test/api/validators"), readJson: async () => ({}),
    json: (_res, status, body, headers) => { result = { status, body, headers }; } });
  return result;
}
try {
  await migrateDatabase();
  globalThis.fetch = async url => {
    if (historyOffline) throw Error("fixture outage");
    if (String(url) === L1_REGISTRY_URL) return Response.json(fixture.registry);
    assert.ok(String(url).includes("/reports"), "no other provider calls");
    return Response.json({ result: "success", reports: Array.from({ length: 30 }, (_, i) => ({ date: new Date(+now - (i + 1) * 86400000).toISOString().slice(0, 10), score: .99 })) });
  };
  assert.equal((await route(null)).status, 401);
  assert.deepEqual((await route()).body.bindings, []);
  const proof = await issueValidatorChallenge(owner);
  const ledger = await bindValidator({ accountId: owner, masterPublicKey, challenge: proof.challenge,
    signature: sign(Buffer.from(proof.challenge).toString("hex"), key.privateKey) }, { lookup: async () => ({ network: "devnet" }) });
  const l1Proof = await issueValidatorChallenge(owner);
  const l1 = await bindValidator({ accountId: owner, network: "l1-devnet", validatorId, mlDsaPublicKey: fixture.publicKey,
    challenge: l1Proof.challenge, signature: fixture.sign(l1Proof.challenge) }, { registryOptions });
  const ledgerReceipt = `validator-reward:${masterPublicKey}:${month}`;
  await transaction(async client => {
    await client.query("INSERT INTO validator_reward_grants(idempotency_key,master_public_key,account_id,reward_month,amount_usd,evidence_json) VALUES($1,$2,$3,$4,20,$5)",
      [ledgerReceipt, masterPublicKey, owner, month, { network: "devnet", eligible: true }]);
    await insertLedgerEntry(client, { accountId: owner, kind: "reward_credit", amountUsd: 20, source: "validator_reward", uniqueKey: ledgerReceipt });
    await client.query("INSERT INTO validator_reward_grants(idempotency_key,master_public_key,account_id,reward_month,amount_usd,evidence_json) VALUES($1,$2,$3,$4,20,$5)",
      [`${other}:receipt`, `${other}:public-key`, other, month, { network: "testnet" }]);
  });
  observed(5);
  let response = await route();
  assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.bindings.length, 2); assert.equal(response.body.availableCreditUsd, 20);
  assert.equal(response.body.rewardHistory.length, 1); assert.equal(response.body.rewardHistory[0].status, "paid");
  assert.equal(response.body.bindings.find(b => b.id === ledger.id).eligibility.state, "on_track");
  assert.equal(response.body.bindings.find(b => b.id === l1.id).eligibility.state, "building_history");
  assert.equal(JSON.stringify(response.body).includes(other), false);
  observed(25);
  response = await route(); assert.equal(response.body.bindings.find(b => b.id === l1.id).eligibility.state, "on_track");
  observed(25, .94);
  assert.equal((await route()).body.bindings.find(b => b.id === l1.id).eligibility.state, "below_threshold");
  const l1Receipt = `validator-reward:l1-devnet:${l1.chain_id}:${l1.validator_id}:${month}`;
  await query(`INSERT INTO l1_validator_reward_grants(idempotency_key,network,chain_id,validator_id,ml_dsa_public_key,account_id,reward_month,amount_usd,evidence_json)
    VALUES($1,'l1-devnet',$2,$3,$4,$5,$6,20,$7)`, [l1Receipt, l1.chain_id, l1.validator_id, l1.ml_dsa_public_key, owner, month, {}]);
  response = await route(); assert.equal(response.body.rewardHistory.length, 2);
  assert.equal(response.body.bindings.find(b => b.id === l1.id).rewardHistory[0].id, l1Receipt);
  historyOffline = true;
  response = await route(); assert.equal(response.status, 200); assert.equal(response.body.rewardHistory.length, 2);
  assert.ok(response.body.bindings.every(b => b.eligibility.state === "unavailable"));
  const loadBase = async () => ({ operators: [{ accountId: owner, score: 100 }], totals: { operators: 1 } });
  let directory = await getDirectoryLeaderboardDocument({}, { loadBase });
  assert.equal(directory.operators[0].validator.bindings.length, 2);
  assert.ok((await publicNetworkBadgesForAccount({ accountId: owner })).badges.some(b => b.badgeId === "validator"));
  await revokeValidatorBinding(owner, ledger.id);
  directory = await getDirectoryLeaderboardDocument({}, { loadBase });
  assert.equal(directory.operators[0].validator.bindings.length, 1);
  await revokeValidatorBinding(owner, l1.id);
  assert.equal((await publicValidatorBindingsByAccount([owner])).has(owner), false);
  assert.equal((await getDirectoryLeaderboardDocument({}, { loadBase })).operators[0].validator, null);
  assert.ok(!(await publicNetworkBadgesForAccount({ accountId: owner })).badges.some(b => b.badgeId === "validator"));
  response = await route(); assert.equal(response.body.badge, null); assert.deepEqual(response.body.bindings, []);
  assert.equal(response.body.rewardHistory.length, 2, "unbinding retains the account's paid history");
  assert.equal((await route(other)).body.rewardHistory.length, 1);
  console.log("validator-ux-postgres-smoke ok: authenticated account-scoped dashboard, Ledger/L1 eligibility and receipts, provider outage, immediate directory/public/session membership removal on unbind, retained paid history");
} finally {
  globalThis.fetch = originalFetch;
  for (const table of ["l1_validator_reward_grants", "validator_reward_grants", "billing_ledger_entries", "billing_accounts", "validator_bindings", "validator_challenges"])
    await query(`DELETE FROM ${table} WHERE account_id=ANY($1::text[])`, [[owner, other]]);
  await closePool();
}
