import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { l1Fixture } from './fixtures/l1-validator-fixture.mjs';
import { L1_REGISTRY_URL, fetchL1Registry, l1Participation, registeredL1Validator, validateL1Registry, verifyL1ValidatorSignature, verifyRegisteredL1Proof } from '../server/l1-validator-identity.js';

const vectors = JSON.parse(await readFile(new URL('./fixtures/l1-validator-vectors.json', import.meta.url))).vectors;
for (const vector of vectors) assert.equal(verifyL1ValidatorSignature({ publicKey: vector.ml_dsa_public_key, signature: vector.signature, challenge: vector.message }), vector.expected_valid, vector.name);
const now = new Date('2026-10-28T16:00:00Z');
const fixture = l1Fixture(now);
const { registry, publicKey } = fixture;
const challenge = 'pf-tasknode:fixture:account:1793206800';
const signature = fixture.sign(challenge);
assert.equal(verifyL1ValidatorSignature({ publicKey, signature, challenge }), true);
for (const altered of [{ publicKey: publicKey.toUpperCase() }, { signature: signature.toUpperCase() }, { signature: signature.slice(2) },
  { challenge: `${challenge}\n` }, { signature: fixture.sign(challenge, 'postfiat-l1-v2/transaction/v1') }, { publicKey: 'g'.repeat(3904) }]) {
  assert.equal(verifyL1ValidatorSignature({ publicKey, signature, challenge, ...altered }), false);
}
assert.equal(validateL1Registry(registry, now), registry);
const fetchImpl = async (url, options) => {
  assert.equal(url, L1_REGISTRY_URL); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
  return new Response(JSON.stringify(registry));
};
assert.equal((await fetchL1Registry({ fetchImpl, now })).height, 10);
assert.equal((await verifyRegisteredL1Proof({ validatorId: 'validator-0', publicKey, signature, challenge }, { fetchImpl, now })).chainId, registry.chain_id);
for (const [name, mutate] of [
  ['stale', r => { r.generated_at = new Date(now - 3600001).toISOString(); }],
  ['future', r => { r.generated_at = new Date(+now + 60001).toISOString(); }],
  ['date', r => { r.generated_at = 'nonsense'; }], ['chain', r => { r.chain_id = 'untrusted'; }],
  ['network', r => { r.network = 'devnet'; }], ['schema', r => { r.schema = 'wrong'; }],
  ['genesis', r => { r.genesis_hash = 'z'.repeat(96); }], ['root', r => { r.registry_root = '0'; }],
  ['zero height', r => { r.height = 0; }], ['unsafe height', r => { r.height = Number.MAX_SAFE_INTEGER + 1; }],
  ['duplicate id', r => { r.validators[1].validator_id = r.validators[0].validator_id; }],
  ['duplicate key', r => { r.validators[1].ml_dsa_public_key = r.validators[0].ml_dsa_public_key; }],
  ['invalid key', r => { r.validators[0].ml_dsa_public_key = publicKey.toUpperCase(); }],
  ['unknown signer', r => { r.latest_commit.precommit_signers.push('unknown'); }],
  ['duplicate signer', r => { r.latest_commit.precommit_signers.push('validator-0'); }],
  ['no certificate', r => { delete r.latest_commit; }], ['height disagreement', r => { r.source_heights[0].height++; }],
  ['root disagreement', r => { r.source_heights[0].registry_root = 'a'.repeat(96); }],
  ['block disagreement', r => { r.source_heights[0].block_hash = 'a'.repeat(96); }],
  ['one source', r => { r.source_heights.pop(); }], ['duplicate source', r => { r.source_heights[1] = r.source_heights[0]; }],
]) { const altered = structuredClone(registry); mutate(altered); assert.throws(() => validateL1Registry(altered, now), undefined, name); }
const identity = { validatorId: 'validator-0', publicKey };
for (const altered of [{ validatorId: 'unknown' }, { publicKey: registry.validators[1].ml_dsa_public_key }, { chainId: 'other' }]) {
  assert.throws(() => registeredL1Validator(registry, { ...identity, ...altered }));
}
const inactive = structuredClone(registry); inactive.validators[0].active = false;
assert.throws(() => registeredL1Validator(inactive, identity), /inactive/);
for (const response of [new Response('x'.repeat(1024 * 1024 + 1)), new Response('{}', { headers: { 'content-length': '1048577' } }),
  new Response('{}', { status: 302, headers: { location: 'https://evil.invalid' } }), new Response('bad-json'), new Response('{}', { status: 503 })]) {
  await assert.rejects(fetchL1Registry({ fetchImpl: async () => response, now }));
}
assert.equal(l1Participation(registry.validators[0].participation, now).meanAgreement, null);
assert.equal(l1Participation({ window_start: 'bad', daily: [] }, now).eligible, false);
const p = structuredClone(registry.validators[0].participation); p.available = true;
p.daily = Array.from({ length: 25 }, (_, i) => ({ date: new Date(Date.parse(p.window_start) + i * 86400000).toISOString().slice(0, 10),
  complete: true, reported: true, committed_blocks: 100, signed_blocks: 95, score: 0.95, from_height: i * 100 + 1, to_height: (i + 1) * 100 }));
let measured = l1Participation(p, now);
assert.equal(measured.meanAgreement, 0.95); assert.equal(measured.daysReported, 25); assert.equal(measured.qualifies, true);
assert.equal(measured.eligible, true); assert.equal(measured.rewardsOnHold, false);
p.available = false; assert.equal(l1Participation(p, now).eligible, false); p.available = true;
p.time_basis = 'untrusted'; assert.equal(l1Participation(p, now).eligible, false); p.time_basis = 'observer_brackets';
// D1 is an unweighted mean of daily vote shares, never committee membership or a block-weighted mean.
p.daily[0].committed_blocks = 10000; p.daily[0].signed_blocks = 9500;
assert.equal(l1Participation(p, now).meanAgreement, 0.95);
p.daily[0].reported = false; assert.equal(l1Participation(p, now).qualifies, false); p.daily[0].reported = true;
p.daily[0].signed_blocks = 9400; p.daily[0].score = 0.94;
assert.equal(l1Participation(p, now).qualifies, false);
p.daily[0].score = 0.95; assert.equal(l1Participation(p, now).available, false, 'inconsistent vote counts fail closed');
console.log(JSON.stringify({ ok: true, vectors: vectors.length, tests: 'ML-DSA fixed context/encoding, trusted registry validation/size/freshness/identity, D1 thresholds and observed-day eligibility' }));
