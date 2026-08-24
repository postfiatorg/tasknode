import assert from "node:assert/strict";
import {
  publicPftlCacheSyncState,
  validatePftlSyncWalletForWorker,
} from "../server/pftl-cache-sync.js";

const syncing = publicPftlCacheSyncState(null, { transactionCount: 0 });
assert.equal(syncing.status, "syncing");
assert.equal(syncing.archiveComplete, false);

const archiveIncomplete = publicPftlCacheSyncState(
  { archive_marker: { complete: false }, last_hot_sync_at: new Date("2026-05-16T00:00:00.000Z") },
  { transactionCount: 3 }
);
assert.equal(archiveIncomplete.status, "archive_incomplete");
assert.equal(archiveIncomplete.archiveComplete, false);

const ready = publicPftlCacheSyncState(
  { archive_marker: { complete: true }, last_hot_sync_at: new Date("2026-05-16T00:00:00.000Z") },
  { transactionCount: 3 }
);
assert.equal(ready.status, "ready");
assert.equal(ready.archiveComplete, true);

const errorState = publicPftlCacheSyncState(
  { last_error: "rpc_timeout", archive_marker: { complete: false }, last_hot_sync_at: new Date("2026-05-16T00:00:00.000Z") },
  { transactionCount: 1 }
);
assert.equal(errorState.status, "error");

const deactivations = [];
const logEvents = [];
const invalidWallet = await validatePftlSyncWalletForWorker(
  { walletAddress: "rBoardPacketCandidate25186983" },
  {
    deactivateImpl: async (entry) => {
      deactivations.push(entry);
      return { ok: true };
    },
    logger: {
      warn(event, detail) {
        logEvents.push({ event, detail });
      },
    },
  }
);
assert.deepEqual(invalidWallet, {
  ok: true,
  valid: false,
  walletAddress: "rBoardPacketCandidate25186983",
  reason: "invalid_wallet_address",
});
assert.deepEqual(deactivations, [{
  walletAddress: "rBoardPacketCandidate25186983",
  reason: "invalid_wallet_address",
}]);
assert.equal(logEvents[0]?.event, "pftl_invalid_sync_wallet_deactivated");

let validWalletDeactivations = 0;
const validWallet = await validatePftlSyncWalletForWorker(
  { walletAddress: "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx" },
  {
    deactivateImpl: async () => {
      validWalletDeactivations += 1;
      return { ok: true };
    },
  }
);
assert.equal(validWallet.ok, true);
assert.equal(validWallet.valid, true);
assert.equal(validWalletDeactivations, 0);

console.log("pftl cache sync state smoke ok");
