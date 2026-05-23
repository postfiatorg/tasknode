import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  activeAllocationStatuses, allocationStatusForTaskStatus, compactCandidate,
  compactNetworkTaskContent, compactProductDoc, compactProject, digestJson,
  groupNetworkTaskContentText, isCompletedNetworkTask, isOutstandingNetworkTask,
  isStoppedNetworkTask, jsonValue, numeric, rewardBand, safeObject, safeText,
  taskClass, toIso,
} from "./network-tasks-utils.js";

export { networkTaskRewardPolicy, normalizeNetworkTaskRewardBand } from "./network-tasks-utils.js";

function useDatabase() {
  return databaseEnabled();
}

export async function getNetworkTaskContentSnapshot({
  completedLimit = 5,
  outstandingLimit = 25,
  pendingLimit = 10,
  stoppedLimit = 10,
} = {}) {
  const normalizedCompletedLimit = Math.min(Math.max(Number(completedLimit || 5), 1), 25);
  const normalizedOutstandingLimit = Math.min(Math.max(Number(outstandingLimit || 25), 1), 100);
  const normalizedPendingLimit = Math.min(Math.max(Number(pendingLimit || 10), 0), 50);
  const normalizedStoppedLimit = Math.min(Math.max(Number(stoppedLimit || 10), 0), 50);
  if (!useDatabase()) {
    return {
      schema: "pf.hive.network_task_content_snapshot.v1",
      generatedAt: new Date().toISOString(),
      completed: [],
      outstanding: [],
      stopped: [],
      pendingGeneration: [],
      counts: { completed: 0, outstanding: 0, stopped: 0, pendingGeneration: 0 },
      text: "NETWORK TASK CONTENT SNAPSHOT\n\nCompleted Network Tasks (0)\nNone\n\nOutstanding Network Tasks (0)\nNone\n\nStopped Network Tasks (0)\nNone\n\nPending Network Task Generation (0)\nNone",
    };
  }

  const taskResult = await query(
    `
      SELECT
        refs.project_id,
        refs.task_id,
        refs.request_id,
        refs.title AS ref_title,
        refs.state AS ref_state,
        refs.assignee_wallet,
        refs.reward_pft AS ref_reward_pft,
        refs.created_at AS ref_created_at,
        refs.updated_at AS ref_updated_at,
        p.status,
        p.title,
        p.description,
        p.task_kind,
        p.reward_offer_pft,
        p.reward_actual_pft,
        p.submission_requirement_text,
        p.subject_wallet,
        p.metadata_json,
        p.created_at,
        p.updated_at,
        alloc.id AS allocation_id,
        alloc.allocation_status,
        alloc.candidate_account_id,
        alloc.candidate_wallet_address,
        alloc.allocation_reason_summary,
        alloc.project_need_summary,
        alloc.updated_at AS allocation_updated_at,
        job.id AS generation_job_id,
        job.status AS generation_job_status,
        job.task_class,
        job.source_payload_json,
        job.updated_at AS job_updated_at,
        (
          SELECT e.payload_json
          FROM task_events e
          WHERE e.task_id = refs.task_id
            AND e.event_type = 'pf.task.reward_decision.v1'
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ) AS reward_decision_payload,
        (
          SELECT e.payload_json
          FROM task_events e
          WHERE e.task_id = refs.task_id
            AND e.event_type = 'pf.task.update.v1'
            AND (
              e.payload_json->>'transition' IN ('refused', 'cancelled', 'rejected')
              OR e.payload_json->>'status_after' IN ('refused', 'cancelled', 'rejected')
            )
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ) AS stop_payload,
        (
          SELECT e.payload_json
          FROM task_events e
          WHERE e.task_id = refs.task_id
            AND e.event_type = 'pf.task.update.v1'
            AND (
              e.payload_json->>'transition' = 'verification_requested'
              OR e.payload_json->>'status_after' = 'verification_requested'
            )
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ) AS verification_request_payload
      FROM network_project_task_refs refs
      LEFT JOIN task_projections p
        ON p.task_id = refs.task_id
      LEFT JOIN network_task_generation_jobs job
        ON (
          (refs.task_id <> '' AND job.task_id = refs.task_id)
          OR (refs.request_id <> '' AND job.request_id = refs.request_id)
        )
      LEFT JOIN network_task_allocations alloc
        ON alloc.id = job.allocation_id
      WHERE refs.source = 'network_task_generation'
      ORDER BY COALESCE(p.updated_at, refs.updated_at, job.updated_at, alloc.updated_at, refs.created_at) DESC,
               refs.id DESC
      LIMIT $1
    `,
    [normalizedCompletedLimit + normalizedOutstandingLimit + normalizedStoppedLimit + 50]
  );

  const tasks = taskResult.rows.map(compactNetworkTaskContent);
  const completed = tasks.filter(isCompletedNetworkTask).slice(0, normalizedCompletedLimit);
  const outstanding = tasks.filter(isOutstandingNetworkTask).slice(0, normalizedOutstandingLimit);
  const stopped = tasks.filter(isStoppedNetworkTask).slice(0, normalizedStoppedLimit);

  const pendingResult = normalizedPendingLimit > 0
    ? await query(
        `
          SELECT
            job.project_id,
            job.request_id,
            job.id AS generation_job_id,
            job.status AS generation_job_status,
            job.task_id,
            job.task_class,
            job.reward_min_pft AS reward_offer_pft,
            job.source_payload_json,
            job.created_at AS job_created_at,
            job.updated_at AS job_updated_at,
            alloc.id AS allocation_id,
            alloc.allocation_status,
            alloc.candidate_account_id,
            alloc.candidate_wallet_address,
            alloc.allocation_reason_summary,
            alloc.project_need_summary,
            alloc.created_at AS allocation_created_at,
            alloc.updated_at AS allocation_updated_at
          FROM network_task_generation_jobs job
          LEFT JOIN network_task_allocations alloc
            ON alloc.id = job.allocation_id
          WHERE job.status IN ('queued', 'running', 'generated', 'link_failed')
            AND NOT EXISTS (
              SELECT 1
              FROM network_project_task_refs refs
              WHERE refs.request_id = job.request_id
                 OR refs.task_id = job.task_id
            )
          ORDER BY job.updated_at DESC, job.created_at DESC, job.id DESC
          LIMIT $1
        `,
        [normalizedPendingLimit]
      )
    : { rows: [] };
  const pendingGeneration = pendingResult.rows.map((row) => ({
    ...compactNetworkTaskContent(row),
    state: safeText(row.generation_job_status || row.allocation_status || "queued", 80).toLowerCase(),
  }));

  const text = [
    "NETWORK TASK CONTENT SNAPSHOT",
    "",
    `Completed window: last ${normalizedCompletedLimit} rewarded Network Tasks`,
    groupNetworkTaskContentText("Completed Network Tasks", completed),
    "",
    groupNetworkTaskContentText("Outstanding Network Tasks", outstanding),
    "",
    groupNetworkTaskContentText("Stopped Network Tasks", stopped),
    "",
    groupNetworkTaskContentText("Pending Network Task Generation", pendingGeneration),
  ].join("\n");

  return {
    schema: "pf.hive.network_task_content_snapshot.v1",
    generatedAt: new Date().toISOString(),
    completed,
    outstanding,
    stopped,
    pendingGeneration,
    counts: {
      completed: completed.length,
      outstanding: outstanding.length,
      stopped: stopped.length,
      pendingGeneration: pendingGeneration.length,
    },
    text,
  };
}

