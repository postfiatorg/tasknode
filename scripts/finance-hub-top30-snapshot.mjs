#!/usr/bin/env node
import { closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { runDailyTop30SnapshotJob } from "../server/finance-hub-top30.js";

const dryRun = process.argv.includes("--dry-run");

try {
  await migrateDatabase();
  const result = await runDailyTop30SnapshotJob({ dryRun });
  console.log(JSON.stringify({
    ok: result.ok,
    dryRun,
    retainedFallback: result.retainedFallback,
    snapshotId: result.snapshot?.snapshot_id || null,
    status: result.snapshot?.status || null,
    summary: result.snapshot?.summary || null,
    ...(result.error ? { error: result.error } : {}),
  }, null, 2));
  if (!result.ok && !result.retainedFallback) process.exitCode = 1;
} finally {
  await closePool();
}
