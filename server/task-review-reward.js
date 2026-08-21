import { query } from "./db/pool.js";
import { getTaskDetail } from "./repositories/tasks.js";
import { resolveTasknodeEncryptionKey } from "./context-publish.js";
import { signTaskTransition } from "./task-transition-signatures.js";
import {
  agentDecisionsEnabled,
  boardForTask,
  computeRewardCap,
  markAgentDecisionConsumed,
  pendingAgentDecision,
  recordBoardRewardSpend,
} from "./repositories/bm-decisions.js";
import {
  REWARD_CARRIER_DROPS,
  REWARD_PROMPT_PATH,
  REWARD_PROMPT_VERSION,
  authoritySeed,
  claimRewardPaymentGuard,
  clampInteger,
  eventPayloads,
  existingRewardReviewEvent,
  latestInitialSubmissionPayload,
  latestPayloadBySchema,
  latestRewardPaymentEvent,
  latestVerificationRequestPayload,
  latestVerificationResponsePayload,
  markRewardPaymentRetryWait,
  markRewardPaymentSubmitUnknown,
  markRewardPaymentSubmitted,
  normalizeReward,
  pftToDrops,
  rewardPaymentGuard,
  rewardPaymentGuardBlocksRetry,
  rewardPaymentGuardCanSkipPreflightSync,
  rewardPaymentGuardPayload,
  rewardPaymentGuardStatus,
  rewardResponseFormat,
  rewardSeed,
  safeObject,
  safeText,
  sha256,
  submissionDefinitelyNotAttempted,
  taskReviewRetryDelayMs,
  timelineEventPublishedRef,
  timelineEvents,
  walletFromSeed,
} from "./task-review-core.js";
import {
  buildRewardEvidenceEvaluationContext,
  normalizeBooleanFlag,
  processedEvidenceFromPayload,
  resolveDiscordAnnouncementEvidenceStatus,
} from "./task-review-evidence.js";
import {
  acquireReviewPublicationLock,
  callOpenAiJson,
  clearWorkerClaim,
  directWritePublishedRef,
  directWriteReviewTransition,
  markReviewPublicationError,
  markReviewPublicationPublished,
  markReviewPublicationRetryWait,
  markWorkerPublished,
  publicationLockPublishedRef,
  publishAuthorityPointer,
  releaseReviewPublicationLock,
  syncTaskWallets,
} from "./task-review-publication.js";

export function normalizeRewardScore(output = {}, offerPft = 0, { badgeRewardCapPft = 0 } = {}) {
  const decision = safeText(output.decision, 80);
  const cap = Number(badgeRewardCapPft);
  const offer = Number(offerPft);
  const trustedUpperBound =
    Number.isFinite(cap) && cap > 0 && Number.isFinite(offer) && offer > 0
      ? Math.min(offer, cap)
      : offer;
  const rewardPft = decision === "reject" ? 0 : normalizeReward(output.reward_pft, trustedUpperBound);
  return {
    decision: rewardPft > 0 ? (decision === "partial_reward" ? "partial_reward" : "reward") : "reject",
    reward_pft: rewardPft.toFixed(2),
    badge_reward_cap_pft: Number.isFinite(cap) && cap > 0 ? cap.toFixed(2) : "",
    badge_cap_applied: Number.isFinite(cap) && cap > 0 && Number.isFinite(offer) && offer > cap,
    completion: clampInteger(output.completion, 0),
    evidence_quality: clampInteger(output.evidence_quality, 0),
    reason: safeText(output.reason, 2000),
    user_feedback: safeText(output.user_feedback, 2000),
  };
}