export async function listEligibleNetworkTaskCandidates({ limit = 12 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      WITH latest_profiles AS (
        SELECT DISTINCT ON (account_id)
          id AS profile_id,
          account_id,
          source_packet_digest,
          output_json,
          output_text,
          completed_at,
          created_at
        FROM network_task_profiles
        WHERE status = 'completed'
          AND superseded_at IS NULL
          AND account_id <> ''
        ORDER BY account_id, completed_at DESC NULLS LAST, created_at DESC, id DESC
      )
      SELECT lp.*,
             wallet.wallet_address
      FROM latest_profiles lp
      JOIN LATERAL (
        SELECT wallet_address
        FROM pftl_sync_wallets
        WHERE account_id = lp.account_id
          AND role = 'user'
          AND status = 'active'
          AND wallet_address <> ''
        ORDER BY priority DESC, last_hot_sync_at DESC NULLS LAST, wallet_address ASC
        LIMIT 1
      ) wallet ON true
      ORDER BY lp.completed_at DESC NULLS LAST, lp.created_at DESC, lp.account_id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit || 12), 1), 50)]
  );
  return result.rows.map(compactCandidate);
}

async function projectById(projectId = "") {
  const result = await query(
    `
      SELECT *
      FROM network_projects
      WHERE id = $1
        AND status = 'active'
      LIMIT 1
    `,
    [safeText(projectId, 180)]
  );
  return result.rows[0] || null;
}

