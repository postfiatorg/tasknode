import assert from "node:assert/strict";
import {
  affectedWalletsForTransactionEvent,
  pftlCacheWatcherConfig,
} from "../server/pftl-cache-watcher.js";
import { readPftlAccountPreviousTxnId } from "../server/pftl-cache-sync.js";

const watchedA = "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx";
const watchedB = "rKt4peDoQ4YMq7AHvRtQnMZR3LAeAf6pQE";
const outsider = "rKpDXxQbVE49D3g1X7Ak9UcszJpzz7MfnL";

const event = {
  type: "transaction",
  validated: true,
  transaction: {
    TransactionType: "Payment",
    Account: outsider,
    Destination: watchedA,
    hash: "WATCHER_SMOKE_HASH",
  },
  meta: {
    TransactionResult: "tesSUCCESS",
    AffectedNodes: [
      {
        ModifiedNode: {
          LedgerEntryType: "AccountRoot",
          FinalFields: { Account: watchedB },
        },
      },
    ],
  },
};

assert.deepEqual(
  affectedWalletsForTransactionEvent(event, [watchedA, watchedB]).sort(),
  [watchedA, watchedB].sort()
);
assert.deepEqual(affectedWalletsForTransactionEvent(event, [outsider]), [outsider]);
assert.deepEqual(affectedWalletsForTransactionEvent({ transaction: { hash: "NO_MATCH" } }, [watchedA, watchedB]), []);
assert.deepEqual(affectedWalletsForTransactionEvent({ transaction: { hash: "SINGLE_FALLBACK" } }, [watchedA]), [watchedA]);

const config = pftlCacheWatcherConfig({
  PFTL_CACHE_WSS_WATCHER_ENABLED: "true",
  PFTL_RPC_URL: "https://rpc.testnet.postfiat.org",
});
assert.equal(config.enabled, true);
assert.ok(config.endpoints.includes("wss://ws.testnet.postfiat.org/"));

const previous = await readPftlAccountPreviousTxnId({
  walletAddress: watchedA,
  env: {
    PFTL_RPC_URL: "https://rpc.example",
    PFTL_RPC_API_KEY: "secret",
  },
  fetchImpl: async (url, options) => {
    assert.equal(url, "https://rpc.example");
    assert.equal(options.headers["X-Api-Key"], "secret");
    const body = JSON.parse(options.body);
    assert.equal(body.method, "account_info");
    assert.equal(body.params[0].account, watchedA);
    return {
      ok: true,
      json: async () => ({
        result: {
          ledger_index: 99,
          account_data: { PreviousTxnID: "ABC123" },
        },
      }),
    };
  },
});
assert.equal(previous.ok, true);
assert.equal(previous.previousTxnId, "ABC123");
assert.equal(previous.ledgerIndex, 99);

console.log("pftl cache watcher smoke ok");
