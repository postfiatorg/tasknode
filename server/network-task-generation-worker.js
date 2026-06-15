import { createHash } from "node:crypto";
import { pinContextIpfsJson } from "./context-ipfs.js";
import { resolveTasknodeEncryptionKey } from "./context-publish.js";
import { encryptTasknodePayload } from "./task-payloads.js";
import { taskPayloadRecipientPublicKeys } from "./task-payload-recipients.js";
import { buildRequestBundle } from "./task-request.js";
import { scheduleTaskGenerationQueue } from "./task-generation-worker.js";
import { getTaskRequestByRequestId, upsertTaskRequest } from "./repositories/task-requests.js";
import {
  claimNetworkTaskGenerationJobs,
  markNetworkTaskGenerationJobFailed,
  markNetworkTaskGenerationJobGenerated,
  normalizeNetworkTaskRewardBand,
  reclaimStaleNetworkTaskGenerationJobs,
  recoverFailedRequestNetworkTaskGenerationChains,
  repairNetworkTaskOfferLinks,
} from "./repositories/network-tasks.js";

let timer = null;
let immediateTimer = null;
let immediateRunning = false;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function compactList(items = [], maxItems = 4, maxChars = 280) {
  return safeArray(items).map((item) => safeText(item, maxChars)).filter(Boolean).slice(0, maxItems);
}

export function buildNetworkTaskRequestContext({ source = {}, job = {}, reward = { min: 10000, max: 50000 } } = {}) {
  const sourceObject = safeObject(source);
  return {
    schema: "pf.hive.network_task_request.v1",
    allocation_id: job.allocation_id,
    generation_job_id: job.id,
    project_id: job.project_id,
    project_type: sourceObject.project?.type || "",
    task_class: job.task_class,
    source_payload_digest: job.source_payload_digest,
    routing_profile_digest: sourceObject.candidate?.profileDigest || "",
    project_title: sourceObject.project?.title || "",
    project_summary: sourceObject.project?.summary || "",
    project_document: {
      title: sourceObject.project_document?.title || sourceObject.projectDocument?.title || "",
      summary: sourceObject.project_document?.summary || sourceObject.projectDocument?.summary || "",
      project_status: sourceObject.project_document?.projectStatus || sourceObject.projectDocument?.projectStatus || "",
      key_points: compactList(sourceObject.project_document?.keyPoints || sourceObject.projectDocument?.keyPoints),
      blocked_or_unclear: compactList(sourceObject.project_document?.blockedOrUnclear || sourceObject.projectDocument?.blockedOrUnclear),
      next_actions: compactList(sourceObject.project_document?.nextActions || sourceObject.projectDocument?.nextActions),
    },
    reward_band_pft: {
      min: reward.min,
      max: reward.max,
    },
    project_need_summary: sourceObject.networkTask?.projectNeedSummary || "",
    routing_reason: sourceObject.networkTask?.allocationReasonSummary || "",
    operator_standing_policy: safeArray(sourceObject.operatorStandingPolicy || sourceObject.operator_standing_policy).slice(0, 12),
    generation_quality_policy: safeObject(sourceObject.generationQualityPolicy || sourceObject.generation_quality_policy),
    prior_output_corpus: safeObject(sourceObject.priorOutputCorpus || sourceObject.prior_output_corpus),
    task_lineage: {
      lineage_task_ids: safeArray(sourceObject.taskLineage?.lineageTaskIds || sourceObject.taskLineage?.lineage_task_ids || sourceObject.networkTask?.lineageTaskIds || sourceObject.networkTask?.lineage_task_ids).slice(0, 12),
      referenced_outputs: safeArray(sourceObject.taskLineage?.referencedOutputs || sourceObject.taskLineage?.referenced_outputs || sourceObject.networkTask?.referencedOutputs || sourceObject.networkTask?.referenced_outputs).slice(0, 12),
      deduped_against: safeArray(sourceObject.taskLineage?.dedupedAgainst || sourceObject.taskLineage?.deduped_against || sourceObject.networkTask?.dedupedAgainst || sourceObject.networkTask?.deduped_against).slice(0, 12),
      why_not_duplicate: safeText(sourceObject.taskLineage?.whyNotDuplicate || sourceObject.taskLineage?.why_not_duplicate || sourceObject.networkTask?.whyNotDuplicate || sourceObject.networkTask?.why_not_duplicate, 1200),
    },
    action_output: sourceObject.networkTask?.actionOutput || sourceObject.networkTask?.action_output || "",
    delivery_surface: sourceObject.networkTask?.deliverySurface || sourceObject.networkTask?.delivery_surface || "",
    recipient_or_reviewer: sourceObject.networkTask?.recipientOrReviewer || sourceObject.networkTask?.recipient_or_reviewer || "",
    escalation_stage: sourceObject.networkTask?.escalationStage || sourceObject.networkTask?.escalation_stage || "",
  };
}

