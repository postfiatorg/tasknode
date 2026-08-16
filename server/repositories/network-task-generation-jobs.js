import { databaseEnabled, query, transaction } from "../db/pool.js";
import { resolveBoardManagerFollowupsForTaskState } from "./board-manager-state.js";
import { enqueueNetworkTaskRewardFollowup } from "./network-task-reward-followup.js";
import { recordUserObservabilityEvent } from "./user-observability.js";
import { syncNetworkTaskAllocationMirrors } from "./network-task-allocation-sync.js";
import {
  allocationStatusForTaskStatus,
  jsonValue,
  numeric,
  safeObject,
  safeText,
  toIso,
} from "./network-tasks-utils.js";
import { intentStatusForAllocationStatus } from "./network-task-generation-source.js";

function useDatabase() {
  return databaseEnabled();
}

export async function claimNetworkTaskGenerationJobs({ limit = 1 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      WITH next_jobs AS (
        SELECT id
        FROM network_task_generation_jobs
        WHERE status = 'queued'
          AND next_attempt_at <= now()
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE network_task_generation_jobs job
      SET status = 'running',
          locked_at = now(),
          attempt_count = job.attempt_count + 1,
          last_error = '',
          updated_at = now()
      FROM next_jobs
      WHERE job.id = next_jobs.id
      RETURNING job.*
    `,
    [Math.min(Math.max(Number(limit || 1), 1), 5)]
  );
  return result.rows;
}

export async function reclaimStaleNetworkTaskGenerationJobs({ staleMinutes = 5, limit = 10 } = {}) {
  if (!useDatabase()) return [];
  const safeStaleMinutes = Math.min(Math.max(Number(staleMinutes) || 5, 1), 24 * 60);
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const result = await query(
    `
      SELECT id
      FROM network_task_generation_jobs
      WHERE status = 'running'
        AND locked_at < now() - ($1::integer * interval '1 minute')
      ORDER BY locked_at ASC, id ASC
      LIMIT $2
    `,
    [safeStaleMinutes, safeLimit]
  );
  const reclaimed = [];
  for (const row of result.rows) {
    const marked = await markNetworkTaskGenerationJobFailed({
      jobId: row.id,
      error: `network_task_generation_stale_running_reclaimed_after_${safeStaleMinutes}m`,
    });
    if (marked?.job) reclaimed.push(marked.job);
  }
  return reclaimed;
}

export async function listFailedRequestNetworkTaskGenerationChains({ limit = 10, projectId = "" } = {}) {
  if (!useDatabase()) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const normalizedProjectId = safeText(projectId, 180);
  const result = await query(
    `
      SELECT
        job.id AS job_id,
        job.allocation_id,
        job.project_id,
        job.task_class,
        job.candidate_account_id,
        job.candidate_wallet_address,
        job.request_id,
        job.status AS job_status,
        job.task_id AS job_task_id,
        job.created_at AS job_created_at,
        job.updated_at AS job_updated_at,
        alloc.allocation_status,
        alloc.generated_task_id AS allocation_generated_task_id,
        alloc.task_request_id AS allocation_task_request_id,
        req.status AS task_request_status,
        req.generated_task_id AS task_request_generated_task_id,
        req.last_error AS task_request_last_error,
        req.updated_at AS task_request_updated_at,
        now() - LEAST(job.updated_at, req.updated_at, alloc.updated_at) AS stale_age
      FROM network_task_generation_jobs job
      JOIN network_task_allocations alloc
        ON alloc.id = job.allocation_id
      JOIN task_requests req
        ON req.request_id = job.request_id
      WHERE job.status IN ('generated', 'link_failed')
        AND ($2::text = '' OR job.project_id = $2)
        AND job.request_id <> ''
        AND job.task_id = ''
        AND req.status = 'failed'
        AND req.generated_task_id = ''
        AND alloc.allocation_status = 'queued'
        AND alloc.generated_task_id = ''
        AND (alloc.task_request_id = '' OR alloc.task_request_id = job.request_id)
        AND NOT EXISTS (
          SELECT 1
          FROM task_projections projection
          WHERE projection.request_id = job.request_id
             OR projection.task_id = NULLIF(job.task_id, '')
             OR projection.task_id = NULLIF(req.generated_task_id, '')
             OR projection.task_id = NULLIF(alloc.generated_task_id, '')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM network_project_task_refs refs
          WHERE refs.request_id = job.request_id
             OR refs.task_id = NULLIF(job.task_id, '')
             OR refs.task_id = NULLIF(req.generated_task_id, '')
             OR refs.task_id = NULLIF(alloc.generated_task_id, '')
             OR refs.metadata_json->>'generation_job_id' = job.id
             OR refs.metadata_json->>'allocation_id' = alloc.id
        )
      ORDER BY LEAST(job.updated_at, req.updated_at, alloc.updated_at) ASC, job.id ASC
      LIMIT $1
    `,
    [safeLimit, normalizedProjectId]
  );
  return result.rows;
}

export async function recoverFailedRequestNetworkTaskGenerationChains({
  limit = 10,
  logger = console,
  operator = "network_task_generation_worker",
  projectId = "",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const candidates = await listFailedRequestNetworkTaskGenerationChains({ limit, projectId });
  const recovered = [];
  for (const candidate of candidates) {
    try {
      const result = await failNetworkTaskGenerationChain({
        allocationId: candidate.allocation_id,
        jobId: candidate.job_id,
        requestId: candidate.request_id,
        reason: `network_task_generation_failed_request_recovered:${safeText(candidate.task_request_last_error, 300) || "task_request_failed"}`,
        operator,
      });
      recovered.push({
        ok: true,
        jobId: candidate.job_id,
        allocationId: candidate.allocation_id,
        requestId: candidate.request_id,
        result,
      });
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      logger.warn?.("network_task_failed_request_recovery_chain_failed", {
        jobId: candidate.job_id,
        allocationId: candidate.allocation_id,
        requestId: candidate.request_id,
        error: message,
      });
      recovered.push({
        ok: false,
        jobId: candidate.job_id,
        allocationId: candidate.allocation_id,
        requestId: candidate.request_id,
        error: message,
      });
    }
  }
  return { ok: true, checked: candidates.length, recovered };
}

export async function markNetworkTaskGenerationJobGenerated({
  jobId = "",
  requestId = "",
  requestBundleCid = "",
  metadata = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true };
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET status = 'generated',
          request_id = $2,
          request_bundle_cid = $3,
          generated_task_payload = COALESCE(generated_task_payload, '{}'::jsonb) || $4::jsonb,
          locked_at = NULL,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [safeText(jobId, 180), safeText(requestId, 180), safeText(requestBundleCid, 240), jsonValue(metadata)]
  );
  const row = result.rows[0];
  if (row?.allocation_id) {
    await query(
      `
        UPDATE network_task_allocations
        SET allocation_status = 'queued',
            task_request_id = $2,
            metadata_json = metadata_json || $3::jsonb,
            updated_at = now()
        WHERE id = $1
      `,
      [
        row.allocation_id,
        safeText(requestId, 180),
        jsonValue({ request_bundle_cid: safeText(requestBundleCid, 240) }),
      ]
    );
    await query(
      `
        UPDATE network_task_intents
        SET status = 'generated',
            request_id = $2,
            updated_at = now(),
            metadata_json = metadata_json || $3::jsonb
        WHERE generation_job_id = $1
           OR allocation_id = $4
      `,
      [
        row.id,
        safeText(requestId, 180),
        jsonValue({ request_bundle_cid: safeText(requestBundleCid, 240) }),
        row.allocation_id,
      ]
    );
  }
  if (row?.id) {
    await recordUserObservabilityEvent({
      eventType: "user.network_task.generation_job_changed",
      accountId: row.candidate_account_id || "",
      walletAddress: row.candidate_wallet_address || "",
      walletScope: row.candidate_wallet_address ? "candidate_wallet" : "",
      projectId: row.project_id || "",
      allocationId: row.allocation_id || "",
      generationJobId: row.id,
      requestId: requestId,
      cid: requestBundleCid,
      sourceSurface: "tasks",
      sourceRoute: "server/repositories/network-tasks.js::markNetworkTaskGenerationJobGenerated",
      resultStatus: "generated",
      reasonCode: "request_bundle_generated",
      metadata: {
        taskClass: row.task_class || "",
        sourcePayloadDigest: row.source_payload_digest || "",
      },
    }).catch(() => {});
  }
  return { ok: true, job: row || null };
}

export async function markNetworkTaskGenerationJobFailed({ jobId = "", error = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true };
  const message = safeText(error, 1000);
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'queued' END,
          next_attempt_at = CASE WHEN attempt_count >= 3 THEN now() ELSE now() + interval '60 seconds' END,
          locked_at = NULL,
          last_error = $2,
          updated_at = now()
      WHERE id = $1
        AND status = 'running'
      RETURNING *
    `,
    [safeText(jobId, 180), message]
  );
  const row = result.rows[0];
  if (row?.allocation_id && row.status === "failed") {
    await query(
      `
        UPDATE network_task_allocations
        SET allocation_status = 'failed',
            metadata_json = metadata_json || $2::jsonb,
            updated_at = now()
        WHERE id = $1
      `,
      [row.allocation_id, jsonValue({ last_error: message })]
    );
    await query(
      `
        UPDATE network_task_intents
        SET status = 'failed',
            metadata_json = metadata_json || $2::jsonb,
            updated_at = now()
        WHERE generation_job_id = $1
           OR allocation_id = $3
      `,
      [row.id, jsonValue({ last_error: message }), row.allocation_id]
    );
  }
  if (row?.id) {
    await recordUserObservabilityEvent({
      eventType: "user.network_task.generation_job_changed",
      accountId: row.candidate_account_id || "",
      walletAddress: row.candidate_wallet_address || "",
      walletScope: row.candidate_wallet_address ? "candidate_wallet" : "",
      projectId: row.project_id || "",
      allocationId: row.allocation_id || "",
      generationJobId: row.id,
      sourceSurface: "tasks",
      sourceRoute: "server/repositories/network-tasks.js::markNetworkTaskGenerationJobFailed",
      resultStatus: row.status || "failed",
      reasonCode: message || "network_task_generation_failed",
      metadata: {
        taskClass: row.task_class || "",
        attemptCount: Number(row.attempt_count || 0),
      },
    }).catch(() => {});
  }
  return { ok: true, job: row || null };
}

export async function failNetworkTaskGenerationChain({
  allocationId = "",
  jobId = "",
  requestId = "",
  reason = "",
  operator = "operator",
  force = false,
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true };
  const normalizedAllocationId = safeText(allocationId, 180);
  const normalizedJobId = safeText(jobId, 180);
  const normalizedRequestId = safeText(requestId, 180);
  if (!normalizedAllocationId && !normalizedJobId && !normalizedRequestId) {
    throw new Error("network_task_repair_target_required");
  }

  const message = safeText(reason, 1000) || "operator marked Network Task generation chain failed";
  const operatorName = safeText(operator, 120) || "operator";
  const result = await transaction(async (client) => {
    const found = await client.query(
      `
        SELECT
          alloc.id AS allocation_id,
          alloc.project_id,
          alloc.task_class,
          alloc.allocation_status,
          alloc.task_request_id,
          alloc.generated_task_id AS allocation_task_id,
          alloc.candidate_account_id,
          alloc.candidate_wallet_address,
          job.id AS job_id,
          job.status AS job_status,
          job.request_id AS job_request_id,
          job.task_id AS job_task_id
        FROM network_task_allocations alloc
        LEFT JOIN network_task_generation_jobs job
          ON job.allocation_id = alloc.id
        WHERE ($1::text <> '' AND alloc.id = $1)
           OR ($2::text <> '' AND job.id = $2)
           OR ($3::text <> '' AND (alloc.task_request_id = $3 OR job.request_id = $3))
        ORDER BY job.updated_at DESC NULLS LAST, alloc.updated_at DESC
        LIMIT 1
      `,
      [normalizedAllocationId, normalizedJobId, normalizedRequestId]
    );
    const row = found.rows[0];
    if (!row?.allocation_id) throw new Error("network_task_repair_target_not_found");

    const existingTaskId = safeText(row.allocation_task_id || row.job_task_id, 180);
    if (existingTaskId && !force) throw new Error("network_task_repair_has_generated_task");

    const repair = {
      operator_repair: {
        action: "fail_network_task_generation_chain",
        operator: operatorName,
        reason: message,
        public_visibility: "hidden",
        user_visible: false,
        repaired_at: new Date().toISOString(),
        previous_allocation_status: safeText(row.allocation_status, 80),
        previous_job_status: safeText(row.job_status, 80),
        request_id: safeText(row.task_request_id || row.job_request_id, 180),
      },
      last_error: message,
    };

    let job = null;
    if (row.job_id) {
      const jobResult = await client.query(
        `
          UPDATE network_task_generation_jobs
          SET status = 'failed',
              next_attempt_at = now(),
              locked_at = NULL,
              last_error = $2,
              generated_task_payload = COALESCE(generated_task_payload, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
          WHERE id = $1
          RETURNING id, allocation_id, status, request_id, task_id, last_error
        `,
        [row.job_id, message, jsonValue(repair)]
      );
      job = jobResult.rows[0] || null;
    }

    const allocationResult = await client.query(
      `
        UPDATE network_task_allocations
        SET allocation_status = 'failed',
            metadata_json = metadata_json || $2::jsonb,
            updated_at = now()
        WHERE id = $1
        RETURNING id, allocation_status, task_request_id, generated_task_id
      `,
      [row.allocation_id, jsonValue(repair)]
    );

    const intentResult = await client.query(
      `
        UPDATE network_task_intents
        SET status = 'stale',
            metadata_json = metadata_json || $3::jsonb,
            updated_at = now()
        WHERE ($1::text <> '' AND generation_job_id = $1)
           OR ($2::text <> '' AND allocation_id = $2)
        RETURNING id, status
      `,
      [row.job_id || "", row.allocation_id, jsonValue(repair)]
    );

    const effectiveRequestId = safeText(row.task_request_id || row.job_request_id || normalizedRequestId, 180);
    let request = null;
    if (effectiveRequestId) {
      const requestResult = await client.query(
        `
          UPDATE task_requests
          SET status = 'cancelled',
              worker_completed_at = COALESCE(worker_completed_at, now()),
              last_error = $2,
              metadata_json = metadata_json || $3::jsonb,
              updated_at = now()
          WHERE request_id = $1
          RETURNING request_id, status, generated_task_id, last_error
        `,
        [effectiveRequestId, message, jsonValue(repair)]
      );
      request = requestResult.rows[0] || null;
    }

    return {
      ok: true,
      allocation: allocationResult.rows[0] || null,
      job,
      request,
      staleIntentCount: intentResult.rowCount || 0,
      reason: message,
      observability: {
        accountId: safeText(row.candidate_account_id, 180),
        walletAddress: safeText(row.candidate_wallet_address, 180),
        projectId: safeText(row.project_id, 180),
        taskClass: safeText(row.task_class, 80),
        previousAllocationStatus: safeText(row.allocation_status, 80),
        previousJobStatus: safeText(row.job_status, 80),
        operator: operatorName,
      },
    };
  });
  if (result?.ok) {
    await recordUserObservabilityEvent({
      eventType: "user.network_task.generation_job_changed",
      accountId: result.observability?.accountId || "",
      walletAddress: result.observability?.walletAddress || "",
      walletScope: result.observability?.walletAddress ? "candidate_wallet" : "",
      projectId: result.observability?.projectId || "",
      allocationId: result.allocation?.id || normalizedAllocationId,
      generationJobId: result.job?.id || normalizedJobId,
      requestId: result.request?.request_id || normalizedRequestId,
      sourceSurface: "tasks",
      sourceRoute: "server/repositories/network-tasks.js::failNetworkTaskGenerationChain",
      resultStatus: "failed",
      reasonCode: message,
      metadata: {
        taskClass: result.observability?.taskClass || "",
        operator: result.observability?.operator || operatorName,
        previousAllocationStatus: result.observability?.previousAllocationStatus || "",
        previousJobStatus: result.observability?.previousJobStatus || "",
        requestStatus: result.request?.status || "",
        staleIntentCount: Number(result.staleIntentCount || 0),
      },
    }).catch(() => {});
  }
  return result;
}

export async function markNetworkTaskOfferLinkFailed({ requestId = "", taskId = "", error = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true };
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET status = 'link_failed',
          task_id = COALESCE(NULLIF($2, ''), task_id),
          last_error = $3,
          next_attempt_at = now() + interval '60 seconds',
          locked_at = NULL,
          updated_at = now()
      WHERE request_id = $1
        AND status IN ('generated', 'published', 'link_failed')
      RETURNING *
    `,
    [safeText(requestId, 180), safeText(taskId, 180), safeText(error, 1000)]
  );
  return { ok: true, updated: result.rowCount || 0, job: result.rows[0] || null };
}

export async function completeNetworkTaskOfferFromTaskRequest({
  requestId = "",
  taskId = "",
  subjectWallet = "",
  offerCid = "",
  offerTxHash = "",
  generatedTask = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true };
  const request = safeText(requestId, 180);
  if (!request) return { ok: false, skipped: true, reason: "request_id_missing" };
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET status = 'published',
          task_id = $2,
          offer_cid = $3,
          offer_tx_hash = $4,
          generated_task_payload = COALESCE(generated_task_payload, '{}'::jsonb) || $5::jsonb,
          locked_at = NULL,
          updated_at = now()
      WHERE request_id = $1
      RETURNING *
    `,
    [
      request,
      safeText(taskId, 180),
      safeText(offerCid, 240),
      safeText(offerTxHash, 180),
      jsonValue({ generated_task: generatedTask }),
    ]
  );
  const job = result.rows[0];
  if (!job?.id) return { ok: true, skipped: true, reason: "network_task_job_not_found" };
  await query(
    `
      UPDATE network_task_intents
      SET status = 'published',
          request_id = $2,
          task_id = $3,
          updated_at = now(),
          metadata_json = metadata_json || $4::jsonb
      WHERE generation_job_id = $1
         OR allocation_id = $5
    `,
    [
      job.id,
      request,
      safeText(taskId, 180),
      jsonValue({ offer_cid: safeText(offerCid, 240), offer_tx_hash: safeText(offerTxHash, 180) }),
      job.allocation_id,
    ]
  );
  const title = safeText(generatedTask.title, 240) || safeText(taskId, 180);
  const reward = numeric(generatedTask?.reward_offer?.amount_estimate_pft, numeric(job.reward_min_pft, 0));
  await query(
    `
      UPDATE network_task_allocations
      SET allocation_status = 'proposed',
          task_request_id = $2,
          generated_task_id = $3,
          updated_at = now(),
          metadata_json = metadata_json || $4::jsonb
      WHERE id = $1
    `,
    [
      job.allocation_id,
      request,
      safeText(taskId, 180),
      jsonValue({ offer_cid: safeText(offerCid, 240), offer_tx_hash: safeText(offerTxHash, 180) }),
    ]
  );
  await query(
    `
      INSERT INTO network_project_task_refs (
        id,
        project_id,
        task_id,
        request_id,
        title,
        state,
        assignee_wallet,
        reward_pft,
        source,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, 'proposed', $6, $7, 'network_task_generation', $8::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        state = EXCLUDED.state,
        assignee_wallet = EXCLUDED.assignee_wallet,
        reward_pft = EXCLUDED.reward_pft,
        metadata_json = network_project_task_refs.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
    `,
    [
      `nettaskref_${safeText(taskId, 160)}`,
      job.project_id,
      safeText(taskId, 180),
      request,
      title,
      safeText(subjectWallet || job.candidate_wallet_address, 120),
      reward,
      jsonValue({
        allocation_id: job.allocation_id,
        generation_job_id: job.id,
        task_class: job.task_class,
        offer_cid: safeText(offerCid, 240),
        offer_tx_hash: safeText(offerTxHash, 180),
      }),
    ]
  );
  await query(
    `
      UPDATE network_projects
      SET task_count = (
            SELECT count(*)::int
            FROM network_project_task_refs
            WHERE project_id = $1
          ),
          pft_routed = (
            SELECT COALESCE(sum(reward_pft), 0)
            FROM network_project_task_refs
            WHERE project_id = $1
          ),
          updated_at = now()
      WHERE id = $1
    `,
    [job.project_id]
  );
  await recordUserObservabilityEvent({
    eventType: "user.network_task.generation_job_changed",
    accountId: job.candidate_account_id || "",
    walletAddress: subjectWallet || job.candidate_wallet_address || "",
    walletScope: subjectWallet || job.candidate_wallet_address ? "candidate_wallet" : "",
    projectId: job.project_id || "",
    allocationId: job.allocation_id || "",
    generationJobId: job.id,
    requestId: request,
    taskId: safeText(taskId, 180),
    cid: safeText(offerCid, 240),
    txHash: safeText(offerTxHash, 180),
    sourceSurface: "tasks",
    sourceRoute: "server/repositories/network-tasks.js::completeNetworkTaskOfferFromTaskRequest",
    resultStatus: "published",
    reasonCode: "offer_published",
    metadata: {
      taskClass: job.task_class || "",
      generatedTaskTitlePresent: Boolean(title),
    },
    metrics: {
      rewardOfferPft: reward,
    },
  }).catch(() => {});
  return { ok: true, jobId: job.id, allocationId: job.allocation_id, projectId: job.project_id };
}