export async function networkTaskRewardBadgePolicy(row = {}) {
  const taskId = safeText(row.task_id, 180);
  const requestId = safeText(row.request_id, 180);
  if (!taskId && !requestId) return {};
  const result = await query(
    `
      SELECT source_payload_json
      FROM network_task_generation_jobs
      WHERE ($1::text <> '' AND task_id = $1)
         OR ($2::text <> '' AND request_id = $2)
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
    [taskId, requestId]
  );
  const source = safeObject(result.rows[0]?.source_payload_json);
  const networkTask = safeObject(source.networkTask || source.network_task);
  const policy = safeObject(source.policy);
  const badgeRewardCapPft = Number(
    networkTask.badgeRewardCapPft ||
      networkTask.badge_reward_cap_pft ||
      policy.badgeRewardCapPft ||
      policy.badge_reward_cap_pft ||
      policy.badgeEligibilityDecision?.badge_reward_cap_pft ||
      policy.badge_eligibility_decision?.badge_reward_cap_pft ||
      0
  );
  return {
    requiredBadgeId: safeText(networkTask.requiredBadgeId || networkTask.required_badge_id || policy.required_badge_id, 80),
    operatingBadgeId: safeText(networkTask.operatingBadgeId || networkTask.operating_badge_id || policy.operating_badge_id, 80),
    badgeWorkType: safeText(networkTask.badgeWorkType || networkTask.badge_work_type || policy.badge_work_type, 120),
    badgeRewardCapPft: Number.isFinite(badgeRewardCapPft) && badgeRewardCapPft > 0 ? badgeRewardCapPft : 0,
    discordEvidenceRequired: normalizeBooleanFlag(
      networkTask.discordEvidenceRequired ??
        networkTask.discord_evidence_required ??
        policy.discordEvidenceRequired ??
        policy.discord_evidence_required ??
        false
    ),
  };
}

export async function publishDiscordEvidenceVerificationRequest({
  row = {},
  taskOffer = {},
  initialSubmission = {},
  verificationResponse = {},
  discordEvidence = {},
  authorityWallet,
  logger = console,
} = {}) {
  const taskId = safeText(row.task_id, 180);
  const verificationResponseRef = safeText(verificationResponse.cid || verificationResponse.source_cid || sha256(verificationResponse), 240);
  const workerName = `discord_evidence_request_${sha256(`${taskId}:${verificationResponseRef}`).slice(0, 16)}`;
  const publicationLock = await acquireReviewPublicationLock({
    taskId,
    workerName,
    metadata: {
      phase: "discord_evidence_request",
      subject_wallet: row.subject_wallet,
      verification_response_cid: verificationResponse.cid || "",
      reason: discordEvidence.reason || "",
    },
  });
  if (!publicationLock.acquired) {
    const publishedRef = publicationLockPublishedRef(publicationLock.row);
    logger.info?.("task_discord_evidence_request_lock_exists", {
      taskId,
      status: publicationLock.row?.status || "",
      txHash: publishedRef?.txHash || "",
    });
    return { ok: true, skipped: true, reason: "discord_evidence_request_lock_exists", published: publishedRef };
  }

  let publicationAttempted = false;
  try {
    const now = new Date().toISOString();
    const verificationRequest = {
      assessment: "incomplete",
      verification_ask:
        "Please submit Discord announcement proof for this Network Task: provide a Discord message link/id from an approved Post Fiat channel, or a screenshot/image showing the announcement and the public work artifact. Reward scoring will continue after this required evidence is present.",
      verification_type: "mixed",
      reason: safeText(discordEvidence.reason || "Missing required Discord announcement evidence.", 1000),
    };
    const payload = {
      schema: "pf.task.update.v1",
      protocol: "tasknode.pftl",
      created_at: now,
      chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
      task_id: taskId,
      event_id: `evt_${sha256({ taskId, verificationResponseRef, verificationRequest }).slice(0, 24)}`,
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
      verification_response_cid: verificationResponse.cid || "",
      blocking_requirement: "discord_announcement_evidence",
      task_history: {
        task: taskOffer,
        submission: initialSubmission,
        verification_response: verificationResponse,
      },
      generation: {
        provider: "deterministic",
        model: "task-review-worker",
        prompt_version: "discord_announcement_evidence_required",
        input_packet_digest: sha256({ taskOffer, initialSubmission, verificationResponse }),
        output_digest: sha256(verificationRequest),
        parse_status: "ok",
      },
    };
    publicationAttempted = true;
    const recorded = await directWriteReviewTransition({
      row,
      transition: "verification_requested",
      payload,
      metadata: {
        phase: "discord_evidence_request",
        workerName,
        blocking_requirement: "discord_announcement_evidence",
      },
    });
    const published = directWritePublishedRef(recorded);
    await markReviewPublicationPublished({
      taskId,
      workerName,
      published,
      metadata: {
        source: "direct_write_by_worker",
        terminal_schema: "pf.task.update.v1",
        blocking_requirement: "discord_announcement_evidence",
      },
    });
    await markWorkerPublished({ taskId, workerName, published });
    logger.info?.("task_discord_evidence_request_direct_written", {
      taskId,
      txHash: published.txHash,
      cid: published.cid,
    });
    return { ok: true, published };
  } catch (error) {
    if (publicationAttempted) {
      await markReviewPublicationError({
        taskId,
        workerName,
        error: error?.message || String(error),
        metadata: { publication_attempted: true },
      }).catch(() => null);
    } else {
      await releaseReviewPublicationLock({ taskId, workerName }).catch(() => null);
    }
    throw error;
  }
}

export function buildRewardOutcomePayload({
  row = {},
  score = {},
  scoringMetadata = {},
  taskOffer = {},
  initialSubmission = {},
  verificationRequest = {},
  verificationResponse = {},
  authorityWalletAddress = "",
  rewardWalletAddress = "",
  createdAt = new Date().toISOString(),
} = {}) {
  const rewardPft = Number(score.reward_pft);
  const economicRewardPft = Number.isFinite(rewardPft) && rewardPft > 0 ? rewardPft : 0;
  const rewardAmountDrops = economicRewardPft > 0 ? pftToDrops(economicRewardPft) : REWARD_CARRIER_DROPS;
  const carrierAmountDrops = economicRewardPft > 0 ? "0" : REWARD_CARRIER_DROPS;
  const payload = {
    schema: "pf.reward.v1",
    reward_history_schema: 2,
    protocol: "tasknode.pftl",
    created_at: createdAt,
    chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
    task_id: row.task_id,
    event_id: `evt_${sha256({ taskId: row.task_id, rewardPft: economicRewardPft, score }).slice(0, 24)}`,
    actor_wallet: rewardWalletAddress,
    subject_wallet: row.subject_wallet,
    authority_wallet: authorityWalletAddress,
    allocation_wallet: rewardWalletAddress,
    recipient_wallet_address: row.subject_wallet,
    reward_pft: economicRewardPft.toFixed(2),
    economic_reward_pft: economicRewardPft.toFixed(2),
    transaction_amount_drops: rewardAmountDrops,
    carrier_amount_drops: carrierAmountDrops,
    reward_tier: "task_engine_live",
    reward_decision: score.decision,
    reward_score: score,
    reward_summary: score.reason,
    generation: scoringMetadata,
    task_history: {
      task: taskOffer,
      submission: initialSubmission,
      verification_request: verificationRequest,
      verification_response: verificationResponse,
    },
  };
  return { payload, rewardAmountDrops, economicRewardPft };
}

export function compactTimelineForensics(detail = {}) {
  return timelineEvents(detail).map((event, index) => ({
    index: index + 1,
    schema: safeText(event.schema || event.rawPayload?.schema, 160),
    tx_hash: safeText(event.txHash, 160),
    cid: safeText(event.cid, 240),
    event_digest: safeText(event.eventDigest, 240),
    write_source: safeText(event.writeSource, 80),
    signature: event.signature
      ? {
          role: safeText(event.signature.role, 80),
          signer_wallet: safeText(event.signature.signer_wallet || event.signature.address, 180),
          payload_digest: safeText(event.signature.payload_digest, 180),
          verified: event.signature.verification?.verified === true,
          reason: safeText(event.signature.verification?.reason, 120),
        }
      : null,
  }));
}

export function compactTransitionSignature(signature = {}) {
  return {
    schema: safeText(signature.schema, 120),
    role: safeText(signature.role, 80),
    task_id: safeText(signature.task_id, 180),
    transition: safeText(signature.transition, 120),
    signer_wallet: safeText(signature.signer_wallet, 180),
    public_key: safeText(signature.public_key, 180),
    payload_digest: safeText(signature.payload_digest, 180),
    signature: safeText(signature.signature, 260),
    signed_at: safeText(signature.signed_at, 80),
    algorithm: safeText(signature.algorithm, 120),
  };
}

export function attachRewardForensics({
  detail = {},
  rewardPayload = {},
  rewardSignature = {},
  scoringMetadata = {},
} = {}) {
  const unsignedRewardDigest = `sha256:${sha256(rewardPayload)}`;
  const timeline = compactTimelineForensics(detail);
  const transitionSignatures = [
    ...timeline.map((event) => event.signature).filter(Boolean),
    compactTransitionSignature(rewardSignature),
  ].filter((signature) => signature?.payload_digest);
  const forensicEnvelope = {
    schema: "pf.reward.forensics.v1",
    version: 1,
    task_id: safeText(rewardPayload.task_id, 180),
    created_at: new Date().toISOString(),
    anchoring: {
      mode: "single_reward_payload_cid",
      description: "This pf.reward.v1 payload is the consolidated forensic document; its encrypted IPFS CID is carried by the reward transaction pointer memo.",
    },
    unsigned_reward_payload_digest: unsignedRewardDigest,
    task_history_digest: `sha256:${sha256(rewardPayload.task_history || {})}`,
    scoring_digest: `sha256:${sha256(rewardPayload.reward_score || {})}`,
    scoring_metadata_digest: `sha256:${sha256(scoringMetadata || {})}`,
    timeline,
    transition_signatures: transitionSignatures,
    integrity: {
      timeline_event_count: timeline.length,
      signed_transition_count: transitionSignatures.length,
      actor_signed_transition_count: transitionSignatures.filter((signature) => signature.role === "actor").length,
      pf_signed_transition_count: transitionSignatures.filter((signature) => signature.role !== "actor").length,
      ipfs_write_policy: "reward_time_only",
    },
  };
  return {
    ...rewardPayload,
    reward_forensics: forensicEnvelope,
    transition_signatures: transitionSignatures,
  };
}

export async function processVerificationResponse(row, { logger = console } = {}) {
  const workerName = "reward_scoring";
  const tasknodeKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeKey?.publicKey) throw new Error("tasknode_encryption_key_missing");
  const authorityWallet = walletFromSeed(authoritySeed(), "task_authority_seed_missing");
  const rewardWallet = walletFromSeed(rewardSeed(), "task_reward_seed_missing");
  const preflightPaymentGuard = rewardPaymentGuard(row.metadata_json);
  if (rewardPaymentGuardCanSkipPreflightSync(preflightPaymentGuard)) {
    logger.info?.("task_reward_pre_submit_retry_sync_skipped", {
      taskId: row.task_id,
      reason: "prior_attempt_definitely_not_submitted",
    });
  } else {
    await syncTaskWallets({
      accountId: row.account_id,
      subjectWallet: row.subject_wallet,
      authorityWallet: authorityWallet.classicAddress,
      allocationWallet: rewardWallet.classicAddress,
      taskId: row.task_id,
    });
  }
  const detail = await getTaskDetail({
    accountId: row.account_id,
    walletAddress: row.subject_wallet,
    taskId: row.task_id,
  });
  const payloads = eventPayloads(detail);
  const taskOffer = latestPayloadBySchema(payloads, ["pf.task.offer.v1"]);
  const initialSubmission = latestInitialSubmissionPayload(payloads);
  const verificationRequest = latestVerificationRequestPayload(payloads);
  const verificationResponse = latestVerificationResponsePayload(payloads);
  if (!taskOffer || !initialSubmission || !verificationResponse) {
    throw new Error("task_scoring_missing_required_events");
  }
  const existingRewardReview = existingRewardReviewEvent(detail);
  if (existingRewardReview) {
    const publishedRef = timelineEventPublishedRef(existingRewardReview);
    await markWorkerPublished({
      taskId: row.task_id,
      workerName,
      published: publishedRef,
    });
    logger.info?.("task_reward_scoring_already_published", {
      taskId: row.task_id,
      txHash: publishedRef.txHash,
    });
    return { ok: true, taskId: row.task_id, skipped: true, reason: "reward_scoring_already_published" };
  }

  const existingPaymentGuard = rewardPaymentGuard(row.metadata_json);
  if (rewardPaymentGuardBlocksRetry(existingPaymentGuard)) {
    await syncTaskWallets({
      accountId: row.account_id,
      subjectWallet: row.subject_wallet,
      authorityWallet: authorityWallet.classicAddress,
      allocationWallet: rewardWallet.classicAddress,
    });
    const refreshedDetail = await getTaskDetail({
      accountId: row.account_id,
      walletAddress: row.subject_wallet,
      taskId: row.task_id,
    });
    const refreshedRewardReview = existingRewardReviewEvent(refreshedDetail);
    if (refreshedRewardReview) {
      const publishedRef = timelineEventPublishedRef(refreshedRewardReview);
      await markWorkerPublished({ taskId: row.task_id, workerName, published: publishedRef });
      logger.info?.("task_reward_already_indexed_after_guard_sync", {
        taskId: row.task_id,
        txHash: publishedRef.txHash,
      });
      return { ok: true, taskId: row.task_id, skipped: true, reason: "reward_already_indexed_after_guard_sync" };
    }
    throw new Error(`task_reward_payment_guard_active:${rewardPaymentGuardStatus(existingPaymentGuard) || "unknown"}`);
  }

  let publicationLock = null;
  let publicationAttempted = false;
  let reward = null;
  try {
    const [processedInitial, processedVerification] = await Promise.all([
      processedEvidenceFromPayload(initialSubmission),
      processedEvidenceFromPayload(verificationResponse),
    ]);
    const evidenceEvaluation = buildRewardEvidenceEvaluationContext({
      initial: processedInitial,
      verification: processedVerification,
    });
    const offerPft = Number(taskOffer?.reward_offer?.amount_estimate_pft || row.reward_offer_pft || 0);
    const badgePolicy = await networkTaskRewardBadgePolicy(row).catch(() => ({}));

    // Board Manager v2: network-task rewards are decided by the board agent
    // and re-clamped here at publication. Without a pending decision the
    // task waits; model auto-scoring only applies to non-board tasks.
    const agentBoardId = agentDecisionsEnabled()
      ? await boardForTask(row.task_id).catch(() => "")
      : "";
    const agentReviewDecision = agentBoardId
      ? await pendingAgentDecision({ taskId: row.task_id, kind: "review" })
      : null;
    if (agentBoardId && !agentReviewDecision) {
      await clearWorkerClaim({
        taskId: row.task_id,
        workerName,
        error: "awaiting_agent_review_decision",
      }).catch(() => null);
      logger.info?.("task_reward_awaiting_agent_decision", {
        taskId: row.task_id,
        boardId: agentBoardId,
      });
      return {
        ok: true,
        taskId: row.task_id,
        skipped: true,
        reason: "awaiting_agent_review_decision",
      };
    }
    const discordEvidence = await resolveDiscordAnnouncementEvidenceStatus({
      initialSubmission,
      verificationResponse,
      processedInitial,
      processedVerification,
    });
    if (badgePolicy.discordEvidenceRequired && !discordEvidence.ok) {
      const blocked = await publishDiscordEvidenceVerificationRequest({
        row,
        taskOffer,
        initialSubmission,
        verificationResponse,
        discordEvidence,
        authorityWallet,
        logger,
      });
      await clearWorkerClaim({
        taskId: row.task_id,
        workerName,
        error: "discord_announcement_evidence_missing",
      }).catch(() => null);
      return {
        ok: true,
        taskId: row.task_id,
        blocked: true,
        reason: "discord_announcement_evidence_missing",
        published: blocked.published,
      };
    }

    publicationLock = await acquireReviewPublicationLock({
      taskId: row.task_id,
      workerName,
      metadata: {
        phase: "reward_scoring",
        subject_wallet: row.subject_wallet,
        verification_response_cid: verificationResponse.cid || "",
      },
    });
    if (!publicationLock.acquired) {
      const publishedRef = publicationLockPublishedRef(publicationLock.row);
      if (publishedRef) {
        await markWorkerPublished({ taskId: row.task_id, workerName, published: publishedRef });
      }
      logger.info?.("task_reward_scoring_publication_lock_exists", {
        taskId: row.task_id,
        status: publicationLock.row?.status || "",
        txHash: publishedRef?.txHash || "",
      });
      return { ok: true, taskId: row.task_id, skipped: true, reason: "reward_scoring_publication_lock_exists" };
    }

    let scoreBase;
    let scoringMetadataBase;
    if (agentReviewDecision) {
      const publicationCapCheck = await computeRewardCap({
        boardId: agentBoardId,
        accountId: row.account_id,
        walletAddress: row.subject_wallet,
        requestedPft: Number(agentReviewDecision.reward_pft || 0),
      });
      const decisionKind = safeText(agentReviewDecision.decision, 80);
      scoreBase = normalizeRewardScore(
        {
          decision: decisionKind === "reject" ? "reject" : decisionKind === "partial_reward" ? "partial_reward" : "reward",
          reward_pft:
            decisionKind === "reject"
              ? 0
              : Math.min(Number(agentReviewDecision.reward_pft || 0), publicationCapCheck.allowedPft),
          completion: 100,
          evidence_quality: 100,
          reason: safeText(agentReviewDecision.reason, 2000),
          user_feedback: safeText(agentReviewDecision.user_feedback, 2000),
        },
        offerPft,
        badgePolicy
      );
      scoringMetadataBase = {
        provider: "board_manager_agent",
        decision_id: agentReviewDecision.id,
        board_id: agentBoardId,
        requested_reward_pft: Number(agentReviewDecision.requested_reward_pft || 0),
        publication_cap_check: {
          allowed_pft: publicationCapCheck.allowedPft,
          caps_applied: publicationCapCheck.capsApplied,
          refused: publicationCapCheck.refused,
        },
      };
    } else {
      const scoring = await callOpenAiJson({
        promptPath: REWARD_PROMPT_PATH,
        promptVersion: REWARD_PROMPT_VERSION,
        responseFormat: rewardResponseFormat,
        input: {
          task_offer: taskOffer,
          initial_submission: initialSubmission,
          verification_request: verificationRequest,
          verification_response: verificationResponse,
          processed_evidence: {
            initial: processedInitial,
            verification: processedVerification,
          },
          evidence_evaluation: evidenceEvaluation,
        },
      });
      scoreBase = normalizeRewardScore(scoring.output, offerPft, badgePolicy);
      scoringMetadataBase = scoring.metadata;
    }
    const score = {
      ...scoreBase,
      discord_announcement_evidence_required: badgePolicy.discordEvidenceRequired,
      discord_announcement_evidence_ok: discordEvidence.ok,
      discord_announcement_evidence_type: discordEvidence.evidence_type,
      discord_announcement_evidence_ref: discordEvidence.evidence_ref,
    };
    const rewardScoringMetadata = {
      ...scoringMetadataBase,
      discord_announcement_evidence: discordEvidence,
    };
    const {
      payload: baseRewardPayload,
      rewardAmountDrops,
      economicRewardPft,
    } = buildRewardOutcomePayload({
      row,
      score,
      scoringMetadata: rewardScoringMetadata,
      taskOffer,
      initialSubmission,
      verificationRequest,
      verificationResponse,
      authorityWalletAddress: authorityWallet.classicAddress,
      rewardWalletAddress: rewardWallet.classicAddress,
    });
    const prePublishDetail = await getTaskDetail({
      accountId: row.account_id,
      walletAddress: row.subject_wallet,
      taskId: row.task_id,
    });
    const preExistingRewardReview = existingRewardReviewEvent(prePublishDetail);
    if (preExistingRewardReview) {
      const publishedRef = timelineEventPublishedRef(preExistingRewardReview);
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
      logger.info?.("task_reward_scoring_publish_skipped_existing_event", {
        taskId: row.task_id,
        txHash: publishedRef.txHash,
      });
      return { ok: true, taskId: row.task_id, skipped: true, reason: "reward_already_indexed_before_publish" };
    }

    const rewardSignature = signTaskTransition({
      payload: baseRewardPayload,
      signerWallet: rewardWallet,
      role: "pf_reward_authority",
      transition: "rewarded",
    });
    const rewardPayload = attachRewardForensics({
      detail: prePublishDetail,
      rewardPayload: baseRewardPayload,
      rewardSignature,
      scoringMetadata: rewardScoringMetadata,
    });
    const rewardForensicDigest = `sha256:${sha256(rewardPayload.reward_forensics || {})}`;

    const paymentGuard = await claimRewardPaymentGuard({
      taskId: row.task_id,
      rewardPayload,
      rewardPft: economicRewardPft,
    });
    if (!paymentGuard.claimed) {
      throw new Error(`task_reward_payment_guard_active:${rewardPaymentGuardStatus(paymentGuard.guard) || "unknown"}`);
    }

    publicationAttempted = true;
    reward = await publishAuthorityPointer({
      payload: rewardPayload,
      contentKind: "REWARD",
      destination: row.subject_wallet,
      kind: "REWARD",
      signerWallet: rewardWallet,
      tasknodeKey,
      accountId: row.account_id,
      amountDrops: rewardAmountDrops,
    });
    await markRewardPaymentSubmitted({ taskId: row.task_id, reward });
    const recordedReward = await directWriteReviewTransition({
      row,
      transition: "rewarded",
      payload: {
        ...rewardPayload,
        cid: reward.cid,
        tx_hash: reward.txHash,
      },
      sourceTxHash: reward.txHash,
      sourceCid: reward.cid,
      metadata: {
        phase: "reward_scoring",
        workerName,
        reward_pft: score.reward_pft,
      },
    });
    const publishedRef = {
      txHash: reward.txHash,
      cid: reward.cid,
      forensicCid: reward.cid,
      forensicDigest: rewardForensicDigest,
      signature: rewardSignature,
      directWriteTxHash: recordedReward.event.sourceTxHash,
      directWriteCid: recordedReward.event.sourceCid,
    };
    await markReviewPublicationPublished({
      taskId: row.task_id,
      workerName,
      published: publishedRef,
      metadata: {
        source: "published_by_worker",
        reward_tx_hash: reward.txHash,
        reward_cid: reward.cid,
        forensic_cid: reward.cid,
        forensic_digest: rewardForensicDigest,
        reward_signature_digest: rewardSignature.payload_digest,
        reward_pft: score.reward_pft,
        economic_reward_pft: economicRewardPft.toFixed(2),
        transaction_amount_drops: rewardAmountDrops,
        carrier_amount_drops: rewardPayload.carrier_amount_drops,
        terminal_schema: "pf.reward.v1",
      },
    });
    await markWorkerPublished({ taskId: row.task_id, workerName, published: publishedRef });
    logger.info?.("task_reward_outcome_published_and_direct_written", {
      taskId: row.task_id,
      rewardTxHash: reward.txHash,
      rewardPft: score.reward_pft,
      amountDrops: rewardAmountDrops,
    });
    if (agentReviewDecision) {
      await markAgentDecisionConsumed({
        decisionId: agentReviewDecision.id,
        ref: { tx_hash: reward.txHash, cid: reward.cid, reward_pft: score.reward_pft },
      }).catch(() => null);
      await recordBoardRewardSpend({
        boardId: agentBoardId,
        taskId: row.task_id,
        accountId: row.account_id,
        walletAddress: row.subject_wallet,
        rewardPft: Number(score.reward_pft || 0),
        decisionId: agentReviewDecision.id,
      }).catch(() => null);
    }
    return { ok: true, taskId: row.task_id, reward };
  } catch (error) {
    if (publicationAttempted) {
      if (submissionDefinitelyNotAttempted(error)) {
        const retry = await markReviewPublicationRetryWait({
          taskId: row.task_id,
          workerName,
          error: error?.message || String(error),
          metadata: {
            publication_attempted: true,
            submission_stage: safeText(error?.submissionStage, 80),
          },
        }).catch(() => null);
        await markRewardPaymentRetryWait({
          taskId: row.task_id,
          error: error?.message || error,
          retryAfter: retry?.retryAfter || "",
        }).catch(() => null);
      } else {
        await markReviewPublicationError({
          taskId: row.task_id,
          workerName,
          error: error?.message || String(error),
          metadata: {
            publication_attempted: true,
            submission_attempted: true,
            submission_stage: safeText(error?.submissionStage, 80),
            reward_tx_hash: reward?.txHash || "",
            reward_cid: reward?.cid || "",
          },
        }).catch(() => null);
        await markRewardPaymentSubmitUnknown({
          taskId: row.task_id,
          error: error?.message || error,
        }).catch(() => null);
      }
    } else if (publicationLock?.acquired) {
      await releaseReviewPublicationLock({ taskId: row.task_id, workerName }).catch(() => null);
    }
    throw error;
  }
}

export const taskReviewWorkerInternals = {
  buildRewardEvidenceEvaluationContext,
  latestRewardPaymentEvent,
  normalizeReward,
  rewardPaymentGuardBlocksRetry,
  rewardPaymentGuardCanSkipPreflightSync,
  rewardPaymentGuardPayload,
  rewardPaymentGuardStatus,
  submissionDefinitelyNotAttempted,
  taskReviewRetryDelayMs,
};
