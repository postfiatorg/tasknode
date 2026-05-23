import { randomUUID } from "node:crypto";
import { databaseEnabled, isUniqueViolation, query, transaction } from "../db/pool.js";

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function intValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function clampInt(value, fallback, min, max) {
  return Math.min(max, Math.max(min, intValue(value, fallback)));
}

function timestampValue(value = null, fallback = new Date()) {
  if (!value) return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

export async function ensureBoardManagerScope({
  scope = "global_hive",
  status = "enabled",
  cadenceSeconds = 900,
  maxActionsPerHour = 4,
  nextRunAt = null,
  metadata = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedScope = safeText(scope, 120) || "global_hive";
  const normalizedStatus = ["enabled", "paused", "disabled"].includes(status) ? status : "enabled";
  const hasNextRunAt = Boolean(nextRunAt);
  const result = await query(
    `
      INSERT INTO board_manager_scopes (
        scope,
        status,
        cadence_seconds,
        max_actions_per_hour,
        next_run_at,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (scope) DO UPDATE SET
        status = EXCLUDED.status,
        cadence_seconds = EXCLUDED.cadence_seconds,
        max_actions_per_hour = EXCLUDED.max_actions_per_hour,
        next_run_at = CASE WHEN $7 THEN EXCLUDED.next_run_at ELSE board_manager_scopes.next_run_at END,
        metadata_json = board_manager_scopes.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING *
    `,
    [
      normalizedScope,
      normalizedStatus,
      clampInt(cadenceSeconds, 900, 60, 86400),
      clampInt(maxActionsPerHour, 4, 0, 200),
      timestampValue(nextRunAt),
      jsonValue(metadata),
      hasNextRunAt,
    ]
  );
  return { ok: true, scope: result.rows[0] };
}

export async function setBoardManagerScopeStatus({
  scope = "global_hive",
  status = "enabled",
  reason = "",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedStatus = ["enabled", "paused", "disabled"].includes(status) ? status : "enabled";
  const result = await query(
    `
      UPDATE board_manager_scopes
      SET status = $2,
          metadata_json = metadata_json || $3::jsonb,
          updated_at = now()
      WHERE scope = $1
      RETURNING *
    `,
    [
      safeText(scope, 120) || "global_hive",
      normalizedStatus,
      jsonValue({ status_reason: safeText(reason, 1000), status_updated_at: new Date().toISOString() }),
    ]
  );
  return { ok: true, scope: result.rows[0] || null };
}

export async function enqueueBoardManagerJob({
  scope = "global_hive",
  trigger = "manual",
  reason = "",
  idempotencyKey = "",
  runAfter = null,
  maxAttempts = 3,
  metadata = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedScope = safeText(scope, 120) || "global_hive";
  const normalizedIdempotencyKey = safeText(idempotencyKey, 240);
  if (normalizedIdempotencyKey) {
    const existing = await query(
      `
        SELECT *
        FROM board_manager_jobs
        WHERE scope = $1
          AND idempotency_key = $2
          AND status IN ('queued', 'running', 'deferred')
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [normalizedScope, normalizedIdempotencyKey]
    );
    if (existing.rows[0]) {
      return { ok: true, queued: false, reason: "idempotent_job_exists", job: existing.rows[0] };
    }
  }

  try {
    const result = await query(
      `
        INSERT INTO board_manager_jobs (
          id,
          scope,
          trigger,
          reason,
          idempotency_key,
          run_after,
          max_attempts,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING *
      `,
      [
        `boardjob_${randomUUID()}`,
        normalizedScope,
        safeText(trigger, 160) || "manual",
        safeText(reason, 1000),
        normalizedIdempotencyKey,
        timestampValue(runAfter),
        clampInt(maxAttempts, 3, 1, 20),
        jsonValue(metadata),
      ]
    );
    return { ok: true, queued: true, job: result.rows[0] };
  } catch (error) {
    if (!isUniqueViolation(error) || !normalizedIdempotencyKey) throw error;
    const existing = await query(
      `
        SELECT *
        FROM board_manager_jobs
        WHERE scope = $1
          AND idempotency_key = $2
          AND status IN ('queued', 'running', 'deferred')
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [normalizedScope, normalizedIdempotencyKey]
    );
    return { ok: true, queued: false, reason: "idempotent_job_exists", job: existing.rows[0] || null };
  }
}

export async function enqueueDueBoardManagerTicks({ scope = "", limit = 5 } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedScope = safeText(scope, 120);
  return transaction(async (client) => {
    const scopes = await client.query(
      `
        SELECT *
        FROM board_manager_scopes
        WHERE status = 'enabled'
          AND next_run_at <= now()
          AND ($2 = '' OR scope = $2)
        ORDER BY next_run_at ASC, scope ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [Math.min(Math.max(Number(limit) || 5, 1), 25), normalizedScope]
    );
    const jobs = [];
    for (const row of scopes.rows) {
      const dueAt = timestampValue(row.next_run_at);
      const idempotencyKey = `periodic_tick:${row.scope}:${dueAt.toISOString()}`;
      const inserted = await client.query(
        `
          INSERT INTO board_manager_jobs (
            id,
            scope,
            trigger,
            reason,
            idempotency_key,
            run_after,
            metadata_json
          )
          SELECT $1, $2, 'periodic_tick', $3, $4, now(), $5::jsonb
          WHERE NOT EXISTS (
            SELECT 1
            FROM board_manager_jobs
            WHERE scope = $2
              AND idempotency_key = $4
              AND status IN ('queued', 'running', 'deferred')
          )
          RETURNING *
        `,
        [
          `boardjob_${randomUUID()}`,
          row.scope,
          `Periodic Board Manager tick due at ${dueAt.toISOString()}.`,
          idempotencyKey,
          jsonValue({ due_at: dueAt.toISOString(), source: "board_manager_scope" }),
        ]
      );
      if (inserted.rows[0]) jobs.push(inserted.rows[0]);
      await client.query(
        `
          UPDATE board_manager_scopes
          SET last_enqueued_at = now(),
              next_run_at = now() + ($2::text || ' seconds')::interval,
              updated_at = now()
          WHERE scope = $1
        `,
        [row.scope, String(clampInt(row.cadence_seconds, 900, 60, 86400))]
      );
    }
    return { ok: true, enqueued: jobs.length, jobs };
  });
}

export async function claimBoardManagerJob({
  scope = "",
  managerId = `board_manager_worker_${randomUUID()}`,
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedScope = safeText(scope, 120);
  const normalizedManagerId = safeText(managerId, 180) || `board_manager_worker_${randomUUID()}`;
  return transaction(async (client) => {
    const scopeResult = await client.query(
      `
        SELECT scope, max_actions_per_hour
        FROM board_manager_scopes
        WHERE ($1 = '' OR scope = $1)
          AND status = 'enabled'
        ORDER BY scope ASC
        LIMIT 1
      `,
      [normalizedScope]
    );
    const scopeRow = scopeResult.rows[0];
    const maxActionsPerHour = Number(scopeRow?.max_actions_per_hour ?? 4);
    if (scopeRow && maxActionsPerHour >= 0) {
      const recentActions = await client.query(
        `
          SELECT count(*)::int AS count
          FROM board_manager_runs
          WHERE scope = $1
            AND status = 'completed'
            AND dry_run = false
            AND selected_action NOT IN ('', 'do_nothing')
            AND completed_at > now() - interval '1 hour'
        `,
        [scopeRow.scope]
      );
      if (Number(recentActions.rows[0]?.count || 0) >= maxActionsPerHour) {
        return { ok: true, claimed: false, job: null, reason: "action_rate_limited" };
      }
    }
    const selected = await client.query(
      `
        SELECT *
        FROM board_manager_jobs
        WHERE ($1 = '' OR scope = $1)
          AND status IN ('queued', 'deferred')
          AND run_after <= now()
        ORDER BY run_after ASC, created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `,
      [normalizedScope]
    );
    const job = selected.rows[0];
    if (!job) return { ok: true, claimed: false, job: null };
    const updated = await client.query(
      `
        UPDATE board_manager_jobs
        SET status = 'running',
            claimed_by = $2,
            claimed_at = now(),
            attempt_count = attempt_count + 1,
            last_error = '',
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [job.id, normalizedManagerId]
    );
    return { ok: true, claimed: true, managerId: normalizedManagerId, job: updated.rows[0] };
  });
}

export async function completeBoardManagerJob({ jobId = "", runId = "", result = {} } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const updated = await query(
    `
      UPDATE board_manager_jobs
      SET status = 'completed',
          run_id = $2,
          result_json = $3::jsonb,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [safeText(jobId, 180), safeText(runId, 180), jsonValue(result)]
  );
  const job = updated.rows[0] || null;
  if (job?.scope && runId) {
    await query(
      `
        UPDATE board_manager_scopes
        SET last_run_id = $2,
            updated_at = now()
        WHERE scope = $1
      `,
      [job.scope, safeText(runId, 180)]
    ).catch(() => null);
  }
  return { ok: true, job };
}

export async function deferOrFailBoardManagerJob({
  jobId = "",
  error = "",
  retryDelaySeconds = 300,
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const updated = await query(
    `
      UPDATE board_manager_jobs
      SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'deferred' END,
          run_after = CASE
            WHEN attempt_count >= max_attempts THEN run_after
            ELSE now() + ($3::text || ' seconds')::interval
          END,
          failed_at = CASE WHEN attempt_count >= max_attempts THEN now() ELSE failed_at END,
          last_error = $2,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      safeText(jobId, 180),
      safeText(error, 2000),
      String(clampInt(retryDelaySeconds, 300, 5, 86400)),
    ]
  );
  return { ok: true, job: updated.rows[0] || null };
}

export async function listBoardManagerSchedulerStatus({ scope = "global_hive", limit = 20 } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedScope = safeText(scope, 120) || "global_hive";
  const [scopes, jobs, leases] = await Promise.all([
    query("SELECT * FROM board_manager_scopes WHERE scope = $1 LIMIT 1", [normalizedScope]),
    query(
      `
        SELECT id, scope, trigger, reason, status, idempotency_key, run_after,
               attempt_count, max_attempts, claimed_by, claimed_at, completed_at,
               failed_at, run_id, last_error, created_at, updated_at
        FROM board_manager_jobs
        WHERE scope = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `,
      [normalizedScope, Math.min(Math.max(Number(limit) || 20, 1), 100)]
    ),
    query(
      `
        SELECT scope, manager_id, owner_instance, status, claimed_at, heartbeat_at,
               expires_at, metadata_json, updated_at
        FROM board_manager_leases
        WHERE scope = $1
        LIMIT 1
      `,
      [normalizedScope]
    ),
  ]);
  return {
    ok: true,
    scope: scopes.rows[0] || null,
    lease: leases.rows[0] || null,
    jobs: jobs.rows,
  };
}
