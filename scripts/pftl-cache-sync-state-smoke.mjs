import assert from "node:assert/strict";
import { publicPftlCacheSyncState } from "../server/pftl-cache-sync.js";

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

console.log("pftl cache sync state smoke ok");