export async function repairNetworkTaskOfferLinks({ limit = 5 } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      SELECT
        job.id AS job_id,
        job.request_id,
        COALESCE(NULLIF(job.task_id, ''), req.generated_task_id) AS task_id,
        req.subject_wallet,
        COALESCE(req.metadata_json #>> '{workerResult,offerCid}', '') AS offer_cid,
        COALESCE(req.metadata_json #>> '{workerResult,offerTxHash}', '') AS offer_tx_hash,
        COALESCE(req.metadata_json #> '{workerResult,generatedTask}', '{}'::jsonb) AS generated_task
      FROM network_task_generation_jobs job
      JOIN task_requests req
        ON req.request_id = job.request_id
      WHERE job.status IN ('generated', 'link_failed')
        AND job.request_id <> ''
        AND req.generated_task_id <> ''
        AND job.next_attempt_at <= now()
      ORDER BY job.updated_at ASC, job.id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit || 5), 1), 25)]
  );
  const repaired = [];
  for (const row of result.rows) {
    try {
      repaired.push(await completeNetworkTaskOfferFromTaskRequest({
        requestId: row.request_id,
        taskId: row.task_id,
        subjectWallet: row.subject_wallet,
        offerCid: row.offer_cid,
        offerTxHash: row.offer_tx_hash,
        generatedTask: safeObject(row.generated_task),
      }));
    } catch (error) {
      await markNetworkTaskOfferLinkFailed({
        requestId: row.request_id,
        taskId: row.task_id,
        error: error?.message || String(error),
      }).catch(() => null);
      repaired.push({ ok: false, requestId: row.request_id, taskId: row.task_id, error: error?.message || String(error) });
    }
  }
  return { ok: true, checked: result.rows.length, repaired };
}