export async function createTaskRequestForNetworkJob(job = {}) {
  const source = safeObject(job.source_payload_json);
  const reward = normalizeNetworkTaskRewardBand({
    min: job.reward_min_pft,
    max: job.reward_max_pft,
  });
  const requestId = safeText(job.request_id, 180) || `req_net_${sha256(job.id).slice(0, 32)}`;
  const bundleId = `bundle_net_${sha256(`${job.id}:${job.source_payload_digest}`).slice(0, 32)}`;
  const existingRequest = await getTaskRequestByRequestId(requestId);
  const existingRequestAdvanced = Boolean(
    existingRequest &&
      (existingRequest.generatedTaskId || ["generating", "proposed", "cancelled"].includes(existingRequest.status))
  );
  if (existingRequestAdvanced) {
    await markNetworkTaskGenerationJobGenerated({
      jobId: job.id,
      requestId,
      requestBundleCid: existingRequest.requestBundleCid,
      metadata: {
        request_id: requestId,
        request_bundle_cid: existingRequest.requestBundleCid,
        task_request_status: existingRequest.status,
        reused_existing_request: true,
      },
    });
    return {
      requestId,
      bundleId: existingRequest.bundleId || bundleId,
      requestBundleCid: existingRequest.requestBundleCid,
      generationScheduled: { scheduled: false, reason: "request_already_advanced" },
      reusedExistingRequest: true,
    };
  }
  const tasknodeKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeKey?.publicKey) throw new Error("tasknode_encryption_key_missing");
  const request = {
    requestId,
    bundleId,
    requestText: "Network Task",
    userDetailText: "",
    requestedTaskKind: safeText(job.task_class, 80) || "network",
    source: "network_task",
    sourceConversationTitle: `Hive: ${source.project?.title || job.project_id}`,
    conversationId: "",
    attachments: [],
  };
  const requestBundle = await buildRequestBundle({
    accountId: job.candidate_account_id,
    walletAddress: job.candidate_wallet_address,
    request,
    authorityWallet: tasknodeKey.serviceAddress || "",
  });
  requestBundle.network_task = buildNetworkTaskRequestContext({ source, job, reward });
  requestBundle.policy = {
    ...safeObject(requestBundle.policy),
    task_policy_version: "task-policy-network-v1",
    reward_policy_version: "network-reward-policy-v1",
    generation_policy_version: "taskgen-policy-network-v1",
    task_class: job.task_class,
    reward_offer_min_pft: reward.min,
    reward_offer_max_pft: reward.max,
    supported_evidence_types: ["text", "url", "github_commit", "screenshot", "file", "mixed"],
  };
  const plaintext = stableJson(requestBundle);
  const recipientPublicKeys = await taskPayloadRecipientPublicKeys({
    tasknodeKey,
    accountId: job.candidate_account_id,
    walletAddress: job.candidate_wallet_address,
    explicitPublicKeys: [
      requestBundle.subject_encryption_pubkey,
      requestBundle.wallet?.subject_encryption_pubkey,
      requestBundle.encryption?.subject_public_key,
    ],
  });
  const encryptedPayload = await encryptTasknodePayload({
    plaintext,
    recipientPublicKeys,
  });
  const pin = await pinContextIpfsJson({
    payload: encryptedPayload,
    name: `tasknode-network-task-request-bundle-${sha256(requestId).slice(0, 16)}`,
    keyvalues: {
      app: "tasknodeofficial",
      content_kind: "TASK",
      schema: "pf.task.request_bundle.v1",
      source: "network_task",
      request_id: requestId,
      project_id: job.project_id,
      task_class: job.task_class,
    },
  });
  const visibleRequest = await upsertTaskRequest({
    requestId,
    bundleId,
    accountId: job.candidate_account_id,
    subjectWallet: job.candidate_wallet_address,
    source: "network_task",
    sourceConversationTitle: request.sourceConversationTitle,
    requestText: request.requestText,
    userDetailText: request.userDetailText,
    requestedTaskKind: job.task_class,
    requestBundleCid: pin.cid,
    status: "queued",
    metadata: {
      networkTask: requestBundle.network_task,
      sourcePayloadDigest: job.source_payload_digest,
      allocationId: job.allocation_id,
      generationJobId: job.id,
      pin: {
        cid: pin.cid,
        sha256: pin.sha256,
        sizeBytes: pin.sizeBytes,
      },
    },
  });
  await markNetworkTaskGenerationJobGenerated({
    jobId: job.id,
    requestId,
    requestBundleCid: pin.cid,
    metadata: {
      request_id: requestId,
      request_bundle_cid: pin.cid,
      request_bundle_digest: `sha256:${pin.sha256}`,
      task_request_status: visibleRequest?.request?.status || "queued",
    },
  });
  const generationScheduled = scheduleTaskGenerationQueue({
    delayMs: 250,
    limit: 3,
    reason: "network_task_request_generated",
  });
  return { requestId, bundleId, requestBundleCid: pin.cid, generationScheduled };
}

