import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateSeed, deriveKeypair, sign as rippleSign } from 'ripple-keypairs';
import { encodeNodePublic } from 'ripple-address-codec';
import { l1Fixture } from './fixtures/l1-validator-fixture.mjs';
import { closePool, query } from '../server/db/pool.js';
import { migrateDatabase } from '../server/db/migrate.js';
import { issueValidatorConnect, validatorConnectChallenge, finishValidatorConnect } from '../server/repositories/validator-connect.js';
import { issueValidatorChallenge, bindValidator } from '../server/repositories/validator-bindings.js';
import { grantL1ValidatorReward } from '../server/l1-validator-rewards.js';
import { runValidatorRewards } from '../server/validator-rewards.js';
import { l1RewardEligibility, validateL1Registry, L1_CHAIN_ID } from '../server/l1-validator-identity.js';
import { rewardMonthWindow } from '../server/validator-identity.js';

// Plan 06 criterion 4 guards: only a genuine outside new-L1 validator can earn
// the L1 content credit. Old-chain bindings keep their existing Ledger reward
// lane and must never land in l1_validator_reward_grants, and registry
// membership alone (Foundation committee seat, fresh registry timestamp)
// never substitutes for 25 observed days at >=95%.
const accountId = `l1_gates_${randomUUID()}`;
const now = new Date('2026-12-01T01:00:00Z'), month = '2026-12';
const end = rewardMonthWindow(month, now);

// Foundation registry mirroring the live read of 2026-11-10T17:20Z
// (research.goodalexander.com:18443/l1-registry/registry.json): six active
// validators at height 1170, every participation window carrying 30 daily
// rows of which exactly 2 are complete+reported, available:false,
// historical_clock_available:false, reason insufficient_observed_days.
const fixture = l1Fixture(now);
const validatorId = `outside_${randomUUID()}`;
const registry = fixture.registry;
const window = registry.validators[0].participation;
function foundationDaily(reportedDates) {
  return Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.parse(window.window_start) + i * 86400000).toISOString().slice(0, 10);
    return reportedDates.includes(i)
      ? { date, complete: true, reported: true, committed_blocks: 7, signed_blocks: 7, score: 1, from_height: 1162, to_height: 1168 }
      : { date, complete: false, reported: false, committed_blocks: null, signed_blocks: null, score: null, from_height: null, to_height: null };
  });
}
function foundationParticipation() {
  return { ...window, daily: foundationDaily([19, 27]) };
}
registry.height = 1170; registry.latest_commit.height = 1170;
registry.validators = [
  { validator_id: validatorId, ml_dsa_public_key: fixture.publicKey, active: true, participation: foundationParticipation() },
  ...Array.from({ length: 5 }, (_, i) => ({ validator_id: `validator-${i + 1}`, active: true,
    ml_dsa_public_key: String(i + 1).repeat(3904), participation: foundationParticipation() })),
];
registry.latest_commit.precommit_signers = registry.validators.map(row => row.validator_id);
registry.source_heights = [validatorId, 'validator-1'].map(validator_id => ({ validator_id, height: 1170, registry_root: registry.registry_root, block_hash: registry.latest_commit.block_hash }));
const registryOptions = { now, fetchImpl: async () => new Response(JSON.stringify(registry)) };
const deps = { registryOptions };

// A real old-chain (Ledger testnet) binding created through the real
// repository proof path, not a hand-rolled row.
const seed = generateSeed({ algorithm: 'ed25519' });
const keypair = deriveKeypair(seed);
const masterPublicKey = encodeNodePublic(Buffer.from(keypair.publicKey, 'hex'));