export async function syncNetworkTaskProjection({ taskId = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedTaskId = safeText(taskId, 180);
  if (!normalizedTaskId) return { ok: false, skipped: true, reason: "task_id_missing" };

  const projectionResult = await query(
    `
      SELECT task_id, request_id, account_id, status, title, subject_wallet, reward_offer_pft, reward_actual_pft,
             last_event_tx_hash, last_event_cid, last_event_at, updated_at
      FROM task_projections
      WHERE task_id = $1
      LIMIT 1
    `,
    [normalizedTaskId]
  );
  const projection = projectionResult.rows[0];
  if (!projection?.task_id) return { ok: false, skipped: true, reason: "task_projection_missing", taskId: normalizedTaskId };

  const canonicalStatus = safeText(projection.status || "unknown", 80).toLowerCase() || "unknown";
  const allocationStatus = allocationStatusForTaskStatus(canonicalStatus);
  const rewardPft = canonicalStatus === "rewarded"
    ? numeric(projection.reward_actual_pft, 0)
    : numeric(projection.reward_offer_pft, 0);

  const refResult = await query(
    `
      UPDATE network_project_task_refs refs
      SET state = $2,
          title = COALESCE(NULLIF($3, ''), refs.title),
          assignee_wallet = COALESCE(NULLIF($4, ''), refs.assignee_wallet),
          reward_pft = $5,
          metadata_json = refs.metadata_json || $6::jsonb,
          updated_at = now()
      WHERE refs.task_id = $1
      RETURNING refs.id, refs.project_id, refs.task_id, refs.state
    `,
    [
      normalizedTaskId,
      canonicalStatus,
      safeText(projection.title, 240),
      safeText(projection.subject_wallet, 120),
      rewardPft,
      jsonValue({
        source_of_truth: "task_projections",
        task_projection_status: canonicalStatus,
        task_projection_updated_at: toIso(projection.updated_at),
        task_projection_last_event_at: toIso(projection.last_event_at),
        last_event_tx_hash: safeText(projection.last_event_tx_hash, 180),
        last_event_cid: safeText(projection.last_event_cid, 180),
      }),
    ]
  );

  const allocationResult = await syncNetworkTaskAllocationMirrors({
    projection,
    taskId: normalizedTaskId,
  });
  if (allocationResult.rows.length > 0) {
    await query(
      `
        UPDATE network_task_intents
        SET status = $2,
            task_id = $1,
            updated_at = now(),
            metadata_json = metadata_json || $3::jsonb
        WHERE allocation_id = ANY($4::text[])
           OR task_id = $1
      `,
      [
        normalizedTaskId,
        intentStatusForAllocationStatus(allocationStatus, canonicalStatus),
        jsonValue({ task_projection_status: canonicalStatus }),
        allocationResult.rows.map((row) => row.id),
      ]
    );
  }

  const projectIds = Array.from(new Set([
    ...refResult.rows.map((row) => row.project_id).filter(Boolean),
    ...allocationResult.rows.map((row) => row.project_id).filter(Boolean),
  ]));
  for (const projectId of projectIds) {
    await query(
      `
        UPDATE network_projects
        SET task_count = (
              SELECT count(*)::int
              FROM network_project_task_refs
              WHERE project_id = $1
            ),
            pft_routed = (
              SELECT COALESCE(sum(reward_pft), 0)
              FROM network_project_task_refs
              WHERE project_id = $1
            ),
            updated_at = now()
        WHERE id = $1
      `,
      [projectId]
    );
  }
  const boardManagerFollowup = canonicalStatus === "rewarded"
    ? await enqueueNetworkTaskRewardFollowup({
      taskId: normalizedTaskId,
      projectIds,
      projection,
      rewardPft,
    }).catch((error) => ({
      ok: false,
      queued: false,
      error: error?.message || String(error),
    }))
    : { ok: true, queued: false, skipped: true, reason: "status_not_rewarded" };
  const boardManagerFollowupsResolved = await resolveBoardManagerFollowupsForTaskState({
    accountId: safeText(projection.account_id, 180),
    projectIds,
    taskId: normalizedTaskId,
    allocationIds: allocationResult.rows.map((row) => row.id).filter(Boolean),
    status: canonicalStatus,
    reason: "network_task_projection_sync",
  }).catch((error) => ({
    ok: false,
    updated: 0,
    error: error?.message || String(error),
  }));
  if (allocationResult.rows.length > 0 && ["completed", "rewarded"].includes(canonicalStatus)) {
    for (const allocation of allocationResult.rows) {
      await recordUserObservabilityEvent({
        eventType: "user.network_task.completed",
        accountId: safeText(projection.account_id, 180),
        walletAddress: safeText(projection.subject_wallet, 120),
        walletScope: projection.subject_wallet ? "candidate_wallet" : "",
        projectId: allocation.project_id || "",
        allocationId: allocation.id || "",
        taskId: normalizedTaskId,
        txHash: safeText(projection.last_event_tx_hash, 180),
        cid: safeText(projection.last_event_cid, 240),
        sourceSurface: "tasks",
        sourceRoute: "server/repositories/network-tasks.js::syncNetworkTaskProjection",
        resultStatus: canonicalStatus,
        reasonCode: "task_projection_sync",
        metrics: {
          rewardPft,
        },
        metadata: {
          allocationStatus,
          taskProjectionUpdatedAt: toIso(projection.updated_at),
          taskProjectionLastEventAt: toIso(projection.last_event_at),
          boardManagerFollowupQueued: boardManagerFollowup?.queued === true,
          boardManagerFollowupsResolved: Number(boardManagerFollowupsResolved?.updated || 0),
        },
      }).catch(() => {});
    }
  }

  return {
    ok: true,
    taskId: normalizedTaskId,
    status: canonicalStatus,
    allocationStatus,
    taskRefsUpdated: refResult.rowCount || 0,
    allocationsUpdated: allocationResult.allocationsUpdated || 0,
    projectIds,
    boardManagerFollowup,
    boardManagerFollowupsResolved,
  };
}

export async function syncNetworkTaskProjections({ limit = 100 } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      SELECT DISTINCT refs.task_id
      FROM network_project_task_refs refs
      JOIN task_projections projections
        ON projections.task_id = refs.task_id
      WHERE refs.task_id <> ''
        AND refs.state IS DISTINCT FROM projections.status
      ORDER BY refs.task_id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit || 100), 1), 500)]
  );
  const synced = [];
  for (const row of result.rows) {
    synced.push(await syncNetworkTaskProjection({ taskId: row.task_id }));
  }
  return {
    ok: true,
    checked: result.rows.length,
    synced,
  };
}
