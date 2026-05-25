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

const defaultBoardManagerMaxActionsPerHour = 8;
const boardManagerRateLimitExclusions = Object.freeze([
  "",
  "do_nothing",
  "daily_airdrop",
]);

function timestampValue(value = null, fallback = new Date()) {
  if (!value) return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function nullableTimestampValue(value = null) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function ensureBoardManagerScope({
  scope = "global_hive",
  status = null,
  cadenceSeconds = 900,
  maxActionsPerHour = defaultBoardManagerMaxActionsPerHour,
  nextRunAt = null,
  metadata = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedScope = safeText(scope, 120) || "global_hive";
  const hasStatus = ["enabled", "paused", "disabled"].includes(status);
  const normalizedStatus = hasStatus ? status : "enabled";
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
        status = CASE WHEN $8 THEN EXCLUDED.status ELSE board_manager_scopes.status END,
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
      clampInt(maxActionsPerHour, defaultBoardManagerMaxActionsPerHour, 0, 200),
      timestampValue(nextRunAt),
      jsonValue(metadata),
      hasNextRunAt,
      hasStatus,
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

export async function findCompletedBoardManagerRunSince({
  scope = "global_hive",
  since = null,
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedScope = safeText(scope, 120) || "global_hive";
  const sinceAt = nullableTimestampValue(since);
  if (!sinceAt) return { ok: false, skipped: true, reason: "since_missing" };
  const result = await query(
    `
      SELECT id, scope, trigger, selected_action, completed_at
      FROM board_manager_runs
      WHERE scope = $1
        AND status = 'completed'
        AND completed_at >= $2
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedScope, sinceAt]
  );
  return {
    ok: true,
    run: result.rows[0] || null,
    since: sinceAt.toISOString(),
  };
}

export async function shouldSkipBoardManagerJobForRecentRun({ job = {} } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const metadata = job?.metadata_json && typeof job.metadata_json === "object"
    ? job.metadata_json
    : {};
  const since = metadata.skip_if_completed_after || metadata.state_changed_at || "";
  if (!since) return { ok: true, skip: false, reason: "recent_run_boundary_missing" };
  const recent = await findCompletedBoardManagerRunSince({
    scope: job.scope || "global_hive",
    since,
  });
  if (!recent.ok) return { ok: true, skip: false, reason: recent.reason || "recent_run_check_failed" };
  return {
    ok: true,
    skip: Boolean(recent.run),
    reason: recent.run ? "recent_board_manager_run_after_trigger" : "no_recent_run_after_trigger",
    run: recent.run,
    since: recent.since,
  };
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
    const maxActionsPerHour = Number(scopeRow?.max_actions_per_hour ?? defaultBoardManagerMaxActionsPerHour);
    if (scopeRow && maxActionsPerHour >= 0) {
      const recentActions = await client.query(
        `
          SELECT count(*)::int AS count
          FROM board_manager_runs
          WHERE scope = $1
            AND status = 'completed'
            AND dry_run = false
            AND NOT (selected_action = ANY($2::text[]))
            AND completed_at > now() - interval '1 hour'
        `,
        [scopeRow.scope, boardManagerRateLimitExclusions]
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

export async function recoverStaleBoardManagerJobs({
  scope = "",
  staleSeconds = 900,
  limit = 10,
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedScope = safeText(scope, 120);
  const normalizedStaleSeconds = clampInt(staleSeconds, 900, 60, 86400);
  const normalizedLimit = clampInt(limit, 10, 1, 100);
  const result = await query(
    `
      WITH stale_jobs AS (
        SELECT id
        FROM board_manager_jobs
        WHERE ($1 = '' OR scope = $1)
          AND status = 'running'
          AND COALESCE(claimed_at, updated_at, created_at) <= now() - ($2::text || ' seconds')::interval
        ORDER BY COALESCE(claimed_at, updated_at, created_at) ASC, id ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      UPDATE board_manager_jobs j
      SET status = CASE WHEN j.attempt_count >= j.max_attempts THEN 'failed' ELSE 'deferred' END,
          run_after = CASE WHEN j.attempt_count >= j.max_attempts THEN j.run_after ELSE now() END,
          failed_at = CASE WHEN j.attempt_count >= j.max_attempts THEN now() ELSE j.failed_at END,
          last_error = $4,
          updated_at = now()
      FROM stale_jobs
      WHERE j.id = stale_jobs.id
      RETURNING j.*
    `,
    [
      normalizedScope,
      String(normalizedStaleSeconds),
      normalizedLimit,
      `stale_board_manager_job_recovered_after_${normalizedStaleSeconds}s`,
    ]
  );
  return {
    ok: true,
    recovered: result.rows.length,
    jobs: result.rows,
  };
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
