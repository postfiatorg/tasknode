import { createHash } from "node:crypto";
import { normalizeNetworkTaskRewardBand } from "./network-tasks.js";

export const boardManagerPromptVersion = "board_manager_v1";
export const boardManagerActions = Object.freeze([
  "do_nothing",
  "refresh_hive_secretary",
  "message_user",
  "create_project",
  "archive_project",
  "restore_project",
  "refresh_project_document",
  "assign_contributor",
  "initiate_network_task",
  "cancel_network_task",
]);

export const boardManagerInternalActions = Object.freeze([
  "daily_airdrop",
]);

export const actionSet = new Set([...boardManagerActions, ...boardManagerInternalActions]);
export const emptyBoardManagerPayload = Object.freeze({
  summary: "",
  next_steps: [],
  message_text: "",
  archive_reason: "",
  project: {
    id: "",
    type: "",
    title: "",
    summary: "",
    objective: "",
    about: "",
    priority: 0,
    phase_label: "",
    phase_current: 0,
    phase_total: 0,
    pft_routed: 0,
    task_count: 0,
    contributor_count: 0,
  },
  project_document: {
    title: "",
    summary: "",
    project_status: "",
    key_points: [],
    blocked_or_unclear: [],
    next_actions: [],
  },
  contributor: {
    project_id: "",
    account_id: "",
    wallet_address: "",
    codename: "",
    archetype: "",
    role_label: "",
    status: "",
    allotted: false,
    cap: 0,
    load: 0,
    sort_order: 0,
  },
  network_task: {
    task_work_type: "",
    required_badge_id: "",
    operating_badge_id: "",
    badge_work_type: "",
    badge_reason: "",
    badge_reward_cap_pft: 0,
    badge_evidence_requirements: [],
    discord_evidence_required: true,
    task_class: "",
    candidate_account_id: "",
    candidate_wallet_address: "",
    project_need_summary: "",
    routing_reason: "",
    cadence_reason: "",
    action_output: "",
    delivery_surface: "",
    recipient_or_reviewer: "",
    escalation_stage: "",
    lineage_task_ids: [],
    referenced_outputs: [],
    deduped_against: [],
    why_not_duplicate: "",
    reward_min_pft: 100,
    reward_max_pft: 50000,
    accept_window_hours: 24,
    allow_over_capacity: false,
  },
  message_precondition: {
    intent: "",
    project_id: "",
    related_task_id: "",
    related_allocation_id: "",
    expected_task_status: [],
    expected_allocation_status: [],
    expected_followup_status: "",
    expected_min_reward_pft: 0,
    allow_terminal_task: false,
  },
  cancel_target: {
    task_id: "",
    reason: "",
    referenced_task_ids: [],
  },
});


export function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

export function normalizeLineageTaskIds(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => safeText(item, 180))
    .filter(Boolean);
}

export function normalizeReferencedOutputs(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => {
      const input = safeObject(item);
      return {
        task_id: safeText(input.task_id || input.taskId, 180),
        cid: safeText(input.cid || input.source_cid || input.sourceCid, 240),
        tx_hash: safeText(input.tx_hash || input.txHash || input.source_tx_hash || input.sourceTxHash, 180),
        summary: safeText(input.summary || input.title || input.description, 700),
        how_used: safeText(input.how_used || input.howUsed, 700),
      };
    })
    .filter((item) => item.task_id || item.cid || item.tx_hash || item.summary);
}

export function normalizeDedupedAgainst(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => {
      const input = safeObject(item);
      return {
        task_id: safeText(input.task_id || input.taskId, 180),
        theme: safeText(input.theme || input.title, 240),
        reason_not_repeated: safeText(input.reason_not_repeated || input.reasonNotRepeated || input.reason, 700),
      };
    })
    .filter((item) => item.task_id || item.theme || item.reason_not_repeated);
}

