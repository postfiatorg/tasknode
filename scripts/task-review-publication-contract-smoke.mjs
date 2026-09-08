import assert from "node:assert/strict";
import { publishAuthorityPointer } from "../server/task-review-publication.js";

const calls = [];
const txJson = { Account: "rSigner", Destination: "rRecipient", Amount: "4000000", Sequence: 42, LastLedgerSequence: 900 };
const hash = "A".repeat(64);
const cid = "Qm11111111111111111111111111111111111111111111";
const input = { payload: { schema: "pf.reward.v1", task_id: "task_publication_fixture" }, destination: txJson.Destination,
  signerWallet: { classicAddress: txJson.Account, sign: (tx) => { assert.deepEqual(tx, txJson); return { tx_blob: "AB", hash }; } },
  onPrepared: async (receipt) => {
    assert.deepEqual(receipt, { tx_hash: hash, cid, account: txJson.Account, destination: txJson.Destination, amount_drops: txJson.Amount, sequence: txJson.Sequence, last_ledger_sequence: txJson.LastLedgerSequence });
    calls.push("durable_receipt");
  },
};
const dependencies = {
  recipientKeys: async () => [], encryptPayload: async () => ({}),
  pinPayload: async () => ({ cid, sha256: "fixture" }),
  prepareTransaction: async () => ({ txJson }),
  submitTransaction: async () => { calls.push("submit"); return { txHash: hash }; },
};
assert.equal((await publishAuthorityPointer(input, dependencies)).txHash, hash);
assert.deepEqual(calls, ["durable_receipt", "submit"]);
calls.length = 0;
await assert.rejects(publishAuthorityPointer({ ...input, onPrepared: async () => { throw new Error("receipt_store_unavailable"); } }, dependencies), (error) => error.submissionAttempted === false && error.submissionStage === "persist_transaction_receipt");
assert.deepEqual(calls, [], "storage failure must prevent payment submission");
await assert.rejects(publishAuthorityPointer(input, { ...dependencies, submitTransaction: async () => { throw new Error("response_lost"); } }), (error) => error.submissionAttempted === true && error.submissionStage === "transaction_submit");
console.log(JSON.stringify({ ok: true, preparedTransactionContract: true, receiptBeforeSubmit: true, storageFailureBlocksPayment: true, uncertainSubmissionPreserved: true }));
