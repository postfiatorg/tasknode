import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  pftlCacheHealthSummary,
  prunePftlCacheRetention,
  recordPftlCacheMaintenanceRun,
} from "../server/repositories/pftl-cache-operations.js";
import {
  recordPftlCacheWatcherState,
  registerPftlSyncWallet,
} from "../server/repositories/pftl-cache.js";

if (!process.env.TASKNODE_DATABASE_ENABLED) process.env.TASKNODE_DATABASE_ENABLED = "true";

const runId = `health_retention_${Date.now()}`;
const walletAddress = Wallet.generate().address;
const oldEventKey = `${runId}:old`;
const recentEventKey = `${runId}:recent`;
const watcherId = `watcher_${runId}`;

async function cleanup() {
  await query("DELETE FROM pftl_cache_reducer_events WHERE dedupe_key = ANY($1)", [
    [oldEventKey, recentEventKey],
  ]);
  await query("DELETE FROM pftl_cache_watcher_state WHERE id = $1", [watcherId]);
  await query("DELETE FROM pftl_cache_maintenance_runs WHERE run_kind = $1", [
    `retention_smoke_${runId}`,
  ]);
  await query("DELETE FROM pftl_sync_wallets WHERE wallet_address = $1", [walletAddress]);
}

try {
  await migrateDatabase();
  await cleanup();

  await registerPftlSyncWallet({
    walletAddress,
    accountId: runId,
    role: "user",
    priority: 1,
    metadata: { smoke: true },
  });
  await query(
    `
      UPDATE pftl_sync_wallets
      SET last_hot_sync_at = now() - INTERVAL '2 hours',
          archive_marker = '{"complete": false, "marker": {"ledger": 7}}'::jsonb,
          last_archive_sync_at = now() - INTERVAL '2 days',
          last_error = 'smoke sync warning'
      WHERE wallet_address = $1
    `,
    [walletAddress]
  );
  await recordPftlCacheWatcherState({
    id: watcherId,
    endpointUrl: "wss://cache-health.example",
    status: "connected",
    subscribedWalletCount: 1,
    lastLedgerIndex: 12345,
    lastEventTxHash: `${runId}_tx`,
  });
  await query(
    `
      INSERT INTO pftl_cache_reducer_events (
        dedupe_key,
        wallet_address,
        tx_hash,
        reducer_kind,
        status,
        processed_at
      )
      VALUES
        ($1,$3,$4,'wallet_balance_refresh','completed',now() - INTERVAL '3 days'),
        ($2,$3,$5,'wallet_balance_refresh','completed',now())
    `,
    [oldEventKey, recentEventKey, walletAddress, `${runId}_old_tx`, `${runId}_recent_tx`]
  );
  await recordPftlCacheMaintenanceRun({
    runKind: `retention_smoke_${runId}`,
    status: "completed",
    metrics: { smoke: true },
  });

  const health = await pftlCacheHealthSummary({
    hotStaleMs: 60_000,
    archiveStaleMs: 60_000,
    recentLimit: 20,
  });
  assert.equal(health.ok, true);
  assert.ok(health.wallets.active >= 1);
  assert.ok(health.wallets.hot_stale >= 1);
  assert.ok(health.wallets.archive_incomplete >= 1);
  assert.ok(health.wallets.archive_stale >= 1);
  assert.ok(health.wallets.error_count >= 1);
  assert.ok(health.reducerQueue.completed >= 2);
  assert.ok(health.watchers.some((row) => row.id === watcherId));
  assert.ok(health.recentErrors.some((row) => row.wallet_address === walletAddress));
  assert.ok(health.maintenanceRuns.some((row) => row.run_kind === `retention_smoke_${runId}`));

  const dryRun = await prunePftlCacheRetention({
    completedReducerEventDays: 1,
    walletAddress,
    dryRun: true,
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.deleted.completedReducerEvents, 0);
  assert.ok(dryRun.candidates.completedReducerEvents >= 1);

  const retention = await prunePftlCacheRetention({
    completedReducerEventDays: 1,
    walletAddress,
    dryRun: false,
  });
  assert.equal(retention.ok, true);
  assert.ok(retention.deleted.completedReducerEvents >= 1);

  const remaining = await query(
    "SELECT dedupe_key FROM pftl_cache_reducer_events WHERE dedupe_key = ANY($1)",
    [[oldEventKey, recentEventKey]]
  );
  assert.deepEqual(remaining.rows.map((row) => row.dedupe_key), [recentEventKey]);

  console.log("pftl cache health retention postgres smoke ok");
} finally {
  await cleanup().catch(() => {});
  await closePool();
}