try {
  await migrateDatabase();

  // Foundation-only eligibility cannot pass: registry membership, an active
  // committee seat and a fresh timestamp leave every Foundation validator
  // held with exactly the live registry's 2 observed days.
  validateL1Registry(registry, now);
  assert.equal(registry.validators.length, 6);
  assert.deepEqual(registry.latest_commit.precommit_signers, registry.validators.map(row => row.validator_id));
  for (const row of registry.validators) {
    const result = l1RewardEligibility(row, end, {});
    assert.equal(result.eligible, false);
    assert.equal(result.available, false);
    assert.equal(result.rewardsOnHold, true);
    assert.equal(result.daysReported, 2);
    assert.equal(result.eligibilityReason, 'insufficient_observed_days');
  }

  // The outside operator binds through the real challenge -> ML-DSA proof ->
  // live-registry completion path against the Foundation-shaped registry.
  const token = await issueValidatorConnect(accountId);
  const { challenge: l1Challenge } = await validatorConnectChallenge(token.token);
  const binding = await finishValidatorConnect({ token: token.token, network: 'l1-devnet', validatorId,
    mlDsaPublicKey: fixture.publicKey, signature: fixture.sign(l1Challenge) }, { registryOptions });
  assert.equal(binding.network, 'l1-devnet');
  assert.equal(binding.validator_id, validatorId);

  const oldChallenge = await issueValidatorChallenge(accountId);
  const oldBinding = await bindValidator({ accountId, challenge: oldChallenge.challenge,
    masterPublicKey, signature: rippleSign(Buffer.from(oldChallenge.challenge, 'utf8').toString('hex'), keypair.privateKey) },
    { lookup: async () => ({ network: 'testnet', masterPublicKey, signingPublicKey: null, domain: '' }) });
  assert.equal(oldBinding.network, 'testnet');

  process.env.TASKNODE_VALIDATOR_REWARDS_ENABLED = 'true';
  const l1Item = report => report.find(item => item.validatorId === validatorId);
  const oldItem = report => report.find(item => item.masterPublicKey === masterPublicKey);
  const withOldLane = reports => ({ ...deps,
    lookup: async () => ({ network: 'testnet', masterPublicKey, signingPublicKey: null, domain: '' }),
    reports: async () => reports });
  const grants = async () => (await query('SELECT count(*)::int AS n FROM l1_validator_reward_grants')).rows[0].n;
  const ledger = async () => (await query('SELECT idempotency_key, amount_usd::text AS amount, kind, source FROM billing_ledger_entries WHERE account_id=$1 ORDER BY idempotency_key', [accountId])).rows;

  // Bound is not qualified: with only the live registry's evidence the L1
  // binding is held and no credit is issued, payout run or direct grant.
  const held = await runValidatorRewards({ month, now, dryRun: false }, withOldLane([]));
  assert.equal(l1Item(held.report).eligible, false);
  assert.equal(l1Item(held.report).rewardsOnHold, true);
  assert.equal(l1Item(held.report).granted, false);
  assert.equal(await grantL1ValidatorReward(binding, month, { ...deps, now }), false);
  assert.equal(await grants(), 0);

  // The old-chain binding stays on its existing Ledger reward lane: eligible
  // VHS evidence still earns that lane's own $20, and none of it can become
  // the L1 content credit.
  const vhsReports = Array.from({ length: 25 }, (_, i) => ({ date: new Date(Date.parse(end) - (i + 1) * 86400000).toISOString().slice(0, 10), score: 0.96 }));
  const oldSweep = await runValidatorRewards({ month, now, dryRun: false }, withOldLane(vhsReports));
  assert.equal(oldItem(oldSweep.report).eligible, true);
  assert.equal(oldItem(oldSweep.report).granted, true);
  assert.equal(oldItem(oldSweep.report).validatorId, undefined, 'old-chain rewards never claim an L1 identity');
  assert.equal(await grants(), 0, 'old-chain bindings cannot pass into the L1 credit lane');
  assert.equal(await grantL1ValidatorReward(oldBinding, month, { ...deps, now }), false, 'network gate refuses an old-chain binding row');
  assert.deepEqual(await ledger(), [
    { idempotency_key: `validator-reward:${masterPublicKey}:${month}`, amount: '20.000000', kind: 'reward_credit', source: 'validator_reward' },
  ]);

  // 25 complete observed days at >=95% qualify the outside validator under
  // the recorded policy; dry run still pays nothing.
  const participation = registry.validators[0].participation;
  participation.available = true;
  participation.daily = Array.from({ length: 25 }, (_, i) => ({ date: new Date(Date.parse(participation.window_start) + i * 86400000).toISOString().slice(0, 10),
    complete: true, reported: true, committed_blocks: 100, signed_blocks: 96, score: 0.96, from_height: i * 100 + 1, to_height: (i + 1) * 100 }));
  const dry = await runValidatorRewards({ month, now }, withOldLane([]));
  assert.equal(l1Item(dry.report).eligible, true);
  assert.equal(l1Item(dry.report).granted, false);
  assert.equal(oldItem(dry.report).alreadyGranted, true);
  assert.equal(await grants(), 0);

  // The payout run credits the L1 content credit exactly once.
  const paid = await runValidatorRewards({ month, now, dryRun: false }, withOldLane([]));
  assert.equal(l1Item(paid.report).granted, true);
  const l1Key = `validator-reward:l1-devnet:${L1_CHAIN_ID}:${validatorId}:${month}`;
  assert.deepEqual(await ledger(), [
    { idempotency_key: l1Key, amount: '20.000000', kind: 'reward_credit', source: 'validator_reward' },
    { idempotency_key: `validator-reward:${masterPublicKey}:${month}`, amount: '20.000000', kind: 'reward_credit', source: 'validator_reward' },
  ]);
  const receipt = (await query('SELECT network, chain_id, validator_id, account_id, amount_usd::text AS amount, evidence_json FROM l1_validator_reward_grants WHERE idempotency_key=$1', [l1Key])).rows[0];
  assert.equal(receipt.network, 'l1-devnet');
  assert.equal(receipt.chain_id, L1_CHAIN_ID);
  assert.equal(receipt.validator_id, validatorId);
  assert.equal(receipt.account_id, accountId);
  assert.equal(receipt.amount, '20.000000');
  assert.equal(receipt.evidence_json.registry.registryRoot, registry.registry_root);
  assert.equal(receipt.evidence_json.daily.length, 25);
  const again = await runValidatorRewards({ month, now, dryRun: false }, withOldLane([]));
  assert.equal(l1Item(again.report).granted, false, 'second payout run credits nothing');
  assert.equal(l1Item(again.report).alreadyGranted, true);
  assert.equal((await query('SELECT count(*)::int AS n FROM billing_ledger_entries WHERE idempotency_key=$1', [l1Key])).rows[0].n, 1);
  assert.equal(await grants(), 1);

  // Operator gates: payouts need explicit enablement and a due month.
  const enabled = process.env.TASKNODE_VALIDATOR_REWARDS_ENABLED;
  process.env.TASKNODE_VALIDATOR_REWARDS_ENABLED = 'false';
  await assert.rejects(runValidatorRewards({ month, now, dryRun: false }, withOldLane([])), /validator_rewards_disabled/);
  process.env.TASKNODE_VALIDATOR_REWARDS_ENABLED = enabled;
  assert.throws(() => rewardMonthWindow('2026-13', now), /reward_month_invalid/);
  assert.throws(() => rewardMonthWindow('2027-01', now), /reward_month_not_due/);

  console.log('l1-outside-credit-gates-postgres-smoke PASS: live-shape Foundation registry (6 validators, height 1170, 2 observed days) holds every member; real ML-DSA l1-devnet bind + real testnet bind; held/unqualified pays nothing; old-chain lane stays out of l1_validator_reward_grants; 25x95% qualifies; exactly-once 20USD credit with registry evidence; enablement and due-month gates refuse');
} finally {
  for (const table of ['l1_validator_reward_grants', 'validator_reward_grants', 'billing_ledger_entries', 'billing_accounts', 'validator_connect_tokens', 'validator_bindings', 'validator_challenges']) {
    await query(`DELETE FROM ${table} WHERE account_id=ANY($1::text[])`, [[accountId]]);
  }
  await closePool();
}
