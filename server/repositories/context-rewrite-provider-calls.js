import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  ageMs,
  jsonValue,
  numeric,
  publicJob,
  safeText,
  staleRunningMs,
  toIso,
} from "./context-rewrite-projection.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function useDatabase() {
  return databaseEnabled();
}

function expectedLockedBy(job = {}) {
  return safeText(job?.lockedBy || job?.locked_by || "", 120);
}

function currentAttemptId(job = {}) {
  return safeText(job?.currentAttemptId || job?.current_attempt_id || "", 180);
}

export async function addContextRewriteActualCost({ jobId = "", costUsd = 0 } = {}) {
  if (!useDatabase() || !(Number(costUsd) > 0)) return null;
  const result = await query(
    `
      UPDATE context_rewrite_jobs
      SET actual_cost_usd = actual_cost_usd + $2,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [safeText(jobId, 180), numeric(costUsd)]
  );
  return publicJob(result.rows[0], { includeInternal: true });
}

export async function assertContextRewriteBudgetAvailable({ job = {}, stage = "" } = {}) {
  if (!useDatabase()) return true;
  const result = await query(
    `
      SELECT id, actual_cost_usd, max_cost_usd, estimate_cost_usd, status
      FROM context_rewrite_jobs
      WHERE id = $1
      LIMIT 1
    `,
    [safeText(job.id, 180)]
  );
  const row = result.rows[0];
  if (!row || terminalStatuses.has(row.status)) return true;
  const maxCostUsd = numeric(row.max_cost_usd || row.estimate_cost_usd || 0);
  if (!(maxCostUsd > 0)) return true;
  const actualCostUsd = numeric(row.actual_cost_usd);
  if (actualCostUsd < maxCostUsd) return true;
  const error = new Error("context_rewrite_retry_budget_exhausted");
  error.contextRewriteStage = safeText(stage, 80);
  error.actualCostUsd = actualCostUsd;
  error.maxCostUsd = maxCostUsd;
  throw error;
}

export async function createContextRewriteProviderCall({
  job = {},
  stage = "",
  callIndex = 0,
  provider = "ambient",
  model = "",
  requestDigest = "",
  timeoutMs = 0,
  metadata = {},
} = {}) {
  if (!useDatabase()) return null;
  const attemptId = currentAttemptId(job) || `ctxrw_attempt_${randomUUID()}`;
  const timeoutAt = Number(timeoutMs || 0) > 0 ? new Date(Date.now() + Number(timeoutMs)) : null;
  const result = await query(
    `
      INSERT INTO context_rewrite_provider_calls (
        id,
        job_id,
        account_id,
        attempt_id,
        stage,
        call_index,
        provider,
        model,
        status,
        request_digest,
        timeout_at,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10, $11)
      ON CONFLICT (job_id, attempt_id, stage, call_index)
      DO UPDATE SET
        status = CASE
          WHEN context_rewrite_provider_calls.status IN ('completed', 'running')
          THEN context_rewrite_provider_calls.status
          ELSE 'running'
        END,
        heartbeat_at = CASE
          WHEN context_rewrite_provider_calls.status = 'completed'
          THEN context_rewrite_provider_calls.heartbeat_at
          ELSE now()
        END,
        timeout_at = COALESCE(context_rewrite_provider_calls.timeout_at, EXCLUDED.timeout_at),
        updated_at = now()
      RETURNING *
    `,
    [
      `ctxrw_call_${randomUUID()}`,
      job.id,
      job.accountId,
      attemptId,
      safeText(stage, 120),
      Number(callIndex || 0),
      safeText(provider, 80),
      safeText(model, 180),
      safeText(requestDigest, 100),
      timeoutAt,
      jsonValue(metadata),
    ]
  );
  return result.rows[0] || null;
}

export async function heartbeatContextRewriteProviderCall({ job = {}, providerCallId = "" } = {}) {
  if (!useDatabase()) return null;
  const lockedBy = expectedLockedBy(job);
  return transaction(async (client) => {
    const callUpdate = await client.query(
      `
        UPDATE context_rewrite_provider_calls
        SET heartbeat_at = now(),
            updated_at = now()
        WHERE id = $1
          AND status = 'running'
        RETURNING *
      `,
      [safeText(providerCallId, 180)]
    );
    const params = [safeText(job.id, 180)];
    let lockGuard = "";
    if (lockedBy) {
      params.push(lockedBy);
      lockGuard = `AND locked_by = $${params.length}`;
    }
    await client.query(
      `
        UPDATE context_rewrite_jobs
        SET locked_at = now(),
            updated_at = now()
        WHERE id = $1
          AND status = 'running'
          ${lockGuard}
      `,
      params
    );
    return callUpdate.rows[0] || null;
  });
}

export async function finishContextRewriteProviderCall({
  providerCallId = "",
  status = "completed",
  result = {},
  usage = {},
  costUsd = 0,
  error = "",
} = {}) {
  if (!useDatabase() || !providerCallId) return null;
  const finalStatus = safeText(status || "completed", 80);
  const outputText = safeText(result?.text || "", 4000);
  const update = await query(
    `
      UPDATE context_rewrite_provider_calls
      SET status = $2,
          response_id = $3,
          usage_json = $4,
          cost_usd = $5,
          result_json = $6,
          annotations_json = $7::jsonb,
          raw_text_excerpt = $8,
          error = $9,
          completed_at = CASE WHEN $2 <> 'running' THEN now() ELSE completed_at END,
          heartbeat_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      safeText(providerCallId, 180),
      finalStatus,
      result?.responseId || null,
      jsonValue(usage),
      numeric(costUsd),
      jsonValue(result?.parsed || {}),
      JSON.stringify(Array.isArray(result?.annotations) ? result.annotations : []),
      outputText,
      safeText(error, 1000) || null,
    ]
  );
  return update.rows[0] || null;
}

