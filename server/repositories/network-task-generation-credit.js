import { databaseEnabled, query } from "../db/pool.js";
import { jsonValue, safeText } from "./network-tasks-utils.js";

// Credit outage: keep the job (and its allocation) queued instead of failing
// it, without spending its automatic retry budget. The worker releases parked
// jobs when gateway credits return; the delay is the fallback.
export async function parkNetworkTaskGenerationJobForCredits({ jobId = "", workerAttemptId = "", error = "", retryDelayMs = 60_000, failure = {} } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  const delayMs = Math.min(Math.max(Number(retryDelayMs) || 60_000, 1_000), 15 * 60 * 1000);
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET status = 'queued',
          next_attempt_at = now() + ($4::integer * interval '1 millisecond'),
          locked_at = NULL,
          last_error = $2,
          generated_task_payload = generated_task_payload || jsonb_build_object(
            'manualRetryAttemptBase', attempt_count,
            'generationFailure', $5::jsonb,
            'creditOutage', jsonb_build_object(
              'since', COALESCE(generated_task_payload->'creditOutage'->>'since', now()::text),
              'lastParkedAt', now(),
              'parks', COALESCE((generated_task_payload->'creditOutage'->>'parks')::integer, 0) + 1,
              'code', $2::text,
              'retryDelayMs', $4::integer
            )
          ),
          updated_at = now()
      WHERE id = $1
        AND status = 'running' AND worker_attempt_id = $3
      RETURNING *
    `,
    [safeText(jobId, 180), safeText(error, 1000), safeText(workerAttemptId, 180), delayMs, jsonValue(failure)]
  );
  const row = result.rows[0] || null;
  return { ok: Boolean(row), stale: !row, job: row };
}

export async function releaseCreditParkedNetworkTaskGenerationJobs({ limit = 200 } = {}) {
  if (!databaseEnabled()) return { released: [] };
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET next_attempt_at = now(),
          generated_task_payload = (generated_task_payload - 'creditOutage') || jsonb_build_object(
            'creditOutageHistory', (generated_task_payload->'creditOutage') || jsonb_build_object('releasedAt', now())
          ),
          updated_at = now()
      WHERE id IN (
        SELECT id FROM network_task_generation_jobs
        WHERE status = 'queued' AND generated_task_payload ? 'creditOutage'
        ORDER BY created_at ASC, id ASC
        LIMIT $1
      )
      RETURNING id
    `,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000)]
  );
  return { released: result.rows.map((row) => row.id) };
}
