import { query, transactionCommand, closePool } from "/app/server/db/pool.js";
import { publicTaskRequest } from "/app/server/repositories/task-requests.js";
const requestIds = ["req_7ad873f5e2a06960d8bb01e69b46e0ecb44e19fccc0a4338ab6f165273e018b5", "req_ecb611ad-d41a-47cd-b5dc-05e9984eb7bf", "req_33dcd976-16c8-4663-b21f-bce376fde608"];
try {
  const result = await transactionCommand(async () => {
    await query("SET TRANSACTION READ ONLY");
    const requests = (await query("SELECT * FROM task_requests WHERE request_id=ANY($1::text[]) ORDER BY request_id", [requestIds])).rows.map(row => {
      const item = publicTaskRequest(row);
      return { requestId: item.requestId, status: item.status, lifetimeAttempts: item.workerAttemptCount, cycleAttempts: item.workerCycleAttemptCount, lastError: item.lastError, canRetry: item.canRetry, generatedTaskId: item.generatedTaskId, previousError: item.metadata.exhaustedPreviousError };
    });
    const rounds = (await query("SELECT id,state,created_at,completed_at,jsonb_array_length(duties_json) AS duty_count,results_json FROM board_agent_rounds ORDER BY created_at DESC LIMIT 8")).rows;
    const newJobs = (await query("SELECT id,allocation_id,project_id,status,attempt_count,request_id,task_id,last_error,generated_task_payload->'generationFailure' AS failure,created_at,updated_at FROM network_task_generation_jobs WHERE created_at>='2026-09-19T22:59:00Z' ORDER BY created_at")).rows;
    const recoveredJobs = (await query("SELECT id,allocation_id,project_id,status,attempt_count,request_id,task_id,last_error,generated_task_payload->'generationFailure' AS failure,generated_task_payload->'manualRetryAttemptBase' AS retry_base,created_at,updated_at FROM network_task_generation_jobs WHERE created_at<'2026-09-19T22:59:00Z' AND updated_at>='2026-09-19T22:59:00Z' ORDER BY updated_at")).rows;
    const networkCounts = (await query("SELECT status,count(*)::int AS count FROM network_task_generation_jobs GROUP BY status ORDER BY status")).rows;
    const activeAllocations = (await query("SELECT allocation_status,count(*)::int AS count FROM network_task_allocations WHERE allocation_status IN ('proposed','accepted','submitted','verification_requested','verification_submitted') GROUP BY allocation_status ORDER BY allocation_status")).rows;
    const newOffers = (await query("SELECT task_id,request_id,status,task_kind,created_at FROM task_projections WHERE task_kind IN ('network','alpha') AND created_at>='2026-09-19T22:59:00Z' ORDER BY created_at")).rows;
    const duplicateOffers = (await query("SELECT request_id,count(*)::int AS count FROM task_projections WHERE created_at>='2026-09-19T22:59:00Z' AND request_id<>'' GROUP BY request_id HAVING count(*)>1")).rows;
    const mirrorDivergences = (await query("SELECT count(*)::int AS count FROM network_task_allocations a JOIN task_projections p ON p.task_id=a.generated_task_id WHERE a.allocation_status IS DISTINCT FROM p.status")).rows[0].count;
    const counts = (await query("SELECT status,count(*)::int AS count FROM task_requests WHERE status IN ('queued','generating','published') GROUP BY status")).rows;
    return { observedAt: new Date().toISOString(), readOnly: true, requests, rounds, newJobs, recoveredJobs, networkCounts, activeAllocations, newOffers, duplicateOffers, mirrorDivergences, activeRequests: counts };
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await closePool(); }
