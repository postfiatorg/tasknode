import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  recordUserObservabilityEvent,
} from "./user-observability.js";
import { assertNetworkTaskBadgeEligibility } from "./network-badges.js";
import {
  getNetworkTaskCapacityLimit,
  listNetworkTaskCapacityBlockers,
} from "./network-task-capacity.js";
import {
  digestJson,
  jsonValue,
  rewardBand,
  safeObject,
  safeText,
  taskClass,
} from "./network-tasks-utils.js";
import {
  currentProjectProductDoc,
  projectById,
  resolveCandidate,
} from "./network-task-eligibility.js";
import {
  buildNetworkTaskGenerationSource,
  networkTaskIntelligenceMetadata,
  normalizedIntentText,
  sourcePacketText,
} from "./network-task-generation-source.js";

function useDatabase() {
  return databaseEnabled();
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
  // Accept windows are opt-in. Tasks never die by clock; the board manager
  // retires stale work deliberately via cancel_network_task.
  const rawAcceptWindowHours = Number(networkTask.accept_window_hours ?? networkTask.acceptWindowHours ?? 0) || 0;
  const acceptWindowHours = rawAcceptWindowHours > 0 ? Math.max(1, rawAcceptWindowHours) : 0;
  const requiredBadgeId = safeText(networkTask.required_badge_id || networkTask.requiredBadgeId, 80);
  const operatingBadgeId = safeText(networkTask.operating_badge_id || networkTask.operatingBadgeId || requiredBadgeId, 80);
  const badgeWorkType = safeText(
    networkTask.badge_work_type ||
      networkTask.badgeWorkType ||
      networkTask.task_work_type ||
      networkTask.taskWorkType,
    120
  );
  let badgeEligibilityDecision = null;
  try {
    badgeEligibilityDecision = await assertNetworkTaskBadgeEligibility({
      accountId: candidate.accountId,
      walletAddress: candidate.walletAddress,
      projectId,
      workType: badgeWorkType,
      taskWorkType: networkTask.task_work_type || networkTask.taskWorkType,
      requiredBadgeId,
      operatingBadgeId,
      requestedRewardMinPft: band.min,
      requestedRewardMaxPft: band.max,
    });
  } catch (error) {
    await recordUserObservabilityEvent({
      eventType: "user.network_task.candidate_blocked",
      accountId: candidate.accountId,
      walletAddress: candidate.walletAddress,
      walletScope: "candidate_wallet",
      projectId,
      sourceSurface: "hive",
      sourceRoute: "server/repositories/network-tasks.js::enqueueNetworkTaskGenerationFromBoardDecision",
      resultStatus: "blocked",
      reasonCode: safeText(error?.message || "network_task_badge_eligibility_failed", 240),
      decision: {
        schema: "pf.task_node.network_task_candidate_decision.v1",
        eligible: false,
        ...(safeObject(error?.decision)),
        task_class: normalizedTaskClass,
        reward_min_pft: band.min,
        reward_max_pft: band.max,
      },
      metadata: {
        boardManagerRunId: safeText(runId, 180),
        projectId,
        requiredBadgeId,
        operatingBadgeId,
        badgeWorkType,
      },
    }).catch(() => {});
    throw error;
  }
  const normalizedNeedHash = digestJson({ need: normalizedIntentText(projectNeedSummary) || normalizedIntentText(allocationReasonSummary) });
  const semanticIntentDigest = digestJson({
    action: "initiate_network_task",
    projectId,
    candidateAccountId: candidate.accountId,
    candidateWalletAddress: candidate.walletAddress,
    taskClass: normalizedTaskClass,
    requiredBadgeId: badgeEligibilityDecision.required_badge_id,
    operatingBadgeId: badgeEligibilityDecision.operating_badge_id,
    badgeWorkType: badgeEligibilityDecision.work_type,
    normalizedNeedHash,
    rewardMinPft: band.min,
    rewardMaxPft: band.max,
  });
  const intentSemanticKey = `network_task_intent:${semanticIntentDigest}`;
  const idempotencyKey = `network_task:${semanticIntentDigest}`;
  const existingIntent = await query(
    `
      SELECT
        intent.*,
        job.status AS job_status,
        job.request_id,
        job.request_bundle_cid,
        job.task_id,
        alloc.allocation_status
      FROM network_task_intents intent
      LEFT JOIN network_task_generation_jobs job
        ON job.id = intent.generation_job_id
      LEFT JOIN network_task_allocations alloc
        ON alloc.id = intent.allocation_id
      WHERE intent.semantic_key = $1
        AND intent.status NOT IN ('failed', 'stale')
        AND intent.expires_at > now()
      ORDER BY intent.updated_at DESC, intent.id DESC
      LIMIT 1
    `,
    [intentSemanticKey]
  );
  if (existingIntent.rows[0]) {
    const row = existingIntent.rows[0];
    return {
      executed: true,
      idempotent: true,
      suppressed: true,
      reason: "network_task_semantic_intent_exists",
      intentId: row.id || "",
      allocationId: row.allocation_id || "",
      jobId: row.generation_job_id || "",
      projectId,
      taskClass: normalizedTaskClass,
      candidateAccountId: candidate.accountId,
      candidateWalletAddress: candidate.walletAddress,
      rewardBandPft: [band.min, band.max],
      requestId: row.request_id || "",
      requestBundleCid: row.request_bundle_cid || "",
      taskId: row.task_id || "",
      status: row.job_status || row.allocation_status || row.status || "",
      idempotencyKey,
      intentSemanticKey,
    };
  }
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
      intentSemanticKey,
    };
  }
  // Canonical capacity predicate (shared with getNetworkTaskEligibility and
  // boardActionPressure.candidateCapacity): status-based liveness without a
  // created_at window, cross-class blocking, projection-terminal exclusion,
  // and delinked-wallet exclusion.
  const capacityBlockers = await listNetworkTaskCapacityBlockers({
    accountId: candidate.accountId,
    walletAddress: candidate.walletAddress,
  });
  const capacityLimit = await getNetworkTaskCapacityLimit(candidate.accountId);
  const activeCount = capacityBlockers.length;
  if (activeCount >= capacityLimit && !networkTask.allow_over_capacity) {
    await recordUserObservabilityEvent({
      eventType: "user.network_task.candidate_blocked",
      accountId: candidate.accountId,
      walletAddress: candidate.walletAddress,
      walletScope: "candidate_wallet",
      projectId,
      sourceSurface: "hive",
      sourceRoute: "server/repositories/network-tasks.js::enqueueNetworkTaskGenerationFromBoardDecision",
      resultStatus: "blocked",
      reasonCode: "network_task_candidate_at_capacity",
      decision: {
        schema: "pf.task_node.network_task_candidate_decision.v1",
        eligible: false,
        block_reason: "network_task_candidate_at_capacity",
        active_capacity_blocker_count: activeCount,
        capacity_blockers: capacityBlockers.slice(0, 5).map((blocker) => ({
          kind: blocker.kind,
          allocation_id: blocker.allocationId,
          task_id: blocker.taskId,
          state: blocker.state,
          task_class: blocker.taskClass,
          wallet_address: blocker.walletAddress,
        })),
        task_class: normalizedTaskClass,
      },
      metadata: {
        boardManagerRunId: safeText(runId, 180),
        projectId,
      },
    }).catch(() => {});
    throw new Error("network_task_candidate_at_capacity");
  }
	  const productDoc = await currentProjectProductDoc(projectId);
	  const idSuffix = idempotencyKey.replace(/^network_task:/, "").slice(0, 32);
	  const intentId = `netintent_${idSuffix}`;
	  const allocationId = `netalloc_${idSuffix}`;
	  const jobId = `nettaskjob_${idSuffix}`;
	  const expiresAt = acceptWindowHours > 0 ? new Date(Date.now() + acceptWindowHours * 60 * 60 * 1000) : null;
	  const sourceJson = buildNetworkTaskGenerationSource({
	    runId,
	    decision,
	    sourcePacket,
	    project,
	    projectDocument: productDoc,
	    candidate,
	    normalizedTaskClass,
	    band,
	    projectNeedSummary,
	    allocationReasonSummary,
	    cadenceReason,
	    acceptWindowHours,
	    badgeEligibilityDecision,
	  });
	  const intelligenceMetadata = networkTaskIntelligenceMetadata(sourceJson);
	  const sourceDigest = digestJson(sourceJson);
	  const sourceText = sourcePacketText(sourceJson);
  await transaction(async (client) => {
    await client.query(
      `
        INSERT INTO network_task_intents (
          id,
          semantic_key,
          project_id,
          task_class,
          candidate_account_id,
          candidate_wallet_address,
          normalized_need_hash,
          project_need_summary,
          routing_reason_summary,
          reward_min_pft,
          reward_max_pft,
          status,
          allocation_id,
          generation_job_id,
          source_state_digest,
          created_by_run_id,
          metadata_json,
          expires_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          'queued', $12, $13, $14, $15, $16::jsonb, now() + interval '14 days'
        )
        ON CONFLICT (semantic_key) WHERE semantic_key <> '' DO UPDATE SET
          status = 'queued',
          allocation_id = EXCLUDED.allocation_id,
          generation_job_id = EXCLUDED.generation_job_id,
          request_id = '',
          task_id = '',
          source_state_digest = EXCLUDED.source_state_digest,
          created_by_run_id = EXCLUDED.created_by_run_id,
          metadata_json = network_task_intents.metadata_json || EXCLUDED.metadata_json,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
      `,
      [
        intentId,
        intentSemanticKey,
        projectId,
        normalizedTaskClass,
        candidate.accountId,
        candidate.walletAddress,
        normalizedNeedHash,
        projectNeedSummary,
        allocationReasonSummary,
        band.min,
        band.max,
        allocationId,
        jobId,
        sourceDigest,
        safeText(runId, 180),
	        jsonValue({
	          board_manager_run_id: safeText(runId, 180),
	          board_manager_source_digest: safeText(sourcePacket.sourcePacketDigest, 180),
	          idempotency_key: idempotencyKey,
	          network_task_intelligence: intelligenceMetadata,
	          badge_eligibility_decision: badgeEligibilityDecision,
	        }),
	      ]
	    );
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
          allocation_status = 'queued',
          task_request_id = '',
          generated_task_id = '',
          candidate_account_id = EXCLUDED.candidate_account_id,
          candidate_wallet_address = EXCLUDED.candidate_wallet_address,
          candidate_profile_id = EXCLUDED.candidate_profile_id,
          candidate_profile_digest = EXCLUDED.candidate_profile_digest,
          allocation_reason_summary = EXCLUDED.allocation_reason_summary,
          project_need_summary = EXCLUDED.project_need_summary,
          reward_min_pft = EXCLUDED.reward_min_pft,
          reward_max_pft = EXCLUDED.reward_max_pft,
          cadence_policy_json = EXCLUDED.cadence_policy_json,
          metadata_json = network_task_allocations.metadata_json || EXCLUDED.metadata_json,
          expires_at = EXCLUDED.expires_at,
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
          active_capacity_blocker_count: activeCount,
          accept_window_hours: sourceJson.networkTask.acceptWindowHours,
        }),
	        jsonValue({
	          board_manager_run_id: safeText(runId, 180),
	          board_manager_reason: decision.reason,
	          board_manager_source_digest: safeText(sourcePacket.sourcePacketDigest, 180),
	          source_payload_digest: sourceDigest,
	          idempotency_key: idempotencyKey,
	          network_task_intelligence: intelligenceMetadata,
	          badge_eligibility_decision: badgeEligibilityDecision,
	        }),
	        expiresAt ? expiresAt.toISOString() : null,
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
          prompt_version,
          source_payload_digest,
          source_payload_json,
          source_payload_text
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', 'board_manager', $10, 'taskgen_network_v1', $11, $12::jsonb, $13)
        ON CONFLICT (id) DO UPDATE SET
          status = 'queued',
          candidate_account_id = EXCLUDED.candidate_account_id,
          candidate_wallet_address = EXCLUDED.candidate_wallet_address,
          reward_min_pft = EXCLUDED.reward_min_pft,
          reward_max_pft = EXCLUDED.reward_max_pft,
          request_id = '',
          request_bundle_cid = '',
          generated_task_payload = '{}'::jsonb,
          task_id = '',
          offer_cid = '',
          offer_tx_hash = '',
          trigger = EXCLUDED.trigger,
          board_manager_run_id = EXCLUDED.board_manager_run_id,
          prompt_version = EXCLUDED.prompt_version,
          source_payload_digest = EXCLUDED.source_payload_digest,
          source_payload_json = EXCLUDED.source_payload_json,
          source_payload_text = EXCLUDED.source_payload_text,
          next_attempt_at = now(),
          locked_at = NULL,
          last_error = '',
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
  await recordUserObservabilityEvent({
    eventType: "user.network_task.candidate_selected",
    accountId: candidate.accountId,
    walletAddress: candidate.walletAddress,
    walletScope: "candidate_wallet",
    projectId,
    allocationId,
    generationJobId: jobId,
    sourceSurface: "hive",
    sourceRoute: "server/repositories/network-tasks.js::enqueueNetworkTaskGenerationFromBoardDecision",
    resultStatus: "selected",
    reasonCode: "board_manager",
    decision: {
      schema: "pf.task_node.network_task_candidate_decision.v1",
      eligible: true,
      task_class: normalizedTaskClass,
      reward_min_pft: band.min,
      reward_max_pft: band.max,
      badge_eligibility_decision: badgeEligibilityDecision,
      active_capacity_blocker_count: activeCount,
    },
    metadata: {
      intentId,
      boardManagerRunId: safeText(runId, 180),
      sourcePayloadDigest: sourceDigest,
      idempotencyKey,
      intentSemanticKey,
      badgeEligibilityDecision,
    },
  }).catch(() => {});
  await recordUserObservabilityEvent({
    eventType: "user.network_task.allocation_created",
    accountId: candidate.accountId,
    walletAddress: candidate.walletAddress,
    walletScope: "candidate_wallet",
    projectId,
    allocationId,
    generationJobId: jobId,
    sourceSurface: "hive",
    sourceRoute: "server/repositories/network-tasks.js::enqueueNetworkTaskGenerationFromBoardDecision",
    resultStatus: "queued",
    reasonCode: "board_manager",
    metrics: {
      rewardMinPft: band.min,
      rewardMaxPft: band.max,
      acceptWindowHours,
    },
    metadata: {
      intentId,
      boardManagerRunId: safeText(runId, 180),
      sourcePayloadDigest: sourceDigest,
      idempotencyKey,
      taskClass: normalizedTaskClass,
      badgeEligibilityDecision,
    },
  }).catch(() => {});
  return {
    executed: true,
    intentId,
    allocationId,
    jobId,
    projectId,
    taskClass: normalizedTaskClass,
    candidateAccountId: candidate.accountId,
    candidateWalletAddress: candidate.walletAddress,
    rewardBandPft: [band.min, band.max],
    sourcePayloadDigest: sourceDigest,
    idempotencyKey,
    intentSemanticKey,
    badgeEligibilityDecision,
  };
}
