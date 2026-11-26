import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { closePool, query } from '../server/db/pool.js';
import { migrateDatabase } from '../server/db/migrate.js';
import { issueValidatorConnect, validatorConnectChallenge, validatorConnectStatus } from '../server/repositories/validator-connect.js';
import { hasValidatorBinding, revokeValidatorBinding } from '../server/repositories/validator-bindings.js';
import { createResearchKey, authenticateResearchKey } from '../server/repositories/research-gateway.js';
import { chatResearchAccess } from '../server/chat-research-provider.js';
import { grantValidatorReward, runValidatorRewards } from '../server/validator-rewards.js';
import { handleValidatorConnectRoute } from '../server/validator-connect-routes.js';
import { handleValidatorResearchRoute } from '../server/validator-research-routes.js';
import { readValidatedJson } from '../server/request-validation.js';
import { apiRoutePolicies, routeBodyPolicyForRequest } from '../server/route-policies.js';
import { L1_REGISTRY_URL } from '../server/l1-validator-identity.js';
import { l1Fixture } from './fixtures/l1-validator-fixture.mjs';
import { accountMeetsTier } from '../server/index-viewer-routes.js';
import { publicNetworkBadgesForAccount } from '../server/repositories/network-badges.js';

const account = `l1_connect_smoke_${randomUUID()}`, other = `${account}_other`;
const originalFetch = globalThis.fetch;
const fixture = l1Fixture();
const validatorId = `fixture_${randomUUID()}`;
fixture.registry.validators[0].validator_id = validatorId;
fixture.registry.source_heights[0].validator_id = validatorId;
fixture.registry.latest_commit.precommit_signers[0] = validatorId;
let registry = fixture.registry;
let fetchCalls = 0;
globalThis.fetch = async (url, options) => { assert.equal(url, L1_REGISTRY_URL); assert.equal(options.redirect, 'error'); fetchCalls++; return new Response(JSON.stringify(registry)); };
async function route(path, payload, owner, method = 'POST') {
  let status, body;
  const req = Readable.from([Buffer.from(JSON.stringify(payload || {}))]);
  Object.assign(req, { method, url: path, headers: { 'content-type': 'application/json' } });
  const policy = routeBodyPolicyForRequest(apiRoutePolicies.find(p => p.path === path), method, path);
  const handler = path.startsWith('/api/validators/connect') ? handleValidatorConnectRoute : handleValidatorResearchRoute;
  await handler({ req, res: {}, session: owner ? { accountId: owner } : null, url: new URL(path, 'http://localhost'),
    readJson: request => readValidatedJson(request, policy.maxBytes, policy.schema), json: (_res, code, value) => { status = code; body = value; } });
  return { status, body };
}
const complete = '/api/validators/connect/complete';
async function proofFor(owner = account) {
  const token = await issueValidatorConnect(owner);
  const { challenge } = await validatorConnectChallenge(token.token);
  return { token, challenge, proof: { token: token.token, network: 'l1-devnet', validator_id: validatorId,
    ml_dsa_public_key: fixture.publicKey, signature: fixture.sign(challenge) } };
}
try {
  await migrateDatabase();
  const { token, challenge, proof } = await proofFor();
  for (const altered of [{ signature: '0'.repeat(6618) }, { signature: fixture.sign(challenge, 'wrong-context') },
    { validator_id: 'unknown' }, { validator_id: 'validator-1' }, { ml_dsa_public_key: registry.validators[1].ml_dsa_public_key }]) {
    assert.equal((await route(complete, { ...proof, ...altered })).status, 403);
  }
  assert.equal((await route(complete, proof, other)).status, 403);
  for (const altered of [{ network: 'other' }, { master_public_key: 'n'.repeat(50) }, { signature: '0'.repeat(6619) },
    { validator_token: 'never accepted' }, { network: undefined }, { validator_id: undefined }]) {
    assert.ok([400, 403].includes((await route(complete, { ...proof, ...altered })).status));
  }
  registry.validators[0].active = false; assert.equal((await route(complete, proof)).body.error, 'l1_validator_inactive'); registry.validators[0].active = true;
  registry.generated_at = new Date(Date.now() - 3601000).toISOString(); assert.equal((await route(complete, proof)).body.error, 'l1_registry_stale'); registry.generated_at = new Date().toISOString();
  assert.equal((await validatorConnectStatus(account, token.id)).status, 'waiting', 'negative proofs cannot consume a capability');
  const race = await Promise.all([route(complete, proof), route(complete, proof)]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 403]);
  const binding = race.find(r => r.status === 200).body.binding;
  assert.equal(binding.network, 'l1-devnet'); assert.equal(binding.validator_id, validatorId);
  assert.equal(binding.ml_dsa_public_key, fixture.publicKey); assert.equal(binding.master_public_key, null);
  for (const [id, key] of [[validatorId, registry.validators[1].ml_dsa_public_key], ['duplicate-key', fixture.publicKey]]) {
    await assert.rejects(query(`INSERT INTO validator_bindings(id,account_id,network,signature,challenge,chain_id,validator_id,ml_dsa_public_key,registry_evidence)
      SELECT $1,$2,network,signature,challenge,chain_id,$3,$4,registry_evidence FROM validator_bindings WHERE id=$5`,
    [`vb_${randomUUID()}`, other, id, key, binding.id]), error => error.code === '23505');
  }
  assert.equal((await validatorConnectStatus(account, token.id)).bindingId, binding.id);
  assert.equal((await route(complete, proof)).status, 403);
  await assert.rejects(validatorConnectChallenge(token.token), /invalid_or_expired/);
  const audit = (await query('SELECT registry_evidence,signature FROM validator_bindings WHERE id=$1', [binding.id])).rows[0];
  assert.equal(audit.signature, proof.signature); assert.equal(audit.registry_evidence.registryRoot, registry.registry_root);
  assert.equal((await query('SELECT proof FROM validator_connect_tokens WHERE id=$1', [token.id])).rows[0].proof.mlDsaPublicKey, fixture.publicKey);
  const repeat = await proofFor(); assert.equal((await route(complete, repeat.proof)).body.binding.id, binding.id);
  const foreign = await proofFor(other); assert.equal((await route(complete, foreign.proof)).status, 409);
  assert.equal((await validatorConnectStatus(other, foreign.token.id)).status, 'waiting');
  const expired = await proofFor(); await query("UPDATE validator_connect_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.token.id]);
  assert.equal((await route(complete, expired.proof)).status, 403);
  const staleChallenge = await proofFor(); await query("UPDATE validator_challenges SET expires_at=now()-interval '1 second' WHERE challenge=$1", [staleChallenge.challenge]);
  assert.equal((await route(complete, staleChallenge.proof)).status, 403);
  // Registry key rotation cannot silently replace an account's stable identity.
  const replacement = l1Fixture(); const saved = registry.validators[0].ml_dsa_public_key;
  registry.validators[0].ml_dsa_public_key = replacement.publicKey;
  assert.equal((await route(complete, foreign.proof)).body.error, 'l1_validator_key_not_current');
  const rotated = await proofFor();
  assert.equal((await route(complete, { ...rotated.proof, ml_dsa_public_key: replacement.publicKey, signature: replacement.sign(rotated.challenge) })).status, 409);
  registry.validators[0].ml_dsa_public_key = saved;
  // Reusing a public key under a different registry id cannot create a second binding.
  registry.validators[0].validator_id = 'validator-renamed';
  registry.source_heights[0].validator_id = 'validator-renamed'; registry.latest_commit.precommit_signers[0] = 'validator-renamed';
  const renamed = await proofFor(); assert.equal((await route(complete, { ...renamed.proof, validator_id: 'validator-renamed' })).status, 409);
  registry.validators[0].validator_id = validatorId; registry.source_heights[0].validator_id = validatorId; registry.latest_commit.precommit_signers[0] = validatorId;
  assert.equal(await hasValidatorBinding(account), true); assert.equal(await hasValidatorBinding(other), false);
  assert.equal((await accountMeetsTier({ accountId: account, tier: 'validator' })).ok, true);
  assert.equal((await accountMeetsTier({ accountId: other, tier: 'validator' })).ok, false);
  assert.ok((await publicNetworkBadgesForAccount({ accountId: account })).badges.some(badge => badge.badgeId === 'validator'));
  process.env.GA_RESEARCH_URL = 'https://ga.example.test'; process.env.GA_RESEARCH_HMAC_SECRET = 'synthetic-test';
  assert.equal((await chatResearchAccess({ accountId: account })).provider, 'goodalexander');
  const key = await createResearchKey(account, 'L1 fixture');
  assert.equal((await authenticateResearchKey(key.key)).accountId, account);
  const listed = await route('/api/validators', {}, account, 'GET');
  assert.equal(listed.status, 200); assert.equal(listed.body.badge, 'Validator');
  assert.equal(listed.body.bindings[0].uptime.meanAgreement, null); assert.equal(listed.body.bindings[0].uptime.eligible, false);
  const rewards = await runValidatorRewards({ accountId: account });
  assert.equal(rewards.report.length, 1); assert.equal(rewards.report[0].eligible, false); assert.equal(rewards.report[0].rewardsOnHold, true);
  assert.equal(await grantValidatorReward(binding, new Date().toISOString().slice(0, 7), { eligible: true }), false);
  assert.equal(await grantValidatorReward({ ...binding, network: 'devnet', master_public_key: 'forged' }, new Date().toISOString().slice(0, 7), { eligible: true }), false);
  assert.equal((await query('SELECT count(*)::int AS n FROM validator_reward_grants WHERE account_id=$1', [account])).rows[0].n, 0);
  await revokeValidatorBinding(account, binding.id);
  await assert.rejects(authenticateResearchKey(key.key)); assert.equal(await hasValidatorBinding(account), false);
  console.log(JSON.stringify({ ok: true, fetchCalls, tests: 'real L1 completion schema/route, signature/context/key/unknown/inactive/stale/expiry/replay refusals, concurrent single use, durable identity/proof, cross-account/rotation/duplicate-key protection, research entitlements, held rewards, revoke' }));
} finally {
  globalThis.fetch = originalFetch;
  for (const table of ['research_api_keys', 'validator_connect_tokens', 'validator_bindings', 'validator_challenges']) await query(`DELETE FROM ${table} WHERE account_id=ANY($1::text[])`, [[account, other]]);
  await closePool();
}
