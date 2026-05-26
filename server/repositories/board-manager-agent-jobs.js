import { databaseEnabled, query } from "../db/pool.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function internalJobFilterSql(includeInternal = false) {
  return includeInternal
    ? ""
    : "AND lower(trigger) NOT LIKE '%smoke%' AND lower(COALESCE(claimed_by, '')) NOT LIKE '%smoke%'";
}

export async function activeBoardManagerJobs({ limit = 5, includeInternal = false } = {}) {
  if (!databaseEnabled()) return [];
  const exists = await query("SELECT to_regclass('public.board_manager_jobs') AS name");
  if (!exists.rows[0]?.name) return [];
  const result = await query(
    `
      SELECT id, scope, trigger, reason, status, claimed_by, run_after,
             claimed_at, created_at, updated_at
      FROM board_manager_jobs
      WHERE COALESCE(run_id, '') = ''
        AND (
          status = 'running'
          OR (status = 'queued' AND run_after <= now())
        )
        AND NOT EXISTS (
          SELECT 1
          FROM board_manager_runs r
          WHERE r.scope = board_manager_jobs.scope
            AND r.status = 'completed'
            AND r.completed_at >= COALESCE(
              board_manager_jobs.claimed_at,
              board_manager_jobs.run_after,
              board_manager_jobs.created_at
            )
        )
        ${internalJobFilterSql(includeInternal)}
      ORDER BY COALESCE(claimed_at, run_after, created_at) DESC, id DESC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 5, 1), 10)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    trigger: row.trigger,
    reason: row.reason,
    status: row.status,
    claimedBy: row.claimed_by,
    runAfter: iso(row.run_after),
    claimedAt: iso(row.claimed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}