async function currentProjectProductDoc(projectId = "") {
  const result = await query(
    `
      SELECT *
      FROM network_project_product_docs
      WHERE project_id = $1
        AND status = 'current'
        AND superseded_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [safeText(projectId, 180)]
  );
  return result.rows[0] || null;
}

async function resolveCandidate({ decision = {} } = {}) {
  const payload = safeObject(decision.payload);
  const networkTask = safeObject(payload.network_task || payload.networkTask);
  const contributor = safeObject(payload.contributor);
  const explicitAccountId = safeText(
    networkTask.candidate_account_id ||
      networkTask.candidateAccountId ||
      contributor.account_id ||
      contributor.accountId ||
      (decision.target_type === "account" ? decision.target_id : ""),
    180
  );
  const explicitWallet = safeText(
    networkTask.candidate_wallet_address ||
      networkTask.candidateWalletAddress ||
      contributor.wallet_address ||
      contributor.walletAddress,
    120
  );
  if (!explicitAccountId && !explicitWallet) return null;
  const candidates = await listEligibleNetworkTaskCandidates({ limit: 20 });
  const explicit = candidates.find((candidate) => (
    (!explicitAccountId || candidate.accountId === explicitAccountId) &&
    (!explicitWallet || candidate.walletAddress === explicitWallet)
  ));
  if (explicit) return explicit;
  const error = new Error("network_task_candidate_not_eligible");
  error.status = 422;
  throw error;
}

async function activeAllocationCount({ accountId = "", walletAddress = "", taskClass = "" } = {}) {
  const result = await query(
    `
      SELECT count(*)::int AS count
      FROM network_task_allocations
      WHERE allocation_status = ANY($1::text[])
        AND ($2::text = '' OR candidate_account_id = $2)
        AND ($3::text = '' OR candidate_wallet_address = $3)
        AND ($4::text = '' OR task_class = $4)
        AND created_at > now() - interval '24 hours'
    `,
    [activeAllocationStatuses, safeText(accountId, 180), safeText(walletAddress, 120), safeText(taskClass, 40)]
  );
  return Number(result.rows[0]?.count || 0);
}

function sourcePacketText(source = {}) {
  const project = source.project || {};
  const candidate = source.candidate || {};
  const networkTask = source.networkTask || {};
  return [
    "NETWORK TASK GENERATION SOURCE",
    "",
    `Project: ${project.title || project.id}`,
    `Project ID: ${project.id}`,
    `Project type: ${project.type}`,
    `Task class: ${networkTask.taskClass}`,
    `Reward band: ${networkTask.rewardMinPft} to ${networkTask.rewardMaxPft} PFT`,
    "",
    "Project need",
    networkTask.projectNeedSummary || source.decision?.reason || "",
    "",
    "Routing rationale",
    networkTask.allocationReasonSummary || source.decision?.reason || "",
    "",
    "Candidate",
    `Account: ${candidate.accountId}`,
    `Wallet: ${candidate.walletAddress}`,
    candidate.profileText || "No Network Diagnostic Report text available.",
  ].join("\n");
}

export async function enqueueNetworkTaskGenerationFromBoardDecision({
  runId = "",
  decision = {},
  sourcePacket = {},
} = {}) {
  if (!useDatabase()) return { executed: false, reason: "database_not_configured" };
  const projectId = safeText(decision.target_id || decision.payload?.project?.id, 180);
  if (!projectId) throw new Error("network_task_project_required");
  const project = await projectById(projectId);
  if (!project?.id) throw new Error("network_task_project_not_found");
  const candidate = await resolveCandidate({ decision });
  if (!candidate?.accountId || !candidate?.walletAddress) {
    throw new Error("network_task_candidate_required");
  }
  const payload = safeObject(decision.payload);
  const networkTask = safeObject(payload.network_task || payload.networkTask);
  const normalizedTaskClass = taskClass(
    networkTask.task_class ||
      networkTask.taskClass ||
      (payload.project?.type === "alpha_generation" || project.type === "alpha_generation" ? "alpha" : "network")
  );
  const band = rewardBand({
    min: networkTask.reward_min_pft ?? networkTask.rewardMinPft,
    max: networkTask.reward_max_pft ?? networkTask.rewardMaxPft,
  });
  const projectNeedSummary = safeText(networkTask.project_need_summary || networkTask.projectNeedSummary || payload.summary || decision.reason, 2400);
  const allocationReasonSummary = safeText(networkTask.allocation_reason_summary || networkTask.routing_reason || networkTask.routingReason || decision.reason, 1800);
  const cadenceReason = safeText(networkTask.cadence_reason || networkTask.cadenceReason || "board_manager_initiated", 600);
  const acceptWindowHours = Math.max(1, Number(networkTask.accept_window_hours || networkTask.acceptWindowHours || 24));
  const idempotencyKey = `network_task:${digestJson({
    runId: safeText(runId, 180),
    action: "initiate_network_task",
    projectId,
    candidateAccountId: candidate.accountId,
    candidateWalletAddress: candidate.walletAddress,
    taskClass: normalizedTaskClass,
    projectNeedSummary,
    allocationReasonSummary,
    rewardMinPft: band.min,
    rewardMaxPft: band.max,
  })}`;
  const existing = await query(
    `
      SELECT
        job.id AS job_id,
        job.status AS job_status,
        job.request_id,
        job.request_bundle_cid,
        job.task_id,
        alloc.id AS allocation_id,
        alloc.allocation_status
      FROM network_task_generation_jobs job
      LEFT JOIN network_task_allocations alloc
        ON alloc.id = job.allocation_id
      WHERE job.idempotency_key = $1
      LIMIT 1
    `,
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      executed: true,
      idempotent: true,
      allocationId: row.allocation_id || "",
      jobId: row.job_id || "",
      projectId,
      taskClass: normalizedTaskClass,
      candidateAccountId: candidate.accountId,
      candidateWalletAddress: candidate.walletAddress,
      rewardBandPft: [band.min, band.max],
      requestId: row.request_id || "",
      requestBundleCid: row.request_bundle_cid || "",
      taskId: row.task_id || "",
      status: row.job_status || row.allocation_status || "",
      idempotencyKey,
    };
  }
  const activeCount = await activeAllocationCount({
    accountId: candidate.accountId,
    walletAddress: candidate.walletAddress,
    taskClass: normalizedTaskClass,
  });
  if (activeCount > 0 && !networkTask.allow_over_capacity) {
    throw new Error("network_task_candidate_at_capacity");
  }
  const productDoc = await currentProjectProductDoc(projectId);
  const idSuffix = idempotencyKey.replace(/^network_task:/, "").slice(0, 32);
  const allocationId = `netalloc_${idSuffix}`;
  const jobId = `nettaskjob_${idSuffix}`;
  const expiresAt = new Date(Date.now() + acceptWindowHours * 60 * 60 * 1000);
  const sourceJson = {
    schema: "pf.hive.network_task_generation_source.v1",
    generated_at: new Date().toISOString(),
    board_manager_run_id: safeText(runId, 180),
    board_manager_source_digest: safeText(sourcePacket.sourcePacketDigest, 180),
    decision: {
      action: decision.action,
      target_type: decision.target_type,
      target_id: decision.target_id,
      reason: decision.reason,
      confidence: decision.confidence,
      summary: payload.summary,
      next_steps: payload.next_steps,
    },
    project: compactProject(project),
    project_document: compactProductDoc(productDoc),
    candidate,
      networkTask: {
        taskClass: normalizedTaskClass,
        projectNeedSummary,
        allocationReasonSummary,
        cadenceReason,
        rewardMinPft: band.min,
        rewardMaxPft: band.max,
        acceptWindowHours,
      },
    policy: {
      taskLifecycle: "normal_pftl_task_engine",
      supportedEvidence: ["text", "url", "github_commit", "screenshot", "file", "mixed"],
      rewardBandPft: [band.min, band.max],
      boardManagerDoesNotAuthorTaskText: true,
    },
  };
  const sourceDigest = digestJson(sourceJson);
  const sourceText = sourcePacketText(sourceJson);
  await transaction(async (client) => {
    await client.query(
      `
        INSERT INTO network_task_allocations (
          id,
          idempotency_key,
          project_id,
          task_class,
          allocation_status,
          candidate_account_id,
          candidate_wallet_address,
          candidate_profile_id,
          candidate_profile_digest,
          allocation_reason_summary,
          project_need_summary,
          reward_min_pft,
          reward_max_pft,
          cadence_policy_json,
          metadata_json,
          expires_at
        )
        VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15)
        ON CONFLICT (id) DO UPDATE SET
          updated_at = now()
      `,
      [
        allocationId,
        idempotencyKey,
        projectId,
        normalizedTaskClass,
        candidate.accountId,
        candidate.walletAddress,
        candidate.profileId,
        candidate.profileDigest,
        sourceJson.networkTask.allocationReasonSummary,
        sourceJson.networkTask.projectNeedSummary,
        band.min,
        band.max,
        jsonValue({
          cadence_reason: sourceJson.networkTask.cadenceReason,
          active_allocation_count_24h: activeCount,
          accept_window_hours: sourceJson.networkTask.acceptWindowHours,
        }),
        jsonValue({
          board_manager_run_id: safeText(runId, 180),
          board_manager_reason: decision.reason,
          board_manager_source_digest: safeText(sourcePacket.sourcePacketDigest, 180),
          source_payload_digest: sourceDigest,
          idempotency_key: idempotencyKey,
        }),
        expiresAt.toISOString(),
      ]
    );
    await client.query(
      `
        INSERT INTO network_task_generation_jobs (
          id,
          idempotency_key,
          allocation_id,
          project_id,
          task_class,
          candidate_account_id,
          candidate_wallet_address,
          reward_min_pft,
          reward_max_pft,
          status,
          trigger,
          board_manager_run_id,
          source_payload_digest,
          source_payload_json,
          source_payload_text
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', 'board_manager', $10, $11, $12::jsonb, $13)
        ON CONFLICT (id) DO UPDATE SET
          updated_at = now()
      `,
      [
        jobId,
        idempotencyKey,
        allocationId,
        projectId,
        normalizedTaskClass,
        candidate.accountId,
        candidate.walletAddress,
        band.min,
        band.max,
        safeText(runId, 180),
        sourceDigest,
        jsonValue(sourceJson),
        sourceText,
      ]
    );
  });
  return {
    executed: true,
    allocationId,
    jobId,
    projectId,
    taskClass: normalizedTaskClass,
    candidateAccountId: candidate.accountId,
    candidateWalletAddress: candidate.walletAddress,
    rewardBandPft: [band.min, band.max],
    sourcePayloadDigest: sourceDigest,
    idempotencyKey,
  };
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
  }
  return { ok: true, job: row || null };
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
      SELECT task_id, status, title, subject_wallet, reward_offer_pft, reward_actual_pft,
             last_event_tx_hash, last_event_cid, updated_at
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
        last_event_tx_hash: safeText(projection.last_event_tx_hash, 180),
        last_event_cid: safeText(projection.last_event_cid, 180),
      }),
    ]
  );

  const allocationResult = await query(
    `
      UPDATE network_task_allocations alloc
      SET allocation_status = $2,
          metadata_json = alloc.metadata_json || $3::jsonb,
          updated_at = now()
      WHERE alloc.generated_task_id = $1
      RETURNING alloc.id, alloc.project_id, alloc.generated_task_id, alloc.allocation_status
    `,
    [
      normalizedTaskId,
      allocationStatus,
      jsonValue({
        source_of_truth: "task_projections",
        task_projection_status: canonicalStatus,
        task_projection_updated_at: toIso(projection.updated_at),
      }),
    ]
  );

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

  return {
    ok: true,
    taskId: normalizedTaskId,
    status: canonicalStatus,
    allocationStatus,
    taskRefsUpdated: refResult.rowCount || 0,
    allocationsUpdated: allocationResult.rowCount || 0,
    projectIds,
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
