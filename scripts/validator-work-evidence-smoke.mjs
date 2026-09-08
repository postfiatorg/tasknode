import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import {
  deriveValidatorTaskNodeBinding,
  deriveValidatorWorkEvidence,
  verifyValidatorTaskNodeBinding,
  verifyValidatorWorkEvidence,
} from "../server/validator-work-evidence.js";

const publisher = Wallet.generate("ecdsa-secp256k1");
const wallet = Wallet.generate("ecdsa-secp256k1").classicAddress;
const base = { wallet_address: wallet, write_source: "pointer_derived", source_tx_hash: "A".repeat(64), source_cid: "QmSource", event_digest: "b".repeat(64) };
const events = [
  { ...base, task_id: "task-1", event_type: "pf.task.offer.v1", occurred_at: "2026-08-01T00:00:00.000Z", payload_json: { offer: { task_kind: "network" } } },
  { ...base, source_tx_hash: "C".repeat(64), event_digest: "d".repeat(64), task_id: "task-1", event_type: "pf.reward.v1", occurred_at: "2026-08-02T00:00:00.000Z", payload_json: { reward_decision: "full_reward" } },
  { ...base, write_source: "server_direct", source_tx_hash: "E".repeat(64), event_digest: "e".repeat(64), task_id: "task-direct", event_type: "pf.task.offer.v1", occurred_at: "2026-08-03T00:00:00.000Z", payload_json: { offer: { task_kind: "network" } } },
  { ...base, write_source: "server_direct", source_tx_hash: "F".repeat(64), event_digest: "f".repeat(64), task_id: "task-direct", event_type: "pf.reward.v1", occurred_at: "2026-08-04T00:00:00.000Z", payload_json: { reward_decision: "full_reward" } },
];
const args = { accountId: "acct-test", walletAddress: wallet, events, badges: [{ status: "verified" }], openDisputes: 0, windowEnd: "2026-09-04T00:00:00.000Z", publisherWallet: publisher };
const first = deriveValidatorWorkEvidence(args);
const second = deriveValidatorWorkEvidence({ ...args, events: [...events].reverse() });
assert.deepEqual(first, second);
assert.equal(first.mode, "SHADOW_ONLY");
assert.equal(first.metrics.accepted_network_tasks, 1);
assert.equal(first.source_events.length, 2);
assert.equal(verifyValidatorWorkEvidence(first), true);
assert.equal(verifyValidatorWorkEvidence(first, { expectedPublisherAddress: publisher.classicAddress }), true);
assert.equal(verifyValidatorWorkEvidence(first, { expectedPublisherAddress: wallet }), false);
assert.equal(verifyValidatorWorkEvidence({ ...first, accountability_score: 100 }), false);
assert.equal(verifyValidatorWorkEvidence({ ...first, policy: { ...first.policy, windowDays: 30 } }), false);
const validator = Wallet.generate("ecdsa-secp256k1");
const taskNode = Wallet.generate("ecdsa-secp256k1");
const binding = deriveValidatorTaskNodeBinding({
  validatorId: "validator-test",
  l1PublicKeyHash: "sha256:validator-test-key",
  validatorWallet: validator,
  taskNodeWallet: taskNode,
  issuedAt: "2026-09-04T00:00:00.000Z",
});
assert.equal(binding.mode, "SHADOW_ONLY");
assert.equal(verifyValidatorTaskNodeBinding(binding), true);
assert.equal(verifyValidatorTaskNodeBinding({ ...binding, tasknode_wallet: wallet }), false);
assert.equal(verifyValidatorTaskNodeBinding({ ...binding, binding: { ...binding.binding, validator_id: "validator-impostor" } }), false);
console.log("validator work evidence smoke: ok");
