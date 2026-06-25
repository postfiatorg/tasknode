import { executeBoardManagerDecision } from "./board-manager-actions.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

function firstRewardCapForCandidate({ candidate = {}, workType = "", badgeId = "" } = {}) {
  const normalizedWorkType = safeText(workType, 120);
  const caps = safeObject(candidate.rewardCaps);
  if (normalizedWorkType && Number(caps[normalizedWorkType]) > 0) return numeric(caps[normalizedWorkType], 0);
  const badge = safeArray(candidate.badgeDetails).find((item) => !badgeId || item.badgeId === badgeId) ||
    safeArray(candidate.badgeDetails)[0] ||
    {};
  return numeric(badge.maxPayoutPft || 0, 0);
}

function findCandidate(sourcePacket = {}, payload = {}) {
  const accountId = safeText(payload.candidate_account_id || payload.candidateAccountId || payload.account_id || payload.accountId, 180);
  const walletAddress = safeText(payload.candidate_wallet_address || payload.candidateWalletAddress || payload.wallet_address || payload.walletAddress, 120);
  return safeArray(sourcePacket.candidates?.all)
    .find((candidate) => (
      (!accountId || candidate.accountId === accountId) &&
      (!walletAddress || candidate.walletAddress === walletAddress)
    )) || {};
}

function boardSourcePacketForHiveDecision(sourcePacket = {}) {
  const candidateAccounts = safeArray(sourcePacket.candidates?.all).map((candidate) => ({
    accountId: safeText(candidate.accountId, 180),
    displayName: safeText(candidate.identity?.displayName || candidate.identity?.hiveHandle || candidate.accountId, 160),
    hiveHandle: safeText(candidate.identity?.hiveHandle, 120),
    walletAddress: safeText(candidate.walletAddress, 120),
  })).filter((candidate) => candidate.accountId || candidate.walletAddress);
  const hiveContextEntries = safeArray(sourcePacket.boardDiscussions).map((entry) => ({
    id: safeText(entry.id, 180),
    accountId: safeText(entry.accountId, 180),
    displayName: safeText(entry.displayName || entry.speaker?.displayName, 160),
    sourceConversationId: safeText(entry.sourceConversationId || entry.source_conversation_id, 180),
    walletValidated: true,
  })).filter((entry) => entry.id || entry.accountId);

  return {
    ...sourcePacket,
    actionTargetRegistry: {
      accounts: candidateAccounts,
      contributorCandidates: candidateAccounts,
      hiveContextEntries,
    },
    networkTaskCandidates: candidateAccounts,
    hiveContext: {
      groups: hiveContextEntries.map((entry) => ({
        accountId: entry.accountId,
        displayName: entry.displayName,
        entries: [entry],
      })),
    },
  };
}

export function hiveDecisionAgentActive(env = process.env) {
  return env.TASKNODE_HIVE_DECISION_AGENT_ACTIVE === "true";
}

