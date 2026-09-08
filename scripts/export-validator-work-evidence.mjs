#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Wallet } from "xrpl";
import {
  deriveValidatorTaskNodeBinding,
  deriveValidatorWorkEvidence,
  verifyValidatorTaskNodeBinding,
  verifyValidatorWorkEvidence,
} from "../server/validator-work-evidence.js";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    evidence: { type: "string" },
    binding: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: TASKNODE_ACCOUNT_SEED=... TASKNODE_PUBLISHER_SEED=... VALIDATOR_MASTER_SEED=... node scripts/export-validator-work-evidence.mjs --input input.json --evidence evidence.json --binding binding.json");
  process.exit(0);
}

if (!values.input || !values.evidence || !values.binding) {
  throw new Error("input_evidence_and_binding_paths_required");
}
if (!process.env.TASKNODE_ACCOUNT_SEED || !process.env.TASKNODE_PUBLISHER_SEED || !process.env.VALIDATOR_MASTER_SEED) {
  throw new Error("tasknode_account_publisher_and_validator_master_seeds_required");
}

const input = JSON.parse(await readFile(values.input, "utf8"));
const taskNodeWallet = Wallet.fromSeed(process.env.TASKNODE_ACCOUNT_SEED, { algorithm: "ecdsa-secp256k1" });
const publisherWallet = Wallet.fromSeed(process.env.TASKNODE_PUBLISHER_SEED, { algorithm: "ecdsa-secp256k1" });
const validatorWallet = Wallet.fromSeed(process.env.VALIDATOR_MASTER_SEED, { algorithm: "ecdsa-secp256k1" });
const evidence = deriveValidatorWorkEvidence({
  accountId: input.account_id,
  walletAddress: taskNodeWallet.classicAddress,
  events: input.events,
  badges: input.badges,
  openDisputes: input.open_disputes,
  windowEnd: input.window_end,
  publisherWallet,
});
const binding = deriveValidatorTaskNodeBinding({
  validatorId: input.validator_id,
  l1PublicKeyHash: input.l1_public_key_hash,
  validatorWallet,
  taskNodeWallet,
  issuedAt: input.issued_at,
});
if (!verifyValidatorWorkEvidence(evidence, { expectedPublisherAddress: publisherWallet.classicAddress }) || !verifyValidatorTaskNodeBinding(binding)) {
  throw new Error("generated_validator_work_documents_failed_verification");
}

await writeFile(values.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await writeFile(values.binding, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`evidence=${values.evidence}`);
console.log(`binding=${values.binding}`);
console.log("mode=SHADOW_ONLY");
console.log(`tasknode_wallet=${taskNodeWallet.classicAddress}`);
console.log(`accountability_score=${evidence.accountability_score}`);
