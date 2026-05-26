import assert from "node:assert/strict";
import { closePool, query } from "../server/db/pool.js";
import { readCachedAccountTx } from "../server/pftl-cache-sync.js";
import { buildPftPointerMemo } from "../server/pftl-pointer.js";
import {
  listCachedAccountTx,
  markPftlSyncWalletChecked,
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
const recoverTxHash = `${txHash}_recover`;
const accountId = "acct_pftl_cache_smoke";

const pointer = buildPftPointerMemo({
  cid: "bafypftlcachesmoke",
  kind: "CONTEXT",
  schema: 1,
  contextId: "ctx-pftl-cache-smoke",
});

async function cleanup() {
  await query("DELETE FROM pftl_pointer_memos WHERE tx_hash = ANY($1)", [[txHash, recoverTxHash]]);
  await query("DELETE FROM pftl_wallet_transactions WHERE tx_hash = ANY($1)", [[txHash, recoverTxHash]]);
  await query("DELETE FROM pftl_transactions WHERE tx_hash = ANY($1)", [[txHash, recoverTxHash]]);
  await query("DELETE FROM pftl_sync_wallets WHERE wallet_address = $1 AND account_id = $2", [
    walletAddress,
    accountId,
  ]);
}

try {
  await cleanup();
  await registerPftlSyncWallet({
    walletAddress,
    accountId,
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

  const failedPointer = buildPftPointerMemo({
    cid: "bafypftlcacherecover",
    kind: "CONTEXT",
    schema: 1,
    contextId: "ctx-pftl-cache-recover",
  });
  await storePftlAccountTransactions({
    walletAddress,
    transactions: [
      {
        tx: {
          TransactionType: "Payment",
          Account: counterparty,
          Destination: walletAddress,
          Amount: "12000000",
          Fee: "12",
          date: 831600001,
          hash: recoverTxHash,
          Memos: [
            {
              Memo: {
                MemoType: failedPointer.memoTypeHex,
                MemoFormat: failedPointer.memoFormatHex,
                MemoData: "01020304",
              },
            },
          ],
        },
        meta: { TransactionResult: "tesSUCCESS", delivered_amount: "12000000" },
        validated: true,
        ledger_index: 456790,
      },
    ],
  });
  const failedRow = await query(
    "SELECT decode_error, cid FROM pftl_pointer_memos WHERE tx_hash = $1",
    [recoverTxHash]
  );
  assert.equal(failedRow.rows.length, 1);
  assert.equal(failedRow.rows[0].decode_error, "pointer_decode_failed");
  assert.equal(failedRow.rows[0].cid, null);

  await storePftlAccountTransactions({
    walletAddress,
    transactions: [
      {
        tx: {
          TransactionType: "Payment",
          Account: counterparty,
          Destination: walletAddress,
          Amount: "12000000",
          Fee: "12",
          date: 831600002,
          hash: recoverTxHash,
          Memos: [
            {
              Memo: {
                MemoType: failedPointer.memoTypeHex,
                MemoFormat: failedPointer.memoFormatHex,
                MemoData: failedPointer.memoDataHex,
              },
            },
          ],
        },
        meta: { TransactionResult: "tesSUCCESS", delivered_amount: "12000000" },
        validated: true,
        ledger_index: 456791,
      },
    ],
  });
  const recoveredRow = await query(
    "SELECT decode_error, cid FROM pftl_pointer_memos WHERE tx_hash = $1",
    [recoverTxHash]
  );
  assert.equal(recoveredRow.rows.length, 1);
  assert.equal(recoveredRow.rows[0].decode_error, null);
  assert.equal(recoveredRow.rows[0].cid, "bafypftlcacherecover");

  await query(
    `
      UPDATE pftl_sync_wallets
      SET last_hot_sync_at = now() - INTERVAL '1 hour',
          last_error = 'stale_before_check'
      WHERE wallet_address = $1
    `,
    [walletAddress]
  );
  const checked = await markPftlSyncWalletChecked({ walletAddress, previousTxnId: recoverTxHash });
  assert.equal(checked.ok, true);
  const checkedRow = await query(
    "SELECT last_hot_sync_at > now() - INTERVAL '5 seconds' AS hot_current, last_seen_tx_hash, last_error FROM pftl_sync_wallets WHERE wallet_address = $1",
    [walletAddress]
  );
  assert.equal(checkedRow.rows[0].hot_current, true);
  assert.equal(checkedRow.rows[0].last_seen_tx_hash, recoverTxHash);
  assert.equal(checkedRow.rows[0].last_error, null);

  await query(
    `
      UPDATE pftl_sync_wallets
      SET archive_marker = $2::jsonb,
          last_hot_sync_at = now()
      WHERE wallet_address = $1
    `,
    [walletAddress, JSON.stringify({ complete: false })]
  );
  const partialArchive = await readCachedAccountTx({
    walletAddress,
    accountId,
    limit: 5,
    forceSync: false,
    syncIfEmpty: false,
  });
  assert.equal(partialArchive.sync.status, "archive_incomplete");
  assert.equal(partialArchive.sync.archiveComplete, false);

  const inactive = await markPftlSyncWalletInactive({ walletAddress, reason: "smoke_cleanup" });
  assert.equal(inactive.ok, true);
  console.log("pftl cache postgres smoke ok");
} finally {
  await cleanup().catch(() => {});
  await closePool();
}
