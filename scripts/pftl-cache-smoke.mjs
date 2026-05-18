import assert from "node:assert/strict";
import {
  extractPointerMemosFromTransaction,
  mapPftlTransaction,
} from "../server/repositories/pftl-cache.js";
import { buildPftPointerMemo } from "../server/pftl-pointer.js";

const walletAddress = "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx";
const counterparty = "rKt4peDoQ4YMq7AHvRtQnMZR3LAeAf6pQE";

const pointer = buildPftPointerMemo({
  cid: "bafycachepointer",
  kind: "CONTEXT",
  schema: 1,
  flags: 1,
  contextId: "ctx-cache-smoke",
});

const entry = {
  tx: {
    TransactionType: "Payment",
    Account: counterparty,
    Destination: walletAddress,
    Amount: "12000000",
    Fee: "12",
    date: 831600000,
    hash: "CACHE_TX_HASH",
    Memos: [
      {
        Memo: {
          MemoType: pointer.memoTypeHex,
          MemoFormat: pointer.memoFormatHex,
          MemoData: pointer.memoDataHex,
        },
      },
      {
        Memo: {
          MemoType: Buffer.from("note", "utf8").toString("hex"),
          MemoFormat: Buffer.from("text", "utf8").toString("hex"),
          MemoData: Buffer.from("hello", "utf8").toString("hex"),
        },
      },
    ],
  },
  meta: {
    TransactionResult: "tesSUCCESS",
    delivered_amount: "12000000",
  },
  validated: true,
  ledger_index: 12345,
};

const mapped = mapPftlTransaction(entry, walletAddress);
assert.equal(mapped.txHash, "CACHE_TX_HASH");
assert.equal(mapped.ledgerIndex, 12345);
assert.equal(mapped.txType, "Payment");
assert.equal(mapped.validated, true);
assert.equal(mapped.account, counterparty);
assert.equal(mapped.destination, walletAddress);
assert.equal(mapped.transactionResult, "tesSUCCESS");
assert.equal(mapped.direction, "inbound");
assert.equal(mapped.counterpartyWallet, counterparty);
assert.equal(mapped.deliveredDrops, "12000000");
assert.equal(mapped.feeDrops, "12");

const memos = extractPointerMemosFromTransaction({
  txHash: mapped.txHash,
  tx: mapped.txJson,
  walletAddress,
});
assert.equal(memos.length, 2);
assert.equal(memos[0].memoType, "pf.ptr");
assert.equal(memos[0].memoFormat, "v4");
assert.equal(memos[0].cid, "bafycachepointer");
assert.equal(memos[0].pointerKind, "CONTEXT");
assert.equal(memos[0].schemaVersion, "1");
assert.equal(memos[0].contextId, "ctx-cache-smoke");
assert.equal(memos[0].decodeError, null);
assert.equal(memos[1].memoType, "note");
assert.equal(memos[1].cid, null);

console.log("pftl cache smoke ok");