export async function markTimedOutContextRewriteProviderCalls() {
  if (!useDatabase()) return { marked: 0 };
  const result = await query(
    `
      UPDATE context_rewrite_provider_calls
      SET status = CASE
            WHEN timeout_at IS NOT NULL AND timeout_at < now() THEN 'timed_out'
            ELSE 'orphaned'
          END,
          error = COALESCE(error, 'context_rewrite_provider_call_orphaned'),
          completed_at = now(),
          updated_at = now()
      WHERE status = 'running'
        AND (
          (timeout_at IS NOT NULL AND timeout_at < now())
          OR heartbeat_at < now() - ($1 * interval '1 millisecond')
        )
      RETURNING id
    `,
    [staleRunningMs()]
  );
  return { marked: result.rowCount || 0 };
}

export async function listCompletedContextRewriteScoreRuns({ jobId = "" } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT *
      FROM context_rewrite_score_runs
      WHERE job_id = $1
        AND status = 'completed'
      ORDER BY completed_at ASC, created_at ASC, id ASC
    `,
    [safeText(jobId, 180)]
  );
  return result.rows;
}

export async function listCompletedContextRewriteSearchResults({ jobId = "" } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT *
      FROM context_rewrite_search_results
      WHERE job_id = $1
        AND status = 'completed'
      ORDER BY query_index ASC, completed_at ASC, created_at ASC, id ASC
    `,
    [safeText(jobId, 180)]
  );
  return result.rows;
}

export async function getCompletedContextRewriteProviderCall({ jobId = "", stage = "", callIndex = 0 } = {}) {
  if (!useDatabase()) return null;
  const result = await query(
    `
      SELECT *
      FROM context_rewrite_provider_calls
      WHERE job_id = $1
        AND stage = $2
        AND call_index = $3
        AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    `,
    [safeText(jobId, 180), safeText(stage, 120), Number(callIndex || 0)]
  );
  return result.rows[0] || null;
}

export async function contextRewriteWatchdogSnapshot({ limit = 20 } = {}) {
  if (!useDatabase()) {
    return {
      ok: true,
      enabled: false,
      counts: {},
      staleCount: 0,
      runningProviderCallCount: 0,
      timedOutProviderCallCount: 0,
      staleJobs: [],
    };
  }
  const staleMs = staleRunningMs();
  const [jobCounts, staleJobs, providerCounts] = await Promise.all([
    query(
      `
        SELECT status, count(*)::int AS count
        FROM context_rewrite_jobs
        GROUP BY status
      `
    ),
    query(
      `
        SELECT id, account_id, conversation_id, current_stage, retry_count, locked_at, locked_by, updated_at, error
        FROM context_rewrite_jobs
        WHERE status = 'running'
          AND (
            locked_at IS NULL
            OR locked_at < now() - ($1 * interval '1 millisecond')
          )
        ORDER BY COALESCE(locked_at, updated_at, started_at, created_at) ASC
        LIMIT $2
      `,
      [staleMs, Math.min(Math.max(Number(limit) || 20, 1), 100)]
    ),
    query(
      `
        SELECT status, count(*)::int AS count
        FROM context_rewrite_provider_calls
        GROUP BY status
      `
    ).catch(() => ({ rows: [] })),
  ]);
  const counts = {};
  for (const row of jobCounts.rows) counts[row.status || "unknown"] = Number(row.count || 0);
  const providerCallCounts = {};
  for (const row of providerCounts.rows) providerCallCounts[row.status || "unknown"] = Number(row.count || 0);
  return {
    ok: true,
    enabled: true,
    staleAfterMs: staleMs,
    counts,
    providerCallCounts,
    staleCount: staleJobs.rows.length,
    runningProviderCallCount: Number(providerCallCounts.running || 0),
    timedOutProviderCallCount: Number(providerCallCounts.timed_out || 0),
    staleJobs: staleJobs.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      currentStage: row.current_stage,
      retryCount: Number(row.retry_count || 0),
      lockedAt: toIso(row.locked_at),
      lockedBy: row.locked_by || "",
      updatedAt: toIso(row.updated_at),
      elapsedSinceLockMs: ageMs(row.locked_at || row.updated_at),
      error: row.error || "",
    })),
  };
}