export function translateHiveDecisionToBoardDecision({ decision = {}, sourcePacket = {} } = {}) {
  const action = safeText(decision.action, 80).toLowerCase();
  const payload = safeObject(decision.payload);
  const reason = safeText(payload.routing_reason || decision.explanation || payload.archive_reason || payload.message_text, 2000) ||
    "Hive Decision Agent active cutover decision.";
  const confidence = numeric(decision.confidence, 0);

  if (action === "create_task") {
    const candidate = findCandidate(sourcePacket, payload);
    const requiredBadgeId = safeText(payload.required_badge_id || payload.requiredBadgeId || candidate.defaultBadge || candidate.verifiedBadges?.[0], 80);
    const taskWorkType = safeText(payload.task_work_type || payload.taskWorkType || candidate.allowedWorkTypes?.[0], 120);
    const operatingBadgeId = safeText(payload.operating_badge_id || payload.operatingBadgeId || requiredBadgeId, 80);
    const badgeRewardCapPft = numeric(
      payload.badge_reward_cap_pft || payload.badgeRewardCapPft || firstRewardCapForCandidate({
        candidate,
        workType: taskWorkType,
        badgeId: requiredBadgeId,
      }),
      0
    );
    return {
      action: "initiate_network_task",
      target_type: "network_project",
      target_id: safeText(payload.project_id || payload.projectId, 180),
      reason,
      confidence,
      decision_basis: {
        source_facts: safeArray(decision.informedBy?.taskStateRefs || decision.informed_by?.task_state_refs).slice(0, 10),
        rejected_actions: safeArray(decision.optionsConsidered || decision.options_considered)
          .map((option) => safeObject(option))
          .map((option) => safeText(option.rejectedBecause || option.rejected_because || option.summary, 500))
          .filter(Boolean)
          .slice(0, 6),
      },
      payload: {
        summary: safeText(payload.project_need_summary || payload.projectNeedSummary || payload.title, 1200),
        network_task: {
          task_class: "network",
          task_work_type: taskWorkType,
          required_badge_id: requiredBadgeId,
          operating_badge_id: operatingBadgeId,
          badge_work_type: safeText(payload.badge_work_type || payload.badgeWorkType || taskWorkType, 120),
          badge_reason: safeText(payload.routing_reason || reason, 1000),
          badge_reward_cap_pft: badgeRewardCapPft,
          discord_evidence_required: payload.discord_evidence_required ?? payload.discordEvidenceRequired ?? true,
          candidate_account_id: safeText(payload.candidate_account_id || payload.candidateAccountId, 180),
          candidate_wallet_address: safeText(payload.candidate_wallet_address || payload.candidateWalletAddress, 120),
          project_need_summary: safeText(
            [payload.title, payload.project_need_summary || payload.projectNeedSummary].filter(Boolean).join("\n\n"),
            2400
          ),
          routing_reason: safeText(payload.routing_reason || reason, 1800),
          cadence_reason: "hive_decision_agent_active_cutover",
          action_output: safeText(payload.action_output || payload.actionOutput, 1200),
          delivery_surface: safeText(payload.delivery_surface || payload.deliverySurface, 120),
          recipient_or_reviewer: safeText(payload.recipient_or_reviewer || payload.recipientOrReviewer, 240),
          escalation_stage: safeText(payload.escalation_stage || payload.escalationStage, 120),
          why_not_duplicate: safeText(payload.dedup_basis || payload.dedupBasis, 900),
          reward_min_pft: numeric(payload.reward_min_pft || payload.rewardMinPft, 100),
          reward_max_pft: numeric(payload.reward_max_pft || payload.rewardMaxPft || badgeRewardCapPft || 50000, 50000),
          accept_window_hours: 24,
        },
      },
    };
  }

  if (action === "cancel_task" || action === "cancel_network_task") {
    const taskId = safeText(payload.cancel_task_id || payload.cancelTaskId || payload.task_id || payload.taskId, 180);
    return {
      action: "cancel_network_task",
      target_type: "network_task",
      target_id: taskId,
      reason,
      confidence,
      payload: {
        cancel_target: {
          task_id: taskId,
          reason: safeText(payload.archive_reason || payload.cancel_reason || payload.cancelReason || reason, 1000),
          referenced_task_ids: safeArray(payload.referenced_task_ids || payload.referencedTaskIds)
            .map((item) => safeText(item, 180))
            .filter(Boolean)
            .slice(0, 12),
        },
      },
    };
  }

  if (action === "message_user") {
    return {
      action: "message_user",
      target_type: "account",
      target_id: safeText(payload.candidate_account_id || payload.candidateAccountId || payload.account_id || payload.accountId, 180),
      reason,
      confidence,
      payload: {
        summary: safeText(payload.message_text || payload.messageText, 1200),
        message_text: safeText(payload.message_text || payload.messageText, 4000),
        project: {
          id: safeText(payload.project_id || payload.projectId, 180),
        },
      },
    };
  }

  if (action === "create_board") {
    const title = safeText(payload.project_title || payload.projectTitle || payload.title, 180);
    const summary = safeText(payload.project_need_summary || payload.projectNeedSummary || payload.routing_reason || title, 600);
    return {
      action: "create_project",
      target_type: "network_project",
      target_id: safeText(payload.project_id || payload.projectId || title, 180),
      reason,
      confidence,
      payload: {
        project: {
          id: safeText(payload.project_id || payload.projectId || title, 180),
          type: safeText(payload.project_type || payload.projectType || "protocol_development", 80),
          title,
          summary,
          objective: safeText(payload.objective || summary, 900),
          about: safeText(payload.about || reason, 2000),
          priority: numeric(payload.priority, 0),
          phase_label: "active",
          phase_current: 1,
          phase_total: 1,
        },
      },
    };
  }

  if (action === "archive_board") {
    const projectId = safeText(payload.project_id || payload.projectId, 180);
    return {
      action: "archive_project",
      target_type: "network_project",
      target_id: projectId,
      reason,
      confidence,
      payload: {
        archive_reason: safeText(payload.archive_reason || payload.archiveReason || reason, 1000),
        project: { id: projectId },
      },
    };
  }

  return {
    action: "do_nothing",
    target_type: "",
    target_id: "",
    reason,
    confidence,
    payload: {},
  };
}

export async function executeHiveDecisionAgentAction({
  decision = {},
  sourcePacket = {},
  guardrailResult = {},
  active = hiveDecisionAgentActive(),
} = {}) {
  if (!active) {
    return {
      executed: false,
      shadow: true,
      reason: "hive_decision_agent_inactive",
    };
  }
  if (guardrailResult?.ok === false || guardrailResult?.blocked === true) {
    return {
      executed: false,
      skipped: true,
      reason: "hive_decision_agent_guardrail_blocked",
      guardrailResult,
    };
  }

  const translatedDecision = translateHiveDecisionToBoardDecision({ decision, sourcePacket });
  const actionResult = await executeBoardManagerDecision({
    runId: "",
    decision: translatedDecision,
    sourcePacket: boardSourcePacketForHiveDecision(sourcePacket),
    dryRun: false,
  });
  return {
    executed: actionResult?.result?.executed === true,
    action: safeText(decision.action, 80),
    translatedAction: translatedDecision.action,
    translatedTargetType: translatedDecision.target_type,
    translatedTargetId: translatedDecision.target_id,
    translatedDecision,
    result: actionResult?.result || null,
  };
}
