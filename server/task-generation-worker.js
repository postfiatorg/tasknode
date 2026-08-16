import { applyOffchainTaskOffer } from "./offchain-task-lifecycle.js";
import {
  claimTaskGenerationRequests,
  heartbeatTaskGenerationRequest,
  markTaskRequestFailed,
  markTaskRequestProposed,
  reclaimStaleTaskGenerationRequests,
} from "./repositories/task-requests.js";
import {
  completeNetworkTaskOfferFromTaskRequest,
  failNetworkTaskGenerationChain,
  markNetworkTaskOfferLinkFailed,
} from "./repositories/network-tasks.js";
import {
  findPublishedTaskgenOfferByTaskId,
  getTaskgenReplay,
  hasGeneratedTaskgenReplay,
  hasPublishedTaskgenReplay,
  markTaskgenReplayFailed,
  recordTaskgenReplayGenerated,
  recordTaskgenReplayPublished,
} from "./repositories/taskgen-replay-cache.js";
import { fetchAndDecryptTasknodePayload } from "./task-payloads.js";
import {
  generateTaskWithProvider,
  objectKeyCount,
  offerFromReplay,
  projectTaskgenInput,
  refreshTaskgenReplayDeadlineForPublish,
  safeObject,
  safeText,
  sha256,
  taskAuthorityWallet,
  taskGenerationProviderTimeoutMs,
  taskgenFromReplay,
  taskgenReplayIdentity,
} from "./task-generation-contract.js";

export {
  generateTaskWithProvider,
  networkTaskGenerationV2Enabled,
  projectTaskgenInput,
  refreshTaskgenReplayDeadlineForPublish,
  taskGenerationProviderTimeoutMs,
  taskgenApiConfig,
  taskgenModelForInput,
  taskgenPromptForInput,
  taskgenProviderForInput,
  taskgenReasoningEffort,
  taskgenReplayIdentity,
  validateTaskgenOutput,
} from "./task-generation-contract.js";

let timer = null;
let immediateTimer = null;
let immediateRunning = false;
const taskGenerationWorkerId = `taskgen_worker_${process.pid}_${Date.now()}`;