export function normalizePayload(payload = {}) {
  const input = safeObject(payload);
  const project = safeObject(input.project);
  const projectDocument = safeObject(input.project_document || input.projectDocument);
  const contributor = safeObject(input.contributor);
  const networkTask = safeObject(input.network_task || input.networkTask);
  const messagePrecondition = safeObject(input.message_precondition || input.messagePrecondition);
  const cancelTarget = safeObject(input.cancel_target || input.cancelTarget);
  const rewardBand = normalizeNetworkTaskRewardBand({
    min: networkTask.reward_min_pft ?? networkTask.rewardMinPft,
    max: networkTask.reward_max_pft ?? networkTask.rewardMaxPft,
  });
  const discordEvidenceRequired = networkTask.discord_evidence_required ?? networkTask.discordEvidenceRequired;
  return {
    summary: safeText(input.summary, 2000),
    next_steps: safeArray(input.next_steps || input.nextSteps).slice(0, 8).map((item) => safeText(item, 500)).filter(Boolean),
    message_text: safeText(input.message_text || input.messageText, 4000),
    followup_required: input.followup_required === false || input.followupRequired === false ? false : true,
    archive_reason: safeText(input.archive_reason || input.archiveReason, 1000),
    project: {
      id: safeText(project.id, 180),
      type: safeText(project.type, 80),
      title: safeText(project.title, 180),
      summary: safeText(project.summary, 600),
      objective: safeText(project.objective, 900),
      about: safeText(project.about, 2000),
      priority: Math.max(0, Math.round(Number(project.priority || 0) || 0)),
      phase_label: safeText(project.phase_label || project.phaseLabel, 100),
      phase_current: Math.max(0, Math.round(Number(project.phase_current ?? project.phaseCurrent ?? 0) || 0)),
      phase_total: Math.max(0, Math.round(Number(project.phase_total ?? project.phaseTotal ?? 0) || 0)),
      pft_routed: Math.max(0, Number(project.pft_routed ?? project.pftRouted ?? 0) || 0),
      task_count: Math.max(0, Math.round(Number(project.task_count ?? project.taskCount ?? 0) || 0)),
      contributor_count: Math.max(0, Math.round(Number(project.contributor_count ?? project.contributorCount ?? 0) || 0)),
    },
    project_document: {
      title: safeText(projectDocument.title, 180),
      summary: safeText(projectDocument.summary, 1200),
      project_status: safeText(projectDocument.project_status || projectDocument.projectStatus, 1800),
      key_points: safeArray(projectDocument.key_points || projectDocument.keyPoints).slice(0, 8).map((item) => safeText(item, 700)).filter(Boolean),
      blocked_or_unclear: safeArray(projectDocument.blocked_or_unclear || projectDocument.blockedOrUnclear).slice(0, 6).map((item) => safeText(item, 700)).filter(Boolean),
      next_actions: safeArray(projectDocument.next_actions || projectDocument.nextActions).slice(0, 6).map((item) => safeText(item, 700)).filter(Boolean),
    },
    contributor: {
      project_id: safeText(contributor.project_id || contributor.projectId, 180),
      account_id: safeText(contributor.account_id || contributor.accountId, 180),
      wallet_address: safeText(contributor.wallet_address || contributor.walletAddress, 120),
      codename: safeText(contributor.codename, 120),
      archetype: safeText(contributor.archetype, 180),
      role_label: safeText(contributor.role_label || contributor.roleLabel, 80),
      status: safeText(contributor.status, 80),
      allotted: Boolean(contributor.allotted),
      cap: Math.max(0, Math.round(Number(contributor.cap || 0) || 0)),
      load: Math.max(0, Math.round(Number(contributor.load || 0) || 0)),
      sort_order: Math.max(0, Math.round(Number(contributor.sort_order ?? contributor.sortOrder ?? 0) || 0)),
    },
    network_task: {
      task_work_type: safeText(networkTask.task_work_type || networkTask.taskWorkType, 80),
      required_badge_id: safeText(networkTask.required_badge_id || networkTask.requiredBadgeId, 80),
      operating_badge_id: safeText(networkTask.operating_badge_id || networkTask.operatingBadgeId, 80),
      badge_work_type: safeText(networkTask.badge_work_type || networkTask.badgeWorkType, 120),
      badge_reason: safeText(networkTask.badge_reason || networkTask.badgeReason, 1000),
      badge_reward_cap_pft: Math.max(0, Number(networkTask.badge_reward_cap_pft ?? networkTask.badgeRewardCapPft ?? 0) || 0),
      badge_evidence_requirements: safeArray(networkTask.badge_evidence_requirements || networkTask.badgeEvidenceRequirements)
        .slice(0, 8)
        .map((item) => safeText(item, 500))
        .filter(Boolean),
      discord_evidence_required: typeof discordEvidenceRequired === "boolean" ? discordEvidenceRequired : true,
      task_class: safeText(networkTask.task_class || networkTask.taskClass, 40),
      candidate_account_id: safeText(networkTask.candidate_account_id || networkTask.candidateAccountId, 180),
      candidate_wallet_address: safeText(networkTask.candidate_wallet_address || networkTask.candidateWalletAddress, 120),
      project_need_summary: safeText(networkTask.project_need_summary || networkTask.projectNeedSummary, 2000),
      routing_reason: safeText(networkTask.routing_reason || networkTask.routingReason, 1800),
      cadence_reason: safeText(networkTask.cadence_reason || networkTask.cadenceReason, 700),
      action_output: safeText(networkTask.action_output || networkTask.actionOutput, 1200),
      delivery_surface: safeText(networkTask.delivery_surface || networkTask.deliverySurface, 120),
      recipient_or_reviewer: safeText(networkTask.recipient_or_reviewer || networkTask.recipientOrReviewer, 240),
      escalation_stage: safeText(networkTask.escalation_stage || networkTask.escalationStage, 120),
      lineage_task_ids: normalizeLineageTaskIds(networkTask.lineage_task_ids || networkTask.lineageTaskIds),
      referenced_outputs: normalizeReferencedOutputs(networkTask.referenced_outputs || networkTask.referencedOutputs),
      deduped_against: normalizeDedupedAgainst(networkTask.deduped_against || networkTask.dedupedAgainst),
      why_not_duplicate: safeText(networkTask.why_not_duplicate || networkTask.whyNotDuplicate, 1200),
      reward_min_pft: rewardBand.min,
      reward_max_pft: rewardBand.max,
      accept_window_hours: (() => {
        const raw = Math.round(Number(networkTask.accept_window_hours ?? networkTask.acceptWindowHours ?? 0) || 0);
        return raw > 0 ? Math.min(336, Math.max(1, raw)) : 0;
      })(),
      allow_over_capacity: Boolean(networkTask.allow_over_capacity || networkTask.allowOverCapacity),
    },
    message_precondition: {
      intent: safeText(messagePrecondition.intent, 80),
      project_id: safeText(messagePrecondition.project_id || messagePrecondition.projectId, 180),
      related_task_id: safeText(messagePrecondition.related_task_id || messagePrecondition.relatedTaskId, 180),
      related_allocation_id: safeText(
        messagePrecondition.related_allocation_id || messagePrecondition.relatedAllocationId,
        180
      ),
      expected_task_status: safeArray(messagePrecondition.expected_task_status || messagePrecondition.expectedTaskStatus)
        .map((item) => safeText(item, 80).toLowerCase())
        .filter(Boolean)
        .slice(0, 8),
      expected_allocation_status: safeArray(
        messagePrecondition.expected_allocation_status || messagePrecondition.expectedAllocationStatus
      )
        .map((item) => safeText(item, 80).toLowerCase())
        .filter(Boolean)
        .slice(0, 8),
      expected_followup_status: safeText(
        messagePrecondition.expected_followup_status || messagePrecondition.expectedFollowupStatus,
        80
      ).toLowerCase(),
      expected_min_reward_pft: Math.max(
        0,
        Number(messagePrecondition.expected_min_reward_pft ?? messagePrecondition.expectedMinRewardPft ?? 0) || 0
      ),
      allow_terminal_task: Boolean(messagePrecondition.allow_terminal_task || messagePrecondition.allowTerminalTask),
    },
    cancel_target: {
      task_id: safeText(cancelTarget.task_id || cancelTarget.taskId, 180),
      reason: safeText(cancelTarget.reason, 1000),
      referenced_task_ids: safeArray(cancelTarget.referenced_task_ids || cancelTarget.referencedTaskIds)
        .map((item) => safeText(item, 180))
        .filter(Boolean)
        .slice(0, 12),
    },
  };
}

