import assert from "node:assert/strict";
import { closePool, query } from "../server/db/pool.js";
import { buildPftPointerMemo } from "../server/pftl-pointer.js";
import {
  listCachedAccountTx,
  markPftlSyncWalletInactive,
  registerPftlSyncWallet,
  storePftlAccountTransactions,
} from "../server/repositories/pftl-cache.js";

if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const walletAddress = "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx";
const counterparty = "rKt4peDoQ4YMq7AHvRtQnMZR3LAeAf6pQE";
const txHash = `PFTL_CACHE_SMOKE_${Date.now()}`;

const pointer = buildPftPointerMemo({
  cid: "bafypftlcachesmoke",
  kind: "CONTEXT",
  schema: 1,
  contextId: "ctx-pftl-cache-smoke",
});

async function cleanup() {
  await query("DELETE FROM pftl_pointer_memos WHERE tx_hash = $1", [txHash]);
  await query("DELETE FROM pftl_wallet_transactions WHERE tx_hash = $1", [txHash]);
  await query("DELETE FROM pftl_transactions WHERE tx_hash = $1", [txHash]);
  await query("DELETE FROM pftl_sync_wallets WHERE wallet_address = $1 AND account_id = $2", [
    walletAddress,
    "acct_pftl_cache_smoke",
  ]);
}

try {
  await cleanup();
  await registerPftlSyncWallet({
    walletAddress,
    accountId: "acct_pftl_cache_smoke",
    role: "user",
    priority: 1,
    metadata: { smoke: true },
  });
  const stored = await storePftlAccountTransactions({
    walletAddress,
    transactions: [
      {
        tx: {
          TransactionType: "Payment",
          Account: counterparty,
          Destination: walletAddress,
          Amount: "12000000",
          Fee: "12",
          date: 831600000,
          hash: txHash,
          Memos: [
            {
              Memo: {
                MemoType: pointer.memoTypeHex,
                MemoFormat: pointer.memoFormatHex,
                MemoData: pointer.memoDataHex,
              },
            },
          ],
        },
        meta: {
          TransactionResult: "tesSUCCESS",
          delivered_amount: "12000000",
        },
        validated: true,
        ledger_index: 456789,
      },
    ],
  });
  assert.equal(stored.ok, true);
  assert.equal(stored.inserted, 1);
  assert.equal(stored.pointerCount, 1);

  const cached = await listCachedAccountTx({ walletAddress, limit: 5 });
  const row = cached.transactions.find((item) => item.tx_hash === txHash);
  assert.ok(row);
  assert.equal(row.tx_json.Account, counterparty);
  assert.equal(row.meta_json.TransactionResult, "tesSUCCESS");

  const pointers = await query(
    "SELECT cid, pointer_kind, context_id FROM pftl_pointer_memos WHERE tx_hash = $1",
    [txHash]
  );
  assert.equal(pointers.rows.length, 1);
  assert.equal(pointers.rows[0].cid, "bafypftlcachesmoke");
  assert.equal(pointers.rows[0].pointer_kind, "CONTEXT");
  assert.equal(pointers.rows[0].context_id, "ctx-pftl-cache-smoke");

  const inactive = await markPftlSyncWalletInactive({ walletAddress, reason: "smoke_cleanup" });
  assert.equal(inactive.ok, true);
  console.log("pftl cache postgres smoke ok");
} finally {
  await cleanup().catch(() => {});
  await closePool();
}
