// Idempotent canonical-to-mirror repair. No task lifecycle or reward actions.
import { query, transactionCommand, closePool } from "/app/server/db/pool.js";
import { syncNetworkTaskProjection } from "/app/server/repositories/network-task-generation-jobs.js";
const candidates = await query("SELECT a.id AS allocation_id,p.task_id,p.status AS canonical_status,a.allocation_status FROM network_task_allocations a JOIN task_projections p ON p.task_id=a.generated_task_id WHERE a.allocation_status IS DISTINCT FROM p.status ORDER BY a.id LIMIT 100");
const repaired = [];
try {
  for (const row of candidates.rows) {
    const result = await transactionCommand(async () => {
      // Hold the canonical row while re-reading/syncing all dependent mirrors.
      await query("SELECT task_id FROM task_projections WHERE task_id=$1 FOR UPDATE", [row.task_id]);
      return syncNetworkTaskProjection({ taskId: row.task_id });
    });
    repaired.push({ ...row, result });
  }
  const remaining = await query("SELECT count(*)::int AS count FROM network_task_allocations a JOIN task_projections p ON p.task_id=a.generated_task_id WHERE a.allocation_status IS DISTINCT FROM p.status");
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), candidates: candidates.rowCount, repaired, remaining: remaining.rows[0].count, taskLifecycleActions: 0, rewardActions: 0 }, null, 2));
} finally { await closePool(); }