export function normalizeDecisionBasis(decision = {}, fallbackReason = "") {
  const input = safeObject(decision.decision_basis || decision.decisionBasis);
  const sourceFacts = safeArray(input.source_facts || input.sourceFacts)
    .map((item) => safeText(item, 500))
    .filter(Boolean)
    .slice(0, 8);
  const tradeoffs = safeArray(input.tradeoffs)
    .map((item) => safeText(item, 500))
    .filter(Boolean)
    .slice(0, 6);
  const rejectedActions = safeArray(input.rejected_actions || input.rejectedActions)
    .map((item) => {
      const action = safeText(item?.action, 80);
      if (!boardManagerActions.includes(action)) return null;
      return {
        action,
        reason: safeText(item?.reason, 500),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
  const riskNotes = safeArray(input.risk_notes || input.riskNotes)
    .map((item) => safeText(item, 500))
    .filter(Boolean)
    .slice(0, 6);
  return {
    source_facts: sourceFacts.length ? sourceFacts : [safeText(fallbackReason, 500) || "No structured source facts were recorded for this run."],
    tradeoffs,
    rejected_actions: rejectedActions,
    risk_notes: riskNotes,
    next_check: safeText(input.next_check || input.nextCheck, 700),
  };
}

export function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

export function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

export function ageMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null;
}

export function compactAuthorityBadges(value = []) {
  return safeArray(value).slice(0, 8).map((badge) => ({
    badgeId: safeText(badge.badgeId || badge.badge_id, 80),
    label: safeText(badge.label, 120),
    requirementsLabel: safeText(badge.requirementsLabel || badge.requirements_label, 120),
    handle: safeText(badge.handle, 120),
    matchedHandle: safeText(badge.matchedHandle || badge.matched_handle, 120),
    authority: safeArray(badge.authority).slice(0, 8).map((item) => safeText(item, 120)).filter(Boolean),
    proofMethod: safeText(badge.proofMethod || badge.proof_method, 120),
  })).filter((badge) => badge.badgeId);
}

export function compactContextDocument(document = {}) {
  return {
    id: safeText(document.id, 120),
    generatedAt: document.generatedAt,
    entryCount: Number(document.entryCount || 0),
    userCount: Number(document.userCount || 0),
    groups: safeArray(document.groups).slice(0, 3).map((group) => ({
      accountId: safeText(group.accountId, 160),
      displayName: safeText(group.displayName, 120),
      latestAt: group.latestAt || null,
      entryCount: Number(group.entryCount || 0),
      authorityBadges: compactAuthorityBadges(group.authorityBadges || group.authority_badges),
      entries: safeArray(group.entries).slice(0, 1).map((entry) => ({
        id: safeText(entry.id, 180),
        accountId: safeText(entry.accountId, 160),
        displayName: safeText(entry.displayName, 120),
        body: safeText(entry.body, 280),
        sourceConversationId: safeText(entry.sourceConversationId, 180),
        walletValidated: Boolean(entry.walletValidated),
        walletAddress: safeText(entry.walletAddress, 120),
        authorityBadges: compactAuthorityBadges(entry.authorityBadges || entry.authority_badges),
        createdAt: entry.createdAt || null,
      })),
    })),
  };
}

export function compactTask(row = {}) {
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    status: safeText(row.status, 80),
    title: safeText(row.title, 240),
    kind: safeText(row.task_kind, 80),
    rewardOfferPft: Number(row.reward_offer_pft || 0),
    rewardActualPft: Number(row.reward_actual_pft || 0),
    subjectWallet: safeText(row.subject_wallet, 120),
    updatedAt: iso(row.updated_at),
    lastEventAt: iso(row.last_event_at),
  };
}
