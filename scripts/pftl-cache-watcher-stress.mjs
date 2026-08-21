import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, query } from "../server/db/pool.js";
import { buildPftPointerMemo } from "../server/pftl-pointer.js";
import { processPftlCacheTransactionEvent } from "../server/pftl-cache-watcher.js";
import { registerPftlSyncWallet } from "../server/repositories/pftl-cache.js";

if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const authority = Wallet.generate().address;
const runId = `watcher_stress_${Date.now()}`;
const wallets = Array.from({ length: 10 }, (_, index) => ({
  wallet_address: Wallet.generate().address,
  account_id: `acct_${runId}_${index}`,
  role: "user",
  priority: index + 1,
}));
const txHashes = wallets.map((_, index) => `PFTL_WATCHER_STRESS_${runId}_${index}`);

async function cleanup() {
  await query("DELETE FROM pftl_cache_reducer_events WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_pointer_memos WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_wallet_transactions WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_transactions WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_sync_wallets WHERE account_id = ANY($1)", [
    wallets.map((wallet) => wallet.account_id),
  ]);
}

function stressEvent(wallet, index) {
  const isContext = index % 2 === 1;
  const pointer = buildPftPointerMemo({
    cid: `bafywatcherstress${index}`,
    kind: isContext ? "CONTEXT" : "TASK",
    schema: 1,
    taskId: isContext ? "" : `task-${runId}-${index}`,
    contextId: isContext ? `context-${runId}-${index}` : "",
  });
  return {
    type: "transaction",
    validated: true,
    ledger_index: 900000 + index,
    transaction: {
      TransactionType: "Payment",
      Account: authority,
      Destination: wallet.wallet_address,
      Amount: "1000000",
      Fee: "12",
      date: 831600000 + index,
      hash: txHashes[index],
      ledger_index: 900000 + index,
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
      delivered_amount: "1000000",
      AffectedNodes: [
        {
          ModifiedNode: {
            LedgerEntryType: "AccountRoot",
            FinalFields: { Account: wallet.wallet_address, Balance: "1000000" },
          },
        },
      ],
    },
  };
}

try {
  await cleanup();
  for (const wallet of wallets) {
    await registerPftlSyncWallet(wallet);
  }

  for (const [index, wallet] of wallets.entries()) {
    const result = await processPftlCacheTransactionEvent({
      event: stressEvent(wallet, index),
      watchedWallets: wallets,
      source: "pftl_cache_watcher_stress",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.affectedWallets, [wallet.wallet_address]);
    assert.equal(result.reducerEvents, 2);
  }

  const counts = await query(
    `
      SELECT
        (SELECT count(*)::int FROM pftl_transactions WHERE tx_hash = ANY($1)) AS tx_count,
        (SELECT count(*)::int FROM pftl_wallet_transactions WHERE tx_hash = ANY($1)) AS wallet_tx_count,
        (SELECT count(*)::int FROM pftl_pointer_memos WHERE tx_hash = ANY($1)) AS pointer_count,
        (SELECT count(*)::int FROM pftl_cache_reducer_events WHERE tx_hash = ANY($1)) AS reducer_count
    `,
    [txHashes]
  );
  assert.equal(counts.rows[0].tx_count, 10);
  assert.equal(counts.rows[0].wallet_tx_count, 10);
  assert.equal(counts.rows[0].pointer_count, 10);
  assert.equal(counts.rows[0].reducer_count, 20);

  const duplicate = await processPftlCacheTransactionEvent({
    event: stressEvent(wallets[0], 0),
    watchedWallets: wallets,
    source: "pftl_cache_watcher_stress",
  });
  assert.equal(duplicate.ok, true);
  const reducerAfterDuplicate = await query(
    "SELECT count(*)::int AS count FROM pftl_cache_reducer_events WHERE tx_hash = ANY($1)",
    [txHashes]
  );
  assert.equal(reducerAfterDuplicate.rows[0].count, 20);

  console.log("pftl cache watcher 10-wallet stress ok");
} finally {
  await cleanup().catch(() => {});
  await closePool();
}
