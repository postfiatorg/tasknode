import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { syncPftlWalletArchive } from "../server/pftl-cache-sync.js";

if (!process.env.TASKNODE_DATABASE_ENABLED) process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.PFTL_HISTORY_WSS_URL = "";
process.env.PFTL_HISTORY_WSS_URL_FALLBACKS = "";
process.env.PFTL_HISTORY_RPC_URL = "https://archive.example";
process.env.PFTL_HISTORY_RPC_URL_FALLBACKS = "";

const runId = `archive_smoke_${Date.now()}`;
const walletAddress = Wallet.generate().address;
const counterparty = Wallet.generate().address;
const txHashes = [`PFTL_ARCHIVE_${runId}_1`, `PFTL_ARCHIVE_${runId}_2`];
const pageMarker = { ledger: 910001, seq: 4 };

function txEntry(txHash, ledgerIndex) {
  return {
    tx: {
      TransactionType: "Payment",
      Account: counterparty,
      Destination: walletAddress,
      Amount: "12000000",
      Fee: "12",
      date: 831600000 + ledgerIndex,
      hash: txHash,
      ledger_index: ledgerIndex,
    },
    meta: {
      TransactionResult: "tesSUCCESS",
      delivered_amount: "12000000",
    },
    validated: true,
    ledger_index: ledgerIndex,
  };
}

function archiveFetch() {
  const seenMarkers = [];
  return {
    seenMarkers,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://archive.example");
      const body = JSON.parse(options.body);
      assert.equal(body.method, "account_tx");
      const params = body.params[0];
      assert.equal(params.account, walletAddress);
      seenMarkers.push(params.marker || null);
      if (!params.marker) {
        return {
          ok: true,
          json: async () => ({
            result: {
              transactions: [txEntry(txHashes[0], 910002)],
              marker: pageMarker,
            },
          }),
        };
      }
      assert.deepEqual(params.marker, pageMarker);
      return {
        ok: true,
        json: async () => ({
          result: {
            transactions: [txEntry(txHashes[1], 910001)],
          },
        }),
      };
    },
  };
}

async function cleanup() {
  await query("DELETE FROM pftl_cache_reducer_events WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_pointer_memos WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_wallet_transactions WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_transactions WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_sync_wallets WHERE wallet_address = $1", [walletAddress]);
}

try {
  await migrateDatabase();
  await cleanup();

  const fetcher = archiveFetch();
  const first = await syncPftlWalletArchive({
    walletAddress,
    accountId: runId,
    role: "user",
    maxPages: 1,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(first.ok, true);
  assert.equal(first.complete, false);
  assert.equal(first.nextMarker, "present");
  assert.deepEqual(fetcher.seenMarkers, [null]);

  let checkpoint = await query(
    "SELECT archive_marker, last_archive_ledger FROM pftl_sync_wallets WHERE wallet_address = $1",
    [walletAddress]
  );
  assert.equal(checkpoint.rows[0].archive_marker.complete, false);
  assert.deepEqual(checkpoint.rows[0].archive_marker.marker, pageMarker);
  assert.equal(Number(checkpoint.rows[0].last_archive_ledger), 910002);

  const second = await syncPftlWalletArchive({
    walletAddress,
    accountId: runId,
    role: "user",
    maxPages: 1,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(second.ok, true);
  assert.equal(second.complete, true);
  assert.equal(second.nextMarker, null);
  assert.deepEqual(fetcher.seenMarkers, [null, pageMarker]);

  checkpoint = await query(
    "SELECT archive_marker, last_archive_ledger FROM pftl_sync_wallets WHERE wallet_address = $1",
    [walletAddress]
  );
  assert.equal(checkpoint.rows[0].archive_marker.complete, true);
  assert.equal(checkpoint.rows[0].archive_marker.marker, null);
  assert.equal(Number(checkpoint.rows[0].last_archive_ledger), 910001);

  const cached = await query(
    "SELECT count(*)::int AS count FROM pftl_wallet_transactions WHERE wallet_address = $1 AND tx_hash = ANY($2)",
    [walletAddress, txHashes]
  );
  assert.equal(cached.rows[0].count, 2);

  console.log("pftl cache archive postgres smoke ok");
} finally {
  await cleanup().catch(() => {});
  await closePool();
}