export async function processNetworkTaskGenerationQueueOnce({ limit = 1, logger = console } = {}) {
  const staleMinutes = Number(process.env.TASKNODE_NETWORK_TASK_GENERATION_STALE_MINUTES || 5);
  await reclaimStaleNetworkTaskGenerationJobs({ staleMinutes }).catch((error) => {
    logger.warn?.("network_task_generation_stale_reclaim_failed", { error: error?.message || String(error) });
  });
  await recoverFailedRequestNetworkTaskGenerationChains({ limit, logger }).catch((error) => {
    logger.warn?.("network_task_failed_request_recovery_failed", { error: error?.message || String(error) });
  });
  await repairNetworkTaskOfferLinks({ limit }).catch((error) => {
    logger.warn?.("network_task_offer_link_repair_failed", { error: error?.message || String(error) });
  });
  const jobs = await claimNetworkTaskGenerationJobs({ limit });
  const results = [];
  for (const job of jobs) {
    try {
      const result = await createTaskRequestForNetworkJob(job);
      results.push({ ok: true, jobId: job.id, ...result });
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      await markNetworkTaskGenerationJobFailed({ jobId: job.id, error: message }).catch(() => null);
      logger.warn?.("network_task_generation_job_failed", { jobId: job.id, error: message });
      results.push({ ok: false, jobId: job.id, error: message });
    }
  }
  return { ok: true, claimed: jobs.length, results };
}

export function scheduleNetworkTaskGenerationQueue({
  delayMs = 250,
  enabled = process.env.TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED === "true",
  limit = 2,
  logger = console,
  reason = "network_task_queued",
} = {}) {
  if (!enabled) return { scheduled: false, reason: "disabled" };
  if (immediateTimer) return { scheduled: false, reason: "already_scheduled" };
  const safeDelay = Math.min(Math.max(Number(delayMs || 0), 0), 60_000);
  const safeLimit = Math.min(Math.max(Number(limit || 1), 1), 5);
  immediateTimer = setTimeout(async () => {
    immediateTimer = null;
    if (immediateRunning) {
      scheduleNetworkTaskGenerationQueue({
        delayMs: 1000,
        limit: safeLimit,
        logger,
        reason: "network_task_generation_already_running",
      });
      return;
    }
    immediateRunning = true;
    try {
      await processNetworkTaskGenerationQueueOnce({ limit: safeLimit, logger });
    } catch (error) {
      logger.warn?.("network_task_generation_immediate_tick_failed", {
        error: error?.message || String(error),
        reason,
      });
    } finally {
      immediateRunning = false;
    }
  }, safeDelay);
  if (typeof immediateTimer.unref === "function") immediateTimer.unref();
  return { scheduled: true, delayMs: safeDelay, limit: safeLimit, reason };
}

export function startNetworkTaskGenerationWorker({
  enabled = process.env.TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED === "true",
  intervalMs = Number(process.env.TASKNODE_NETWORK_TASK_GENERATION_WORKER_INTERVAL_MS || 15000),
  batchLimit = Number(process.env.TASKNODE_NETWORK_TASK_GENERATION_WORKER_BATCH_LIMIT || 1),
  logger = console,
} = {}) {
  if (timer || !enabled) return { started: false, reason: timer ? "already_started" : "disabled" };
  const safeInterval = Math.min(Math.max(intervalMs || 15000, 5000), 3_600_000);
  const safeBatch = Math.min(Math.max(batchLimit || 1, 1), 5);
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      await processNetworkTaskGenerationQueueOnce({ limit: safeBatch, logger });
    } catch (error) {
      logger.warn?.("network_task_generation_worker_tick_failed", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };
  timer = setInterval(runOnce, safeInterval);
  runOnce();
  return { started: true, intervalMs: safeInterval, batchLimit: safeBatch };
}