function positiveInteger(value, fallback, { min = 1, max = 1_200_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function taskGenerationMaxAttempts(env = process.env) {
  return positiveInteger(env.TASKNODE_TASK_GENERATION_MAX_ATTEMPTS, 3, { min: 1, max: 25 });
}

function taskGenerationStaleSeconds(env = process.env) {
  const minimumSeconds = Math.max(60, Math.ceil(taskGenerationProviderTimeoutMs(env) / 1000) + 60);
  return positiveInteger(env.TASKNODE_TASK_GENERATION_STALE_SECONDS, 900, {
    min: minimumSeconds,
    max: 86_400,
  });
}

function isNetworkGeneratedRequest(request = {}) {
  const source = safeText(request.source, 80).toLowerCase();
  const requestedKind = safeText(request.requestedTaskKind || request.requested_task_kind, 80).toLowerCase();
  return source === "network_task" || requestedKind === "network" || requestedKind === "alpha";
}

function networkGenerationFailureMetadata(message = "") {
  return {
    operator_repair: {
      action: "fail_network_task_generation_chain",
      operator: "task_generation_worker",
      reason: safeText(message, 1000) || "network_task_generation_failed_before_offer",
      public_visibility: "hidden",
      user_visible: false,
      repaired_at: new Date().toISOString(),
    },
  };
}

async function markGenerationFailure({ request = {}, message = "", logger = console } = {}) {
  const requestId = request.requestId || request.request_id;
  const ownership = {
    workerAttemptId: request.workerAttemptId || request.worker_attempt_id || "",
    workerId: request.workerId || request.worker_id || "",
  };
  if (isNetworkGeneratedRequest(request)) {
    const repair = await failNetworkTaskGenerationChain({
      requestId,
      reason: message || "network_task_generation_failed_before_offer",
      operator: "task_generation_worker",
    }).catch(async (error) => {
      logger.warn?.("network_task_generation_chain_auto_repair_failed", {
        requestId,
        error: error?.message || String(error),
      });
      return null;
    });

    if (repair?.ok) return { ok: true, hidden: true, repair };

    await markTaskRequestFailed({
      requestId,
      error: message,
      metadata: networkGenerationFailureMetadata(message),
      ...ownership,
    }).catch(() => null);
    return { ok: false, hidden: true, repair };
  }

  await markTaskRequestFailed({ requestId, error: message, ...ownership }).catch(() => null);
  return { ok: true, hidden: false, repair: null };
}

async function heartbeatRequestAttempt(request = {}, stage = "") {
  const result = await heartbeatTaskGenerationRequest({
    requestId: request.requestId,
    workerAttemptId: request.workerAttemptId,
    workerId: request.workerId,
    stage,
  });
  if (!result.ok) {
    const error = new Error("task_generation_attempt_lost");
    error.staleAttempt = true;
    error.stage = stage;
    throw error;
  }
  return result.request || request;
}

async function requestAttemptStillOwned(request = {}, stage = "") {
  if (!request.workerAttemptId) return { ok: true, request };
  const result = await heartbeatTaskGenerationRequest({
    requestId: request.requestId,
    workerAttemptId: request.workerAttemptId,
    workerId: request.workerId,
    stage,
  });
  return result.ok
    ? { ok: true, request: result.request || request }
    : { ok: false, reason: result.reason || "task_generation_attempt_not_owner" };
}

function taskIdForOffer({ authorityWallet = "", requestBundleCid = "", output = {} } = {}) {
  return `task_${sha256([authorityWallet, requestBundleCid, sha256(output)].join(":")).slice(0, 32)}`;
}

async function publishOffer({ request, requestBundle, taskgen, authorityWallet, requestBundleDigest = "" }) {
  const subjectWallet = safeText(requestBundle.subject_wallet || request.subjectWallet, 120);
  if (!subjectWallet) throw new Error("task_request_subject_wallet_missing");
  const requestBundleCid = safeText(request.requestBundleCid, 240);
  const taskId = taskIdForOffer({
    authorityWallet: authorityWallet.classicAddress,
    requestBundleCid,
    output: taskgen.output,
  });
  const contextDoc = safeObject(requestBundle.context?.primary_context_doc);
  const networkTask = safeObject(requestBundle.network_task);
  const offerPayload = {
    schema: "pf.task.offer.v1",
    protocol: "tasknode.pftl",
    created_at: new Date().toISOString(),
    chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
    task_id: taskId,
    event_id: `evt_${sha256({ taskId, output: taskgen.output }).slice(0, 24)}`,
    request_id: request.requestId,
    actor_wallet: authorityWallet.classicAddress,
    subject_wallet: subjectWallet,
    authority_wallet: authorityWallet.classicAddress,
    allocation_wallet: safeText(requestBundle.wallet?.allocation_wallet, 120),
    status: "proposed",
    title: taskgen.output.title,
    description: taskgen.output.description,
    task_kind: taskgen.output.task_kind,
    steps: taskgen.output.steps,
    submission_requirement: taskgen.output.submission_requirement,
    verification_policy: taskgen.output.verification_policy,
    reward_offer: taskgen.output.reward_offer,
    proposed_at: new Date().toISOString(),
    accept_by: taskgen.output.deadline.accept_by,
    deadline_at: taskgen.output.deadline.deadline_at,
    context_refs: contextDoc.cid
      ? [{ context_id: contextDoc.context_id || "", cid: contextDoc.cid, digest: contextDoc.digest || "" }]
      : [],
    network_task: objectKeyCount(networkTask) ? networkTask : null,
    network_project_id: safeText(networkTask.project_id, 180),
    network_project_type: safeText(networkTask.project_type, 80),
    network_allocation_id: safeText(networkTask.allocation_id, 180),
    routing_profile_digest: safeText(networkTask.routing_profile_digest, 180),
    task_class: safeText(networkTask.task_class, 80),
    generation: {
      ...taskgen.metadata,
      request_bundle_cid: requestBundleCid,
      request_bundle_digest: requestBundleDigest,
    },
  };
  const recorded = await applyOffchainTaskOffer({
    accountId: request.accountId,
    walletAddress: subjectWallet,
    offerPayload,
    metadata: {
      source: "task_generation_worker",
      request_bundle_cid: requestBundleCid,
      request_bundle_digest: requestBundleDigest,
      taskgen_model: taskgen.metadata?.model || "",
    },
  });
  return {
    taskId,
    subjectWallet,
    offerPayload,
    offerCid: recorded.event.sourceCid,
    offerDigest: `sha256:${recorded.event.eventDigest}`,
    txHash: recorded.event.sourceTxHash,
    ledgerIndex: null,
    engineResult: "direct_write",
    source: recorded.source,
  };
}

async function syncOfferProjection({
  accountId = "",
  subjectWallet = "",
  authorityWallet = "",
  allocationWallet = "",
} = {}) {
  return {
    source: "direct_write",
    accountId: safeText(accountId, 180),
    subjectWallet: safeText(subjectWallet, 180),
    authorityWallet: safeText(authorityWallet, 180),
    allocationWallet: safeText(allocationWallet, 180),
    reduced: { claimed: 0, skipped: true, reason: "task_offer_projection_direct_written" },
  };
}

async function taskRequestBundleForGeneration(request = {}) {
  const requestBundleCid = safeText(request.requestBundleCid, 240);
  if (requestBundleCid.startsWith("postgres:")) {
    const requestBundle = safeObject(request.metadata?.requestBundle);
    if (!Object.keys(requestBundle).length) {
      throw new Error("task_request_postgres_bundle_missing");
    }
    return {
      cid: requestBundleCid,
      payload: requestBundle,
      source: "task_requests.metadata_json",
    };
  }
  return await fetchAndDecryptTasknodePayload({ cid: requestBundleCid });
}

export async function processTaskGenerationQueueOnce({ limit = 1, logger = console } = {}) {
  const stale = await reclaimStaleTaskGenerationRequests({
    maxAttempts: taskGenerationMaxAttempts(),
    staleSeconds: taskGenerationStaleSeconds(),
    limit: 25,
  }).catch((error) => {
    logger.warn?.("task_generation_stale_reclaim_failed", { error: error?.message || String(error) });
    return { retried: [], failed: [] };
  });
  const requests = await claimTaskGenerationRequests({
    limit,
    workerId: taskGenerationWorkerId,
    maxAttempts: taskGenerationMaxAttempts(),
  });
  const results = [];
  for (const request of requests) {
    let replayIdentity = null;
    try {
      await heartbeatRequestAttempt(request, "fetch_request_bundle");
      const requestBundleResult = await taskRequestBundleForGeneration(request);
      const requestBundle = safeObject(requestBundleResult.payload);
      const requestBundleDigest = `sha256:${sha256(requestBundle)}`;
      await heartbeatRequestAttempt(request, "project_taskgen_input");
      const taskInput = projectTaskgenInput(requestBundle, {
        bundleCid: request.requestBundleCid,
        bundleDigest: requestBundleDigest,
      });
      const authorityWallet = taskAuthorityWallet();
      replayIdentity = taskgenReplayIdentity({
        taskInput,
        request,
        requestBundle,
        requestBundleCid: request.requestBundleCid,
        requestBundleDigest,
      });
      const replay = await getTaskgenReplay(replayIdentity.replay_key);
      const replayedPublishedOffer = hasPublishedTaskgenReplay(replay);
      const replayedGeneratedOutput = hasGeneratedTaskgenReplay(replay);
      await heartbeatRequestAttempt(request, "provider_generation");
      let taskgen = replayedGeneratedOutput
        ? taskgenFromReplay(replay, replayIdentity)
        : await generateTaskWithProvider(taskInput);
      let offer = replayedPublishedOffer ? offerFromReplay(replay) : null;
      await heartbeatRequestAttempt(request, "pre_publish_replay_check");
      if (replayedGeneratedOutput && !offer) {
        offer = await findPublishedTaskgenOfferByTaskId({
          taskId: replay.taskId,
          requestId: request.requestId,
        });
        if (!offer) {
          await syncOfferProjection({
            accountId: request.accountId,
            subjectWallet: safeText(requestBundle.subject_wallet || request.subjectWallet, 120),
            authorityWallet: authorityWallet.classicAddress,
            allocationWallet: safeText(requestBundle.wallet?.allocation_wallet, 120),
          }).catch((error) => {
            logger.warn?.("taskgen_replay_pre_publish_sync_failed", {
              requestId: request.requestId,
              taskId: replay.taskId,
              error: error?.message || String(error),
            });
          });
          offer = await findPublishedTaskgenOfferByTaskId({
            taskId: replay.taskId,
            requestId: request.requestId,
          });
        }
        if (offer) {
          await recordTaskgenReplayPublished({
            replayKey: replayIdentity.replay_key,
            identity: replayIdentity,
            taskId: offer.taskId,
            subjectWallet: offer.subjectWallet,
            offerCid: offer.offerCid,
            offerDigest: offer.offerDigest,
            offerTxHash: offer.txHash,
            taskgenOutput: taskgen.output,
            taskgenMetadata: taskgen.metadata,
            offerPayload: offer.offerPayload,
          });
        }
      }
      if (!offer) {
        await heartbeatRequestAttempt(request, "pre_publish_offer");
        const publishReady = refreshTaskgenReplayDeadlineForPublish(taskgen, taskInput.policy || {});
        taskgen = publishReady.taskgen;
        if (!replayedGeneratedOutput || publishReady.refreshed) {
          const generatedTaskId = taskIdForOffer({
            authorityWallet: authorityWallet.classicAddress,
            requestBundleCid: request.requestBundleCid,
            output: taskgen.output,
          });
          await recordTaskgenReplayGenerated({
            replayKey: replayIdentity.replay_key,
            identity: replayIdentity,
            taskId: generatedTaskId,
            subjectWallet: safeText(requestBundle.subject_wallet || request.subjectWallet, 120),
            taskgenOutput: taskgen.output,
            taskgenMetadata: taskgen.metadata,
          });
        }
        offer = await publishOffer({
          request,
          requestBundle,
          taskgen,
          authorityWallet,
          requestBundleDigest,
        });
        await heartbeatRequestAttempt(request, "offer_published");
        await recordTaskgenReplayPublished({
          replayKey: replayIdentity.replay_key,
          identity: replayIdentity,
          taskId: offer.taskId,
          subjectWallet: offer.subjectWallet,
          offerCid: offer.offerCid,
          offerDigest: offer.offerDigest,
          offerTxHash: offer.txHash,
          taskgenOutput: taskgen.output,
          taskgenMetadata: taskgen.metadata,
          offerPayload: offer.offerPayload,
        });
      }
      const sync = await syncOfferProjection({
        accountId: request.accountId,
        subjectWallet: offer.subjectWallet,
        authorityWallet: authorityWallet.classicAddress,
        allocationWallet: offer.offerPayload?.allocation_wallet || "",
      });
      const proposed = await markTaskRequestProposed({
        requestId: request.requestId,
        generatedTaskId: offer.taskId,
        subjectWallet: offer.subjectWallet,
        workerAttemptId: request.workerAttemptId,
        workerId: request.workerId,
        metadata: {
          offerCid: offer.offerCid,
          offerTxHash: offer.txHash,
          generatedTask: offer.offerPayload,
          taskgen: {
            ...taskgen.metadata,
            replay_key: replayIdentity.replay_key,
            replayed_offer: offer.replayed === true,
          },
          sync,
        },
      });
      if (!proposed.ok) {
        throw Object.assign(new Error(proposed.reason || "task_request_not_owned_by_attempt"), {
          staleAttempt: true,
        });
      }
      await completeNetworkTaskOfferFromTaskRequest({
        requestId: request.requestId,
        taskId: offer.taskId,
        subjectWallet: offer.subjectWallet,
        offerCid: offer.offerCid,
        offerTxHash: offer.txHash,
        generatedTask: offer.offerPayload,
      }).catch(async (error) => {
        await markNetworkTaskOfferLinkFailed({
          requestId: request.requestId,
          taskId: offer.taskId,
          error: error?.message || String(error),
        }).catch(() => null);
        logger.warn?.("network_task_link_update_failed", {
          requestId: request.requestId,
          taskId: offer.taskId,
          error: error?.message || String(error),
        });
      });
      results.push({
        ok: true,
        requestId: request.requestId,
        taskId: offer.taskId,
        txHash: offer.txHash,
        replayed: offer.replayed === true,
      });
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      if (error?.staleAttempt) {
        logger.warn?.("task_generation_stale_attempt_stopped", {
          requestId: request.requestId,
          stage: error.stage || "",
          error: message,
        });
        results.push({ ok: false, stale: true, requestId: request.requestId, error: message });
        continue;
      }
      const ownership = await requestAttemptStillOwned(request, "failure_guard").catch((ownershipError) => ({
        ok: false,
        reason: ownershipError?.message || "task_generation_attempt_ownership_check_failed",
      }));
      if (!ownership.ok) {
        logger.warn?.("task_generation_stale_failure_suppressed", {
          requestId: request.requestId,
          reason: ownership.reason,
          error: message,
        });
        results.push({ ok: false, stale: true, requestId: request.requestId, error: message });
        continue;
      }
      if (replayIdentity?.replay_key) {
        await markTaskgenReplayFailed({ replayKey: replayIdentity.replay_key, error: message }).catch(() => null);
      }
      const failure = await markGenerationFailure({ request, message, logger });
      logger.warn?.("task_generation_request_failed", {
        requestId: request.requestId,
        error: message,
        userVisible: !failure.hidden,
      });
      results.push({ ok: false, requestId: request.requestId, error: message });
    }
  }
  return {
    ok: true,
    claimed: requests.length,
    staleReclaimed: stale.retried.length + stale.failed.length,
    staleRetried: stale.retried.length,
    staleFailed: stale.failed.length,
    results,
  };
}

export function scheduleTaskGenerationQueue({
  delayMs = 250,
  enabled = process.env.TASKNODE_TASK_GENERATION_WORKER_ENABLED === "true",
  limit = 3,
  logger = console,
  reason = "task_request_published",
} = {}) {
  if (!enabled) return { scheduled: false, reason: "disabled" };
  if (immediateTimer) return { scheduled: false, reason: "already_scheduled" };
  const safeDelay = Math.min(Math.max(Number(delayMs || 0), 0), 60_000);
  const safeLimit = Math.min(Math.max(Number(limit || 1), 1), 3);
  immediateTimer = setTimeout(async () => {
    immediateTimer = null;
    if (immediateRunning) {
      scheduleTaskGenerationQueue({
        delayMs: 1000,
        limit: safeLimit,
        logger,
        reason: "task_generation_already_running",
      });
      return;
    }
    immediateRunning = true;
    try {
      await processTaskGenerationQueueOnce({ limit: safeLimit, logger });
    } catch (error) {
      logger.warn?.("task_generation_immediate_tick_failed", {
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

export function startTaskGenerationWorker({
  enabled = process.env.TASKNODE_TASK_GENERATION_WORKER_ENABLED === "true",
  intervalMs = Number(process.env.TASKNODE_TASK_GENERATION_WORKER_INTERVAL_MS || 5000),
  batchLimit = Number(process.env.TASKNODE_TASK_GENERATION_WORKER_BATCH_LIMIT || 1),
  logger = console,
} = {}) {
  if (timer || !enabled) return { started: false, reason: timer ? "already_started" : "disabled" };
  const safeInterval = Math.min(Math.max(intervalMs || 5000, 5000), 3_600_000);
  const safeBatch = Math.min(Math.max(batchLimit || 1, 1), 3);
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      await processTaskGenerationQueueOnce({ limit: safeBatch, logger });
    } catch (error) {
      logger.warn?.("task_generation_worker_tick_failed", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };
  timer = setInterval(runOnce, safeInterval);
  runOnce();
  return { started: true, intervalMs: safeInterval, batchLimit: safeBatch };
}
