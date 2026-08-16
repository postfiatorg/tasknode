import { getTaskDetail } from "./repositories/tasks.js";
import {
  agentDecisionsEnabled,
  boardForTask,
  markAgentDecisionConsumed,
  pendingAgentDecision,
} from "./repositories/bm-decisions.js";
import {
  VERIFICATION_PROMPT_PATH,
  VERIFICATION_PROMPT_VERSION,
  authoritySeed,
  eventPayloads,
  existingRewardReviewEvent,
  existingVerificationRequestEvent,
  latestPayloadBySchema,
  safeText,
  sha256,
  timelineEventPublishedRef,
  verificationResponseFormat,
  walletFromSeed,
} from "./task-review-core.js";
import { processedEvidenceFromPayload } from "./task-review-evidence.js";
import {
  acquireReviewPublicationLock,
  callOpenAiJson,
  clearWorkerClaim,
  directWritePublishedRef,
  directWriteReviewTransition,
  markReviewPublicationError,
  markReviewPublicationPublished,
  markWorkerPublished,
  publicationLockPublishedRef,
  releaseReviewPublicationLock,
} from "./task-review-publication.js";

export async function processSubmittedTask(row, { logger = console } = {}) {
  const workerName = "verification_request";
  const authorityWallet = walletFromSeed(authoritySeed(), "task_authority_seed_missing");
  const detail = await getTaskDetail({
    accountId: row.account_id,
    walletAddress: row.subject_wallet,
    taskId: row.task_id,
  });
  const payloads = eventPayloads(detail);
  const taskOffer = latestPayloadBySchema(payloads, ["pf.task.offer.v1"]);
  const initialSubmission = latestPayloadBySchema(payloads, ["pf.task.submission.v1"]);
  if (!taskOffer || !initialSubmission) throw new Error("task_review_missing_offer_or_submission");
  const existingVerificationRequest = existingVerificationRequestEvent(detail);
  const existingRewardReview = existingRewardReviewEvent(detail);
  const existingReviewEvent = existingVerificationRequest || existingRewardReview;
  if (existingReviewEvent) {
    const publishedRef = timelineEventPublishedRef(existingReviewEvent);
    await markWorkerPublished({
      taskId: row.task_id,
      workerName: "verification_request",
      published: publishedRef,
    });
    logger.info?.("task_verification_request_already_published", {
      taskId: row.task_id,
      txHash: publishedRef.txHash,
    });
    return { ok: true, taskId: row.task_id, skipped: true, reason: "verification_request_already_published" };
  }

  // Board Manager v2: network tasks wait for an agent-authored verification
  // request instead of the model auto-generated one.
  const agentBoardId = agentDecisionsEnabled()
    ? await boardForTask(row.task_id).catch(() => "")
    : "";
  const agentVerificationDecision = agentBoardId
    ? await pendingAgentDecision({ taskId: row.task_id, kind: "verification_request" })
    : null;
  if (agentBoardId && !agentVerificationDecision) {
    await clearWorkerClaim({
      taskId: row.task_id,
      workerName,
      error: "awaiting_agent_verification_request",
    }).catch(() => null);
    logger.info?.("task_verification_request_awaiting_agent_decision", {
      taskId: row.task_id,
      boardId: agentBoardId,
    });
    return {
      ok: true,
      taskId: row.task_id,
      skipped: true,
      reason: "awaiting_agent_verification_request",
    };
  }

  const publicationLock = await acquireReviewPublicationLock({
    taskId: row.task_id,
    workerName,
    metadata: {
      phase: "verification_request",
      subject_wallet: row.subject_wallet,
      submission_cid: initialSubmission.cid || "",
    },
  });
  if (!publicationLock.acquired) {
    const publishedRef = publicationLockPublishedRef(publicationLock.row);
    if (publishedRef) {
      await markWorkerPublished({ taskId: row.task_id, workerName, published: publishedRef });
    }
    logger.info?.("task_verification_request_publication_lock_exists", {
      taskId: row.task_id,
      status: publicationLock.row?.status || "",
      txHash: publishedRef?.txHash || "",
    });
    return { ok: true, taskId: row.task_id, skipped: true, reason: "verification_request_publication_lock_exists" };
  }

  let publicationAttempted = false;
  try {
    const processedEvidence = await processedEvidenceFromPayload(initialSubmission);
    let verificationRequest;
    let verificationGenerationMetadata;
    if (agentVerificationDecision) {
      verificationRequest = {
        assessment: "board_manager_agent",
        verification_ask: safeText(agentVerificationDecision.verification_ask, 4000),
        verification_type: safeText(agentVerificationDecision.verification_type, 80) || "evidence",
        reason: safeText(agentVerificationDecision.reason, 1000),
      };
      verificationGenerationMetadata = {
        provider: "board_manager_agent",
        decision_id: agentVerificationDecision.id,
        board_id: agentBoardId,
      };
    } else {
      const verification = await callOpenAiJson({
        promptPath: VERIFICATION_PROMPT_PATH,
        promptVersion: VERIFICATION_PROMPT_VERSION,
        responseFormat: verificationResponseFormat,
        input: {
          task_offer: taskOffer,
          initial_submission: initialSubmission,
          processed_evidence: processedEvidence,
          context: {},
        },
      });
      verificationRequest = {
        assessment: safeText(verification.output.assessment, 80),
        verification_ask: safeText(verification.output.verification_ask, 4000),
        verification_type: safeText(verification.output.verification_type, 80),
        reason: safeText(verification.output.reason, 1000),
      };
      verificationGenerationMetadata = verification.metadata;
    }
    const now = new Date().toISOString();
    const payload = {
      schema: "pf.task.update.v1",
      protocol: "tasknode.pftl",
      created_at: now,
      chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
      task_id: row.task_id,
      event_id: `evt_${sha256({ taskId: row.task_id, verificationRequest }).slice(0, 24)}`,
      actor_wallet: authorityWallet.classicAddress,
      subject_wallet: row.subject_wallet,
      authority_wallet: authorityWallet.classicAddress,
      allocation_wallet: row.allocation_wallet || "",
      transition: "verification_requested",
      status_after: "verification_requested",
      verification_request: verificationRequest,
      verification_ask: verificationRequest.verification_ask,
      verification_type: verificationRequest.verification_type,
      submission_cid: initialSubmission.cid || "",
      generation: verificationGenerationMetadata,
    };
    const prePublishDetail = await getTaskDetail({
      accountId: row.account_id,
      walletAddress: row.subject_wallet,
      taskId: row.task_id,
    });
    const preExistingVerificationRequest = existingVerificationRequestEvent(prePublishDetail);
    const preExistingRewardReview = existingRewardReviewEvent(prePublishDetail);
    const preExistingReviewEvent = preExistingVerificationRequest || preExistingRewardReview;
    if (preExistingReviewEvent) {
      const publishedRef = timelineEventPublishedRef(preExistingReviewEvent);
      await markReviewPublicationPublished({
        taskId: row.task_id,
        workerName,
        published: publishedRef,
        metadata: { source: "existing_indexed_event" },
      });
      await markWorkerPublished({
        taskId: row.task_id,
        workerName,
        published: publishedRef,
      });
      logger.info?.("task_verification_request_publish_skipped_existing_event", {
        taskId: row.task_id,
        txHash: publishedRef.txHash,
      });
      return { ok: true, taskId: row.task_id, skipped: true, reason: "verification_request_already_indexed_before_publish" };
    }
    publicationAttempted = true;
    const recorded = await directWriteReviewTransition({
      row,
      transition: "verification_requested",
      payload,
      metadata: {
        phase: "verification_request",
        workerName,
      },
    });
    const published = directWritePublishedRef(recorded);
    await markReviewPublicationPublished({
      taskId: row.task_id,
      workerName,
      published,
      metadata: { source: "direct_write_by_worker" },
    });
    await markWorkerPublished({ taskId: row.task_id, workerName, published });
    logger.info?.("task_verification_request_direct_written", {
      taskId: row.task_id,
      txHash: published.txHash,
      cid: published.cid,
    });
    if (agentVerificationDecision) {
      await markAgentDecisionConsumed({
        decisionId: agentVerificationDecision.id,
        ref: { tx_hash: published.txHash, cid: published.cid },
      }).catch(() => null);
    }
    return { ok: true, taskId: row.task_id, published };
  } catch (error) {
    if (publicationAttempted) {
      await markReviewPublicationError({
        taskId: row.task_id,
        workerName,
        error: error?.message || String(error),
        metadata: { publication_attempted: true },
      }).catch(() => null);
    } else if (publicationLock?.acquired) {
      await releaseReviewPublicationLock({ taskId: row.task_id, workerName }).catch(() => null);
    }
    throw error;
  }
}
