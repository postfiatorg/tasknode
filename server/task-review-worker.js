import {
  existingRewardReviewEvent,
  existingVerificationRequestEvent,
  latestInitialSubmissionPayload,
  latestVerificationResponsePayload,
  rewardPaymentGuardCanSkipPreflightSync,
  safeText,
  submissionDefinitelyNotAttempted,
  taskReviewPublisherPermission,
  taskReviewRetryDelayMs,
  timelineEventPublishedRef,
  workerClaimStaleSeconds,
  isRewardReviewPayload,
  isVerificationRequestPayload,
} from "./task-review-core.js";
import {
  buildRewardEvidenceEvaluationContext,
  collectEvidenceText,
  discordAnnouncementEvidenceStatus,
  discordEvidencePolicy,
  evidencePayloadHasScreenshot,
  parseDiscordMessageLink,
  resolveDiscordAnnouncementEvidenceStatus,
} from "./task-review-evidence.js";
import {
  claimSubmittedTasks,
  claimVerificationResponses,
  clearWorkerClaim,
} from "./task-review-publication.js";
import { processSubmittedTask } from "./task-review-submission.js";
import {
  attachRewardForensics,
  buildRewardOutcomePayload,
  normalizeRewardScore,
  processVerificationResponse,
} from "./task-review-reward.js";

export {
  fetchUrlExcerpt,
  isSafeEvidenceUrlLiteral,
} from "./task-review-evidence.js";
export { taskReviewWorkerInternals } from "./task-review-reward.js";

let timer = null;

export async function processTaskReviewQueueOnce({ limit = 1, logger = console } = {}) {
  const results = [];
  const submitted = await claimSubmittedTasks({ limit });
  for (const row of submitted) {
    try {
      results.push(await processSubmittedTask(row, { logger }));
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      await clearWorkerClaim({ taskId: row.task_id, workerName: "verification_request", error: message }).catch(() => null);
      logger.warn?.("task_verification_request_failed", { taskId: row.task_id, error: message });
      results.push({ ok: false, taskId: row.task_id, phase: "verification_request", error: message });
    }
  }

  const responses = await claimVerificationResponses({ limit });
  for (const row of responses) {
    try {
      results.push(await processVerificationResponse(row, { logger }));
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      await clearWorkerClaim({ taskId: row.task_id, workerName: "reward_scoring", error: message }).catch(() => null);
      logger.warn?.("task_reward_scoring_failed", { taskId: row.task_id, error: message });
      results.push({ ok: false, taskId: row.task_id, phase: "reward_scoring", error: message });
    }
  }
  return { ok: true, claimed: submitted.length + responses.length, results };
}

export function startTaskReviewWorker({
  enabled = process.env.TASKNODE_TASK_REVIEW_WORKER_ENABLED === "true",
  intervalMs = Number(process.env.TASKNODE_TASK_REVIEW_WORKER_INTERVAL_MS || 20000),
  batchLimit = Number(process.env.TASKNODE_TASK_REVIEW_WORKER_BATCH_LIMIT || 1),
  logger = console,
} = {}) {
  const permission = taskReviewPublisherPermission({ enabled });
  if (timer || !permission.enabled) {
    const reason = timer ? "already_started" : permission.reason;
    if (!timer && enabled && reason === "non_production_publisher_blocked") {
      logger.warn?.("task_review_worker_not_started", {
        reason,
        tasknodeEnv: process.env.TASKNODE_ENV || process.env.NODE_ENV || "",
        appName: process.env.TASKNODE_APP_NAME || "",
      });
    }
    return { started: false, reason };
  }
  const safeInterval = Math.min(Math.max(intervalMs || 20000, 5000), 3_600_000);
  const safeBatch = Math.min(Math.max(batchLimit || 1, 1), 3);
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      await processTaskReviewQueueOnce({ limit: safeBatch, logger });
    } catch (error) {
      logger.warn?.("task_review_worker_tick_failed", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };
  timer = setInterval(runOnce, safeInterval);
  runOnce();
  return { started: true, intervalMs: safeInterval, batchLimit: safeBatch };
}

export const taskReviewWorkerInternalsForTests = {
  workerClaimStaleSeconds,
  existingVerificationRequestEvent,
  existingRewardReviewEvent,
  latestInitialSubmissionPayload,
  latestVerificationResponsePayload,
  isVerificationRequestPayload,
  isRewardReviewPayload,
  taskReviewPublisherPermission,
  timelineEventPublishedRef,
  attachRewardForensics,
  buildRewardEvidenceEvaluationContext,
  buildRewardOutcomePayload,
  collectEvidenceText,
  discordAnnouncementEvidenceStatus,
  discordEvidencePolicy,
  evidencePayloadHasScreenshot,
  parseDiscordMessageLink,
  resolveDiscordAnnouncementEvidenceStatus,
  normalizeRewardScore,
  rewardPaymentGuardCanSkipPreflightSync,
  submissionDefinitelyNotAttempted,
  taskReviewRetryDelayMs,
};
