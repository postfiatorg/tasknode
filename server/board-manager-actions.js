import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "./db/pool.js";
import { appendAssistantMessage } from "./repositories/chat-assistant-messages.js";
import {
  ensureHiveConversation,
  hiveConversationIdForAccount,
} from "./repositories/chat-conversations.js";
import { enqueueHiveSecretaryJob } from "./repositories/hive-context.js";
import {
  boardManagerPromptVersion,
  normalizeBoardManagerDecision,
  recordBoardManagerActionResult,
} from "./repositories/board-manager.js";
import { scheduleHiveSecretaryQueue } from "./hive-secretary-worker.js";
import { scheduleNetworkTaskGenerationQueue } from "./network-task-generation-worker.js";
import {
  buildHiveProjectProductDocSourcePacket,
  completeHiveProjectProductDoc,
} from "./repositories/hive-project-product-docs.js";
import { applyCanonicalHiveProject } from "./hive-project-canonical.js";
import {
  enqueueNetworkTaskGenerationFromBoardDecision,
  syncNetworkTaskProjection,
} from "./repositories/network-tasks.js";
import {
  createBoardManagerFollowup,
  findOpenBoardManagerFollowup,
} from "./repositories/board-manager-state.js";
import { buildHiveAccountLiveState } from "./repositories/hive-account-live-state.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";

const projectTypes = new Set([
  "protocol_marketing",
  "protocol_development",
  "alpha_generation",
  "protocol_applications",
  "network_validation",
]);

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

function intValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function slug(value = "") {
  const normalized = safeText(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || `project_${randomUUID().slice(0, 12)}`;
}

function tokenSet(value = "") {
  return new Set(
    safeText(value, 600)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3)
  );
}

function tokenOverlapScore(left = "", right = "") {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function projectHasOperatorArchiveLock(project = {}) {
  const metadata = safeObject(project.metadata_json || project.metadata);
  return metadata.operator_archived === true ||
    metadata.operator_archived === "true" ||
    Boolean(metadata.archive_lock_source) ||
    Boolean(metadata.archive_lock_applied_at);
}

function projectIdForDecision(decision = {}) {
  const payload = safeObject(decision.payload);
  return safeText(
    payload.project?.id ||
      payload.contributor?.project_id ||
      payload.contributor?.projectId ||
      payload.network_task?.project_id ||
      payload.networkTask?.projectId ||
      (decision.target_type === "network_project" ? decision.target_id : ""),
    180
  );
}

function reportInput(sourcePacket = {}) {
  const report = sourcePacket?.hiveSecretary?.report || {};
  return {
    report_id: safeText(report.id, 180),
    source_packet_digest: safeText(report.sourcePacketDigest || sourcePacket?.hiveSecretarySource?.digest, 180),
    completed_at: report.completedAt || null,
    title: report.output?.title || "Hive Secretary Report",
  };
}

function displayNameForAccount(sourcePacket = {}, accountId = "") {
  for (const account of sourcePacket?.actionTargetRegistry?.accounts || []) {
    if (account.accountId === accountId) return safeText(account.displayName, 120);
  }
  for (const group of sourcePacket?.hiveContext?.groups || []) {
    if (group.accountId === accountId) return safeText(group.displayName, 120);
  }
  return safeText(accountId, 120);
}

function flattenHiveContextEntries(sourcePacket = {}) {
  const byId = new Map();
  for (const entry of sourcePacket?.actionTargetRegistry?.hiveContextEntries || []) {
    const id = safeText(entry.id, 180);
    if (!id) continue;
    byId.set(id, {
      id,
      accountId: safeText(entry.accountId, 180),
      displayName: safeText(entry.displayName, 120),
      sourceConversationId: safeText(entry.sourceConversationId, 180),
      walletValidated: Boolean(entry.walletValidated),
      walletAddress: safeText(entry.walletAddress, 120),
      createdAt: entry.createdAt || null,
    });
  }
  const groups = Array.isArray(sourcePacket?.hiveContext?.groups) ? sourcePacket.hiveContext.groups : [];
  for (const group of groups) {
    for (const entry of Array.isArray(group.entries) ? group.entries : []) {
      const id = safeText(entry.id, 180);
      if (!id) continue;
      byId.set(id, {
        ...entry,
        id,
        accountId: safeText(entry.accountId || group.accountId, 180),
        displayName: safeText(entry.displayName || group.displayName, 120),
      });
    }
  }
  return [...byId.values()];
}

function latestHiveInputForAccount({ accountId = "", sourcePacket = {} } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  return flattenHiveContextEntries(sourcePacket)
    .filter((entry) => entry.accountId === normalizedAccountId && safeText(entry.sourceConversationId, 180))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function sourceAccountIds(sourcePacket = {}) {
  const ids = new Set();
  for (const account of sourcePacket?.actionTargetRegistry?.accounts || []) {
    const accountId = safeText(account.accountId || account.account_id, 180);
    if (accountId) ids.add(accountId);
  }
  for (const entry of sourcePacket?.actionTargetRegistry?.hiveContextEntries || []) {
    const accountId = safeText(entry.accountId || entry.account_id, 180);
    if (accountId) ids.add(accountId);
  }
  for (const group of sourcePacket?.hiveContext?.groups || []) {
    const accountId = safeText(group.accountId, 180);
    if (accountId) ids.add(accountId);
  }
  for (const candidate of sourcePacket?.networkTaskCandidates || []) {
    const accountId = safeText(candidate.accountId || candidate.account_id, 180);
    if (accountId) ids.add(accountId);
  }
  for (const candidate of sourcePacket?.orcOperations?.routingCandidates || sourcePacket?.orc_operations?.routingCandidates || []) {
    const accountId = safeText(candidate.accountId || candidate.account_id, 180);
    if (accountId) ids.add(accountId);
  }
  return ids;
}

function sourceContributorCandidates(sourcePacket = {}) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = ({ accountId = "", walletAddress = "", displayName = "" } = {}) => {
    const normalizedWallet = safeText(walletAddress, 120);
    if (!normalizedWallet) return;
    const normalizedAccount = safeText(accountId, 180);
    const key = `${normalizedAccount}:${normalizedWallet}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      accountId: normalizedAccount,
      walletAddress: normalizedWallet,
      displayName: safeText(displayName, 120),
    });
  };

  for (const candidate of sourcePacket?.actionTargetRegistry?.contributorCandidates || []) {
    addCandidate({
      accountId: candidate.accountId || candidate.account_id,
      displayName: candidate.displayName || candidate.display_name,
      walletAddress: candidate.walletAddress || candidate.wallet_address,
    });
  }

  for (const entry of sourcePacket?.actionTargetRegistry?.hiveContextEntries || []) {
    if (!entry?.walletValidated) continue;
    addCandidate({
      accountId: entry.accountId || entry.account_id,
      displayName: entry.displayName || entry.display_name,
      walletAddress: entry.walletAddress || entry.wallet_address,
    });
  }

  for (const group of sourcePacket?.hiveContext?.groups || []) {
    const groupAccountId = safeText(group.accountId, 180);
    const groupDisplayName = safeText(group.displayName, 120);
    for (const entry of Array.isArray(group.entries) ? group.entries : []) {
      if (!entry?.walletValidated) continue;
      addCandidate({
        accountId: entry.accountId || groupAccountId,
        displayName: entry.displayName || groupDisplayName,
        walletAddress: entry.walletAddress,
      });
    }
  }

  for (const candidate of sourcePacket?.networkTaskCandidates || []) {
    addCandidate({
      accountId: candidate.accountId || candidate.account_id,
      displayName: candidate.displayName || candidate.display_name,
      walletAddress: candidate.walletAddress || candidate.wallet_address,
    });
  }

  for (const candidate of sourcePacket?.orcOperations?.routingCandidates || sourcePacket?.orc_operations?.routingCandidates || []) {
    addCandidate({
      accountId: candidate.accountId || candidate.account_id,
      displayName: candidate.handle || candidate.displayName || candidate.display_name,
      walletAddress: candidate.walletAddress || candidate.wallet_address,
    });
  }

  return candidates;
}

function resolveMessageTarget({ decision, sourcePacket }) {
  const targetType = safeText(decision.target_type, 120);
  const targetId = safeText(decision.target_id, 180);
  const entries = flattenHiveContextEntries(sourcePacket);
  if (targetType === "hive_context_entry") {
    const entry = entries.find((item) => item.id === targetId);
    if (!entry) throw new Error("board_manager_message_user_hive_input_not_found");
    return {
      accountId: safeText(entry.accountId, 180),
      conversationId: safeText(entry.sourceConversationId, 180) || hiveConversationIdForAccount(entry.accountId),
      hiveContextEntryId: safeText(entry.id, 180),
      displayName: safeText(entry.displayName, 120),
    };
  }

  const accountId = targetId;
  if (!sourceAccountIds(sourcePacket).has(accountId)) {
    throw new Error("board_manager_message_user_account_not_in_source_packet");
  }
  const entry = latestHiveInputForAccount({ accountId, sourcePacket });
  return {
    accountId,
    conversationId: safeText(entry?.sourceConversationId, 180) || hiveConversationIdForAccount(accountId),
    hiveContextEntryId: safeText(entry?.id, 180),
    displayName: safeText(entry?.displayName, 120) || displayNameForAccount(sourcePacket, accountId),
  };
}

async function recordResult({ runId, decision, result }) {
  if (!runId) return { ok: true, skipped: true, reason: "run_not_recorded", result };
  return recordBoardManagerActionResult({
    runId,
    action: decision.action,
    targetType: decision.target_type,
    targetId: decision.target_id,
    result,
  });
}

async function findDuplicateMessageDelivery({ accountId = "", hiveContextEntryId = "" } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedHiveContextEntryId = safeText(hiveContextEntryId, 180);
  if (!normalizedAccountId || !normalizedHiveContextEntryId) return null;
  const existing = await query(
    `
      SELECT id, run_id, account_id, message_text, created_at, metadata_json
      FROM board_manager_user_messages
      WHERE account_id = $1
        AND status <> 'archived'
        AND metadata_json->>'hive_context_entry_id' = $2
        AND EXISTS (
          SELECT 1
          FROM chat_messages cm
          WHERE cm.id = board_manager_user_messages.metadata_json->>'chat_message_id'
            AND cm.account_id = board_manager_user_messages.account_id
            AND cm.conversation_id = board_manager_user_messages.metadata_json->>'conversation_id'
            AND cm.role = 'assistant'
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId, normalizedHiveContextEntryId]
  );
  return existing.rows[0] || null;
}

async function findRecentAccountMessageDelivery({ accountId = "", hours = 6 } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return null;
  const windowHours = Math.min(Math.max(Number(hours) || 6, 1), 24);
  const existing = await query(
    `
      SELECT id, run_id, account_id, message_text, created_at, metadata_json
      FROM board_manager_user_messages
      WHERE account_id = $1
        AND status <> 'archived'
        AND created_at > now() - ($2::text || ' hours')::interval
        AND EXISTS (
          SELECT 1
          FROM chat_messages cm
          WHERE cm.id = board_manager_user_messages.metadata_json->>'chat_message_id'
            AND cm.account_id = board_manager_user_messages.account_id
            AND cm.conversation_id = board_manager_user_messages.metadata_json->>'conversation_id'
            AND cm.role = 'assistant'
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId, String(windowHours)]
  );
  return existing.rows[0] || null;
}

const staleGuardTerminalStatuses = new Set([
  "refused",
  "rejected",
  "cancelled",
  "expired",
  "rerouted",
  "rewarded",
  "completed",
  "failed",
]);

function decisionUserMessageText(decision = {}, messageText = "") {
  const payload = safeObject(decision.payload);
  return [
    messageText,
    decision.reason,
    payload.summary,
    payload.network_task?.routing_reason,
    payload.network_task?.project_need_summary,
    safeArray(payload.next_steps).join(" "),
  ].filter(Boolean).join("\n");
}

function messageIsInformationalNoFollowup(decision = {}) {
  return safeObject(decision.payload).followup_required === false;
}

function messageRequestsTaskAction(text = "") {
  const value = safeText(text, 5000).toLowerCase();
  if (!value) return false;
  return /\b(network\s+task|proposed\s+task|task\s+waiting|accept|accepted|decline|refuse|review|act\s+on|respond|capacity|unblock|waiting\s+for\s+(?:your|user|candidate))\b/.test(value);
}

function messageRequiresRelatedTaskPrecondition(text = "") {
  const value = safeText(text, 5000).toLowerCase();
  if (!value) return false;
  return /\b(proposed\s+(?:network\s+)?task|network\s+task\s+waiting|task\s+waiting|accept|decline|refuse|review\s+(?:the\s+)?(?:task|offer)|act\s+on|respond\s+to\s+(?:the\s+)?(?:task|offer)|verification|submit\s+evidence|unblock\s+(?:your\s+)?capacity)\b/.test(value);
}

function taskReferenceMatchesText(task = {}, text = "") {
  const haystack = safeText(text, 7000).toLowerCase();
  const refs = [
    task.taskId,
    task.allocationId,
    task.generationJobId,
    task.requestId,
    task.title,
    task.projectNeedSummary,
  ].map((item) => safeText(item, 240).toLowerCase()).filter((item) => item.length >= 6);
  return refs.some((ref) => haystack.includes(ref));
}

function messagePrecondition(decision = {}) {
  return safeObject(safeObject(decision.payload).message_precondition || safeObject(decision.payload).messagePrecondition);
}

function normalizedMessagePrecondition(decision = {}) {
  const input = messagePrecondition(decision);
  return {
    intent: safeText(input.intent, 80),
    projectId: safeText(input.project_id || input.projectId, 180),
    relatedTaskId: safeText(input.related_task_id || input.relatedTaskId, 180),
    relatedAllocationId: safeText(input.related_allocation_id || input.relatedAllocationId, 180),
    expectedTaskStatus: safeArray(input.expected_task_status || input.expectedTaskStatus)
      .map((item) => safeText(item, 80).toLowerCase())
      .filter(Boolean),
    expectedAllocationStatus: safeArray(input.expected_allocation_status || input.expectedAllocationStatus)
      .map((item) => safeText(item, 80).toLowerCase())
      .filter(Boolean),
    expectedFollowupStatus: safeText(input.expected_followup_status || input.expectedFollowupStatus, 80).toLowerCase(),
    expectedMinRewardPft: numberValue(input.expected_min_reward_pft ?? input.expectedMinRewardPft, 0),
    allowTerminalTask: Boolean(input.allow_terminal_task || input.allowTerminalTask),
  };
}

function messagePreconditionHasAssertions(decision = {}) {
  const precondition = normalizedMessagePrecondition(decision);
  return Boolean(
    precondition.intent ||
      precondition.projectId ||
      precondition.relatedTaskId ||
      precondition.relatedAllocationId ||
      precondition.expectedTaskStatus.length ||
      precondition.expectedAllocationStatus.length ||
      precondition.expectedFollowupStatus ||
      precondition.expectedMinRewardPft > 0 ||
      precondition.allowTerminalTask
  );
}

function taskMatchesPrecondition(task = {}, precondition = {}) {
  const taskId = safeText(task.taskId || task.task_id, 180);
  const allocationId = safeText(task.allocationId || task.allocation_id, 180);
  if (precondition.relatedTaskId && taskId === precondition.relatedTaskId) return true;
  if (precondition.relatedAllocationId && allocationId === precondition.relatedAllocationId) return true;
  return false;
}

function followupMatchesPrecondition(followup = {}, precondition = {}) {
  const projectId = safeText(precondition.projectId, 180);
  if (!projectId) return true;
  return safeText(followup.projectId || followup.project_id, 180) === projectId;
}

export function evaluateBoardManagerMessagePrecondition({
  decision = {},
  messageText = "",
  accountLiveState = {},
} = {}) {
  const combinedText = decisionUserMessageText(decision, messageText);
  const precondition = normalizedMessagePrecondition(decision);
  const hasAssertions = messagePreconditionHasAssertions(decision);
  const requiresRelatedTask = messageRequiresRelatedTaskPrecondition(combinedText);
  if (!hasAssertions && !requiresRelatedTask) {
    return { ok: true, reason: "message_precondition_not_required" };
  }
  if (requiresRelatedTask && !precondition.relatedTaskId && !precondition.relatedAllocationId) {
    return {
      ok: false,
      reason: "board_manager_message_user_missing_structured_precondition",
      messageIntent: precondition.intent,
    };
  }

  const liveState = safeObject(accountLiveState);
  if (!liveState.ok) {
    return {
      ok: false,
      reason: "board_manager_message_user_live_state_unavailable",
      accountLiveStateStatus: safeText(liveState.status, 80),
      accountLiveStateError: safeText(liveState.error, 300),
    };
  }

  const tasks = safeArray(liveState.networkTasks);
  const followups = safeArray(liveState.openFollowups);
  if (precondition.expectedFollowupStatus) {
    const matchingFollowups = followups.filter((followup) => followupMatchesPrecondition(followup, precondition));
    if (precondition.expectedFollowupStatus === "none_open" && matchingFollowups.length > 0) {
      return {
        ok: false,
        reason: "board_manager_message_precondition_open_followup",
        projectId: precondition.projectId,
        openFollowupCount: matchingFollowups.length,
        accountLiveStateDigest: safeText(liveState.digest, 120),
      };
    }
    if (precondition.expectedFollowupStatus === "open" && matchingFollowups.length === 0) {
      return {
        ok: false,
        reason: "board_manager_message_precondition_missing_open_followup",
        projectId: precondition.projectId,
        accountLiveStateDigest: safeText(liveState.digest, 120),
      };
    }
  }

  if (!precondition.relatedTaskId && !precondition.relatedAllocationId) {
    return {
      ok: true,
      reason: "message_precondition_no_related_task",
      accountLiveStateDigest: safeText(liveState.digest, 120),
    };
  }

  const task = tasks.find((item) => taskMatchesPrecondition(item, precondition));
  if (!task) {
    return {
      ok: false,
      reason: "board_manager_message_precondition_task_missing",
      relatedTaskId: precondition.relatedTaskId,
      relatedAllocationId: precondition.relatedAllocationId,
      accountLiveStateDigest: safeText(liveState.digest, 120),
    };
  }

  const taskStatus = safeText(task.taskStatus || task.status || "", 80).toLowerCase();
  const allocationStatus = safeText(task.allocationStatus || task.allocation_status || "", 80).toLowerCase();
  const terminal = Boolean(task.terminal) || staleGuardTerminalStatuses.has(taskStatus || allocationStatus);
  if (terminal && !precondition.allowTerminalTask) {
    return {
      ok: false,
      reason: "board_manager_message_precondition_terminal_task",
      taskId: task.taskId,
      allocationId: task.allocationId,
      taskStatus,
      allocationStatus,
      accountLiveStateDigest: safeText(liveState.digest, 120),
    };
  }
  if (precondition.expectedTaskStatus.length && !precondition.expectedTaskStatus.includes(taskStatus)) {
    return {
      ok: false,
      reason: "board_manager_message_precondition_task_status_mismatch",
      taskId: task.taskId,
      allocationId: task.allocationId,
      expectedTaskStatus: precondition.expectedTaskStatus,
      actualTaskStatus: taskStatus,
      accountLiveStateDigest: safeText(liveState.digest, 120),
    };
  }
  if (
    precondition.expectedAllocationStatus.length &&
    !precondition.expectedAllocationStatus.includes(allocationStatus)
  ) {
    return {
      ok: false,
      reason: "board_manager_message_precondition_allocation_status_mismatch",
      taskId: task.taskId,
      allocationId: task.allocationId,
      expectedAllocationStatus: precondition.expectedAllocationStatus,
      actualAllocationStatus: allocationStatus,
      accountLiveStateDigest: safeText(liveState.digest, 120),
    };
  }
  if (precondition.expectedMinRewardPft > 0) {
    const reward = numberValue(task.rewardMaxPft || task.rewardOfferPft || task.rewardMinPft, 0);
    if (!reward || reward < precondition.expectedMinRewardPft) {
      return {
        ok: false,
        reason: "board_manager_message_precondition_reward_below_minimum",
        taskId: task.taskId,
        allocationId: task.allocationId,
        expectedMinRewardPft: precondition.expectedMinRewardPft,
        actualRewardPft: reward,
        accountLiveStateDigest: safeText(liveState.digest, 120),
      };
    }
  }
  return {
    ok: true,
    reason: "message_precondition_satisfied",
    taskId: task.taskId,
    allocationId: task.allocationId,
    accountLiveStateDigest: safeText(liveState.digest, 120),
  };
}

function messageAcknowledgesReservationMismatch(text = "", reservationMinPft = 0) {
  const value = safeText(text, 5000).toLowerCase();
  if (!reservationMinPft) return true;
  const compactMin = String(Math.round(reservationMinPft));
  const kMin = reservationMinPft % 1000 === 0 ? `${Math.round(reservationMinPft / 1000)}k` : "";
  return (
    value.includes("reservation") ||
    value.includes("minimum") ||
    value.includes("below") ||
    value.includes("under") ||
    value.includes(compactMin) ||
    (kMin && value.includes(kMin))
  );
}

export function guardBoardManagerMessageUserFreshness({
  decision = {},
  messageText = "",
  accountLiveState = {},
} = {}) {
  const liveState = safeObject(accountLiveState);
  const combinedText = decisionUserMessageText(decision, messageText);
  const wantsTaskAction = messageRequestsTaskAction(combinedText);
  const hasStructuredPrecondition = messagePreconditionHasAssertions(decision);
  const strictlyRequiresRelatedTask = messageRequiresRelatedTaskPrecondition(combinedText);
  if (messageIsInformationalNoFollowup(decision) && !hasStructuredPrecondition && !strictlyRequiresRelatedTask) {
    return { ok: true, reason: "informational_message_no_followup" };
  }
  if (!wantsTaskAction && !hasStructuredPrecondition) {
    return { ok: true, reason: "message_not_task_action" };
  }
  if (!liveState.ok) {
    return {
      ok: false,
      reason: "board_manager_message_user_live_state_unavailable",
      accountLiveStateStatus: safeText(liveState.status, 80),
      accountLiveStateError: safeText(liveState.error, 300),
    };
  }
  const preconditionResult = evaluateBoardManagerMessagePrecondition({
    decision,
    messageText,
    accountLiveState: liveState,
  });
  if (!preconditionResult.ok) {
    return {
      ok: false,
      reason: "board_manager_message_precondition_failed",
      precondition: preconditionResult,
      accountLiveStateDigest: safeText(liveState.digest, 120),
    };
  }
  const tasks = safeArray(liveState.networkTasks);
  const followups = safeArray(liveState.openFollowups);
  const referencedTerminalTask = tasks.find((task) => {
    const status = safeText(task.taskStatus || task.allocationStatus, 80).toLowerCase();
    return staleGuardTerminalStatuses.has(status) && taskReferenceMatchesText(task, combinedText);
  });
  if (referencedTerminalTask) {
    return {
      ok: false,
      reason: "board_manager_message_user_stale_terminal_task",
      taskId: referencedTerminalTask.taskId,
      allocationId: referencedTerminalTask.allocationId,
      taskStatus: referencedTerminalTask.taskStatus,
      allocationStatus: referencedTerminalTask.allocationStatus,
      accountLiveStateDigest: safeText(liveState.digest, 120),
    };
  }
  const waitingTasks = tasks.filter((task) => task.waitingForUser && !task.terminal);
  if (!waitingTasks.length) {
    return {
      ok: false,
      reason: "board_manager_message_user_stale_no_account_action",
      accountLiveStateDigest: safeText(liveState.digest, 120),
      openFollowupCount: followups.length,
    };
  }
  const reservationMinPft = numberValue(liveState.routingConstraints?.reservationRate?.minPft, 0);
  if (reservationMinPft > 0) {
    const belowMinimumTask = waitingTasks.find((task) => {
      const reward = numberValue(task.rewardMaxPft || task.rewardOfferPft || task.rewardMinPft, 0);
      return reward > 0 && reward < reservationMinPft;
    });
    if (belowMinimumTask && !messageAcknowledgesReservationMismatch(combinedText, reservationMinPft)) {
      return {
        ok: false,
        reason: "board_manager_message_user_below_reservation_rate",
        reservationMinPft,
        taskRewardMaxPft: belowMinimumTask.rewardMaxPft,
        taskId: belowMinimumTask.taskId,
        allocationId: belowMinimumTask.allocationId,
        accountLiveStateDigest: safeText(liveState.digest, 120),
      };
    }
  }
  return {
    ok: true,
    reason: "account_live_state_allows_message",
    waitingTaskCount: waitingTasks.length,
    openFollowupCount: followups.length,
    accountLiveStateDigest: safeText(liveState.digest, 120),
  };
}

async function executeMessageUser({ runId, decision, sourcePacket }) {
  const target = resolveMessageTarget({ decision, sourcePacket });
  const accountId = target.accountId;
  let conversationId = target.conversationId;
  const messageText = safeText(decision.payload.message_text || decision.payload.summary, 4000);
  const projectId = projectIdForDecision(decision);
  if (!accountId) throw new Error("board_manager_message_user_missing_account");
  if (!conversationId) conversationId = hiveConversationIdForAccount(accountId);
  if (!conversationId) throw new Error("board_manager_message_user_missing_conversation");
  if (!messageText) throw new Error("board_manager_message_user_missing_message");
  if (conversationId === hiveConversationIdForAccount(accountId)) {
    const hiveConversation = await ensureHiveConversation({ accountId });
    if (!hiveConversation.ok) {
      throw new Error(`board_manager_message_user_${hiveConversation.error || "hive_chat_unavailable"}`);
    }
    conversationId = hiveConversation.conversation?.conversationId || hiveConversation.conversation?.id || conversationId;
  }
  const accountLiveState = await buildHiveAccountLiveState({ accountId, limit: 12 });
  const messagePreconditionForAudit = normalizedMessagePrecondition(decision);
  const freshnessGuard = guardBoardManagerMessageUserFreshness({
    decision,
    messageText,
    accountLiveState,
  });
  if (!freshnessGuard.ok) {
    return {
      executed: false,
      skipped: true,
      reason: freshnessGuard.reason,
      accountId,
      projectId,
      conversationId,
      hiveContextEntryId: target.hiveContextEntryId,
      messagePreview: messageText.slice(0, 240),
      freshnessGuard,
    };
  }
  const duplicate = await findDuplicateMessageDelivery({
    accountId,
    hiveContextEntryId: target.hiveContextEntryId,
  });
  if (duplicate) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_message_user_duplicate_hive_context_entry",
      duplicateMessageId: duplicate.id,
      duplicateRunId: duplicate.run_id,
      accountId,
      conversationId,
      hiveContextEntryId: target.hiveContextEntryId,
      messagePreview: safeText(duplicate.message_text, 240),
    };
  }
  const openFollowup = await findOpenBoardManagerFollowup({
    accountId,
    projectId,
  });
  if (openFollowup) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_message_user_open_followup",
      followupId: openFollowup.id,
      accountId,
      projectId,
      conversationId,
      hiveContextEntryId: target.hiveContextEntryId,
      lastSentAt: openFollowup.lastSentAt,
      blockerSummary: openFollowup.blockerSummary,
    };
  }
  if (!target.hiveContextEntryId) {
    const recent = await findRecentAccountMessageDelivery({ accountId });
    if (recent) {
      return {
        executed: false,
        skipped: true,
        reason: "board_manager_message_user_recent_account_message",
        duplicateMessageId: recent.id,
        duplicateRunId: recent.run_id,
        accountId,
        conversationId,
        messagePreview: safeText(recent.message_text, 240),
      };
    }
  }
  const messageId = `boardmsg_${randomUUID()}`;
  const assistantMessageId = `msg_${messageId}_assistant`.slice(0, 180);
  const inserted = await query(
    `
      INSERT INTO board_manager_user_messages (
        id,
        run_id,
        account_id,
        display_name,
        message_text,
        status,
        source_action,
        source_packet_digest,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, 'sent', 'message_user', $6, $7::jsonb)
      RETURNING id, account_id, message_text, created_at
    `,
    [
      messageId,
      safeText(runId, 180),
      accountId,
      target.displayName || displayNameForAccount(sourcePacket, accountId),
      messageText,
      safeText(sourcePacket.sourcePacketDigest, 120),
      jsonValue({
        reason: decision.reason,
        next_steps: decision.payload.next_steps,
        conversation_id: conversationId,
        hive_context_entry_id: target.hiveContextEntryId,
        chat_message_id: assistantMessageId,
        account_live_state_digest: safeText(accountLiveState.digest, 120),
        account_live_state_snapshot_at: safeText(accountLiveState.snapshotAt, 80),
        message_precondition: messagePreconditionForAudit,
      }),
    ]
  );
  const chatTurn = await appendAssistantMessage({
    accountId,
    conversationId,
    mode: "Hive",
    provider: "tasknode",
    model: "board_manager",
    responseId: safeText(runId, 180),
    assistantMessage: messageText,
    assistantMessageId,
    assistantMetadata: {
      kind: "hive_manager_response",
      boardManagerRunId: safeText(runId, 180),
      boardManagerMessageId: inserted.rows[0]?.id || messageId,
      hiveContextEntryId: target.hiveContextEntryId,
      sourcePacketDigest: safeText(sourcePacket.sourcePacketDigest, 120),
      accountLiveStateDigest: safeText(accountLiveState.digest, 120),
      accountLiveStateSnapshotAt: safeText(accountLiveState.snapshotAt, 80),
      messagePrecondition: messagePreconditionForAudit,
      reason: decision.reason,
    },
  });
  const followupRequired = decision.payload.followup_required !== false;
  const followup = followupRequired
    ? await createBoardManagerFollowup({
        runId,
        accountId,
        projectId,
        hiveContextEntryId: target.hiveContextEntryId,
        conversationId,
        boardMessageId: inserted.rows[0]?.id || messageId,
        chatMessageId: chatTurn.assistant?.id || assistantMessageId,
        blockerType: projectId ? "project_blocked_on_user" : "account_followup",
        blockerSummary: safeText(decision.reason || decision.payload.summary, 1200),
        expectedResponse: safeText(decision.payload.next_steps?.join("; ") || decision.payload.summary, 1200),
        sourcePacketDigest: safeText(sourcePacket.sourcePacketDigest, 120),
        metadata: {
          target_type: decision.target_type,
          target_id: decision.target_id,
          hive_context_entry_id: target.hiveContextEntryId,
          decision_summary: decision.payload.summary,
          account_live_state_digest: safeText(accountLiveState.digest, 120),
          account_live_state_snapshot_at: safeText(accountLiveState.snapshotAt, 80),
          related_task_ids: safeArray(accountLiveState.networkTasks).map((task) => task.taskId).filter(Boolean),
          related_allocation_ids: safeArray(accountLiveState.networkTasks).map((task) => task.allocationId).filter(Boolean),
          message_precondition: messagePreconditionForAudit,
        },
      }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
    : { ok: true, skipped: true, reason: "followup_not_required", followup: null };
  await recordUserObservabilityEvent({
    eventType: "user.hive.board_message_delivered",
    accountId,
    conversationId,
    projectId,
    sourceSurface: "hive",
    sourceRoute: "server/board-manager-actions.js::executeMessageUser",
    resultStatus: "sent",
    reasonCode: "message_user",
    metadata: {
      boardMessageId: inserted.rows[0]?.id || messageId,
      runId: safeText(runId, 180),
      chatMessageId: chatTurn.assistant?.id || assistantMessageId,
      hiveContextEntryId: target.hiveContextEntryId,
      sourcePacketDigest: safeText(sourcePacket.sourcePacketDigest, 120),
      followupId: followup.followup?.id || "",
      followupCreated: followupRequired && followup.ok === true && followup.idempotent !== true,
      followupRequired,
    },
    metrics: {
      messageCharacterCount: messageText.length,
    },
  }).catch(() => {});
  if (followup.followup?.id) {
    await recordUserObservabilityEvent({
      eventType: "user.hive.followup_opened",
      accountId,
      conversationId,
      projectId,
      sourceSurface: "hive",
      sourceRoute: "server/board-manager-actions.js::executeMessageUser",
      resultStatus: followup.ok === false ? "failed" : followup.idempotent ? "already_open" : "open",
      reasonCode: followup.ok === false ? followup.error || "followup_open_failed" : "message_user",
      metadata: {
        followupId: followup.followup.id,
        boardMessageId: inserted.rows[0]?.id || messageId,
        runId: safeText(runId, 180),
        blockerType: safeText(followup.followup.blockerType || followup.followup.blocker_type, 120),
      },
    }).catch(() => {});
  }
  return {
    executed: true,
    messageId: inserted.rows[0]?.id || "",
    followupId: followup.followup?.id || "",
    accountId,
    projectId,
    conversationId,
    chatMessageId: chatTurn.assistant?.id || assistantMessageId,
    messagePreview: messageText.slice(0, 240),
  };
}

async function executeRefreshHiveSecretary({ decision }) {
  const queued = await enqueueHiveSecretaryJob({
    reason: "board_manager_refresh",
    sourceEntryId: safeText(decision.target_id, 180),
  });
  if (queued?.queued) {
    scheduleHiveSecretaryQueue({ delayMs: 250 });
  }
  return {
    executed: true,
    queued: Boolean(queued?.queued),
    jobId: queued?.job?.id || "",
    sourcePacketDigest: queued?.sourcePacket?.sourcePacketDigest || "",
    reason: queued?.reason || "",
  };
}

async function executeCreateProject({ runId, decision, sourcePacket }) {
  const project = applyCanonicalHiveProject(safeObject(decision.payload.project));
  const title = safeText(project.title, 180);
  const summary = safeText(project.summary, 600);
  const objective = safeText(project.objective, 900);
  const about = safeText(project.about, 2000);
  const id = slug(project.id || decision.target_id || title);
  const type = projectTypes.has(project.type) ? project.type : "protocol_development";
  if (!title || !summary || !objective) throw new Error("board_manager_create_project_missing_required_fields");
  const registry = await query(
    `
      SELECT id, title, summary, objective, status, metadata_json
      FROM network_projects
      ORDER BY updated_at DESC, id ASC
      LIMIT 200
    `
  );
  const exact = registry.rows.find((row) => row.id === id);
  if (exact?.status === "archived") {
    const canonicalProjectId = safeText(project.canonical_project_id, 180);
    if (canonicalProjectId === id && !projectHasOperatorArchiveLock(exact)) {
      // Continue into the upsert below. Canonical project creation is allowed
      // to reactivate an agent-archived canonical board instead of creating
      // another facet board.
    } else {
      return {
        executed: false,
        skipped: true,
        reason: "board_manager_create_project_archived_project_requires_restore",
        projectId: exact.id,
        title: exact.title,
        operatorLocked: projectHasOperatorArchiveLock(exact),
        recommendedAction: projectHasOperatorArchiveLock(exact) ? "operator_review" : "restore_project",
      };
    }
  }
  const titleSlug = slug(title);
  const similar = registry.rows.find((row) => {
    if (row.id === id) return false;
    const rowTitle = safeText(row.title, 180);
    if (!rowTitle) return false;
    if (slug(rowTitle) === titleSlug) return true;
    if (tokenOverlapScore(`${title} ${summary} ${objective}`, `${row.title} ${row.summary} ${row.objective}`) >= 0.62) {
      return true;
    }
    return false;
  });
  if (similar) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_create_project_similar_project_exists",
      projectId: similar.id,
      title: similar.title,
      status: similar.status,
      operatorLocked: projectHasOperatorArchiveLock(similar),
      recommendedAction: similar.status === "archived" && !projectHasOperatorArchiveLock(similar)
        ? "restore_project"
        : "append_or_refresh_existing_project",
    };
  }
  const hiveSecretary = reportInput(sourcePacket);
  const result = await query(
    `
      INSERT INTO network_projects (
        id,
        type,
        title,
        summary,
        objective,
        about,
        status,
        priority,
        origin,
        proposed_by,
        proposed_at,
        phase_label,
        phase_current,
        phase_total,
        pft_routed,
        task_count,
        contributor_count,
        source_hive_secretary_report_id,
        source_hive_secretary_report_digest,
        source_inputs_json,
        metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'active', $7, 'board_manager', 'board_manager',
        CURRENT_DATE, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        objective = EXCLUDED.objective,
        about = EXCLUDED.about,
        status = 'active',
        priority = EXCLUDED.priority,
        origin = EXCLUDED.origin,
        proposed_by = EXCLUDED.proposed_by,
        phase_label = EXCLUDED.phase_label,
        phase_current = EXCLUDED.phase_current,
        phase_total = EXCLUDED.phase_total,
        pft_routed = EXCLUDED.pft_routed,
        task_count = EXCLUDED.task_count,
        contributor_count = EXCLUDED.contributor_count,
        source_hive_secretary_report_id = EXCLUDED.source_hive_secretary_report_id,
        source_hive_secretary_report_digest = EXCLUDED.source_hive_secretary_report_digest,
        source_inputs_json = EXCLUDED.source_inputs_json,
        metadata_json = network_projects.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING id, title, status
    `,
    [
      id,
      type,
      title,
      summary,
      objective,
      about || objective,
      intValue(project.priority, 100),
      safeText(project.phase_label, 100),
      intValue(project.phase_current),
      intValue(project.phase_total),
      0,
      0,
      0,
      hiveSecretary.report_id,
      hiveSecretary.source_packet_digest,
      jsonValue({
        inputs: ["board_manager_action", "hive_secretary_report"],
        board_manager: {
          run_id: runId,
          source_packet_digest: sourcePacket.sourcePacketDigest,
        },
        hive_secretary: hiveSecretary,
      }),
      jsonValue({
        board_manager_reason: decision.reason,
        board_manager_created_at: new Date().toISOString(),
      }),
    ]
  );
  return { executed: true, projectId: result.rows[0]?.id || id, status: result.rows[0]?.status || "active" };
}

async function executeArchiveProject({ runId, decision, sourcePacket }) {
  const projectId = safeText(decision.target_id || decision.payload.project?.id, 180);
  if (!projectId) throw new Error("board_manager_archive_project_missing_project");
  const archiveReason = safeText(decision.payload.archive_reason || decision.reason, 1000);
  const existing = await query(
    `
      SELECT id, title, status
      FROM network_projects
      WHERE id = $1
      LIMIT 1
    `,
    [projectId]
  );
  if (!existing.rows[0]) throw new Error("board_manager_archive_project_not_found");

  const result = await query(
    `
      UPDATE network_projects
      SET status = 'archived',
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING id, title, status
    `,
    [
      projectId,
      jsonValue({
        agent_archived: true,
        agent_archived_reason: archiveReason,
        agent_archived_by: "board_manager",
        agent_archived_run_id: safeText(runId, 180),
        agent_archived_source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
        agent_archived_at: new Date().toISOString(),
        resurrection_policy: "planner_may_reactivate_unless_operator_archived_lock_is_present",
      }),
    ]
  );
  return {
    executed: true,
    projectId,
    status: result.rows[0].status,
    archiveReason,
  };
}

async function executeRestoreProject({ runId, decision, sourcePacket }) {
  const projectId = safeText(decision.target_id || decision.payload.project?.id, 180);
  if (!projectId) throw new Error("board_manager_restore_project_missing_project");
  const restoreReason = safeText(decision.payload.summary || decision.reason, 1000);
  const existing = await query(
    `
      SELECT id, title, status, metadata_json
      FROM network_projects
      WHERE id = $1
      LIMIT 1
    `,
    [projectId]
  );
  const project = existing.rows[0];
  if (!project) throw new Error("board_manager_restore_project_not_found");
  if (projectHasOperatorArchiveLock(project)) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_restore_project_operator_locked",
      projectId,
      title: project.title,
      status: project.status,
    };
  }
  if (project.status !== "archived") {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_restore_project_not_archived",
      projectId,
      title: project.title,
      status: project.status,
    };
  }

  const result = await query(
    `
      UPDATE network_projects
      SET status = 'active',
          metadata_json = (COALESCE(metadata_json, '{}'::jsonb) - 'agent_archived') || $2::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING id, title, status
    `,
    [
      projectId,
      jsonValue({
        agent_archive_restored: true,
        agent_archive_restored_reason: restoreReason,
        agent_archive_restored_by: "board_manager",
        agent_archive_restored_run_id: safeText(runId, 180),
        agent_archive_restored_source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
        agent_archive_restored_at: new Date().toISOString(),
      }),
    ]
  );
  return {
    executed: true,
    projectId,
    title: result.rows[0]?.title || project.title,
    status: result.rows[0]?.status || "active",
    restoreReason,
  };
}

async function executeAssignContributor({ runId, decision, sourcePacket }) {
  const contributor = safeObject(decision.payload.contributor);
  const projectId = safeText(contributor.project_id || decision.target_id, 180);
  const walletAddress = safeText(contributor.wallet_address, 120);
  const accountId = safeText(contributor.account_id, 180);
  if (!projectId) throw new Error("board_manager_assign_contributor_missing_project");
  if (!walletAddress) throw new Error("board_manager_assign_contributor_missing_wallet");
  const exists = await query("SELECT id FROM network_projects WHERE id = $1 AND status <> 'archived'", [projectId]);
  if (!exists.rows[0]) throw new Error("board_manager_assign_contributor_project_not_found");
  const candidates = sourceContributorCandidates(sourcePacket);
  const sourceCandidate = candidates.find((candidate) => (
    candidate.walletAddress === walletAddress &&
    (!accountId || !candidate.accountId || candidate.accountId === accountId)
  ));
  if (!sourceCandidate) {
    throw new Error("board_manager_assign_contributor_not_in_source_packet");
  }
  const result = await query(
    `
      INSERT INTO network_project_contributors (
        project_id,
        wallet_address,
        codename,
        archetype,
        allotted,
        cap,
        load,
        status,
        role_label,
        sort_order,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      ON CONFLICT (project_id, wallet_address) DO UPDATE SET
        codename = EXCLUDED.codename,
        archetype = EXCLUDED.archetype,
        allotted = EXCLUDED.allotted,
        cap = EXCLUDED.cap,
        load = EXCLUDED.load,
        status = EXCLUDED.status,
        role_label = EXCLUDED.role_label,
        sort_order = EXCLUDED.sort_order,
        metadata_json = network_project_contributors.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING project_id, wallet_address, status
    `,
    [
      projectId,
      walletAddress,
      safeText(contributor.codename, 120) || sourceCandidate.displayName || accountId || "Operator",
      safeText(contributor.archetype, 180),
      Boolean(contributor.allotted),
      intValue(contributor.cap),
      intValue(contributor.load),
      safeText(contributor.status, 80) || "active",
      safeText(contributor.role_label, 80),
      intValue(contributor.sort_order, 100),
      jsonValue({
        account_id: accountId || sourceCandidate.accountId,
        board_manager_run_id: safeText(runId, 180),
        board_manager_reason: decision.reason,
        source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
      }),
    ]
  );
  return {
    executed: true,
    projectId: result.rows[0]?.project_id || projectId,
    walletAddress: result.rows[0]?.wallet_address || walletAddress,
    status: result.rows[0]?.status || "active",
  };
}

async function executeRefreshProjectDocument({ runId, decision, sourcePacket }) {
  const projectId = safeText(decision.target_id || decision.payload.project?.id, 180);
  if (!projectId) throw new Error("board_manager_refresh_project_document_missing_project");
  const exists = await query("SELECT id FROM network_projects WHERE id = $1 AND status <> 'archived'", [projectId]);
  if (!exists.rows[0]) throw new Error("board_manager_refresh_project_document_project_not_found");
  const document = safeObject(decision.payload.project_document);
  if (!safeText(document.project_status || document.projectStatus, 1800)) {
    throw new Error("board_manager_refresh_project_document_missing_project_status");
  }
  const source = await buildHiveProjectProductDocSourcePacket({
    projectId,
    boardSourcePacket: sourcePacket,
  });
  const run = runId
    ? await query("SELECT model, reasoning_effort FROM board_manager_runs WHERE id = $1 LIMIT 1", [runId])
    : { rows: [] };
  const completed = await completeHiveProjectProductDoc({
    projectId,
    output: document,
    sourcePacket: source,
    boardManagerRunId: runId,
    provider: "codex_exec",
    model: safeText(run.rows[0]?.model || "board_manager", 160),
    promptVersion: boardManagerPromptVersion,
    usage: {
      source: "board_manager_decision",
      reasoningEffort: safeText(run.rows[0]?.reasoning_effort, 40),
    },
  });
  return {
    executed: true,
    projectId,
    productDocId: completed.doc?.id || "",
    sourcePacketDigest: source.sourcePacketDigest,
    title: completed.doc?.title || "",
    model: completed.doc?.model || "",
    promptVersion: completed.doc?.promptVersion || boardManagerPromptVersion,
  };
}

async function executeInitiateNetworkTask({ runId, decision, sourcePacket }) {
  const networkTask = safeObject(decision.payload?.network_task || decision.payload?.networkTask);
  const candidateAccountId = safeText(networkTask.candidate_account_id || networkTask.candidateAccountId, 180);
  const candidateWalletAddress = safeText(networkTask.candidate_wallet_address || networkTask.candidateWalletAddress, 120);
  if (candidateAccountId || candidateWalletAddress) {
    const accountLiveState = await buildHiveAccountLiveState({
      accountId: candidateAccountId,
      walletAddress: candidateWalletAddress,
      limit: 8,
    });
    const reservationMinPft = numberValue(accountLiveState.routingConstraints?.reservationRate?.minPft, 0);
    const rewardMaxPft = numberValue(networkTask.reward_max_pft || networkTask.rewardMaxPft, 0);
    if (accountLiveState.ok && reservationMinPft > 0 && rewardMaxPft > 0 && rewardMaxPft < reservationMinPft) {
      return {
        executed: false,
        skipped: true,
        reason: "board_manager_network_task_below_reservation_rate",
        candidateAccountId,
        candidateWalletAddress,
        reservationMinPft,
        rewardMaxPft,
        accountLiveStateDigest: safeText(accountLiveState.digest, 120),
      };
    }
  }
  let enqueued;
  try {
    enqueued = await enqueueNetworkTaskGenerationFromBoardDecision({
      runId,
      decision,
      sourcePacket,
    });
  } catch (error) {
    if (error?.message === "network_task_candidate_at_capacity") {
      return {
        executed: false,
        skipped: true,
        reason: "network_task_candidate_at_capacity",
      };
    }
    throw error;
  }
  const scheduled = scheduleNetworkTaskGenerationQueue({
    delayMs: 250,
    limit: 2,
    reason: "board_manager_initiate_network_task",
  });
  return {
    ...enqueued,
    workerScheduled: scheduled,
  };
}

async function executeCancelNetworkTask({ runId, decision, sourcePacket }) {
  const cancelTarget = safeObject(decision.payload?.cancel_target);
  const taskId = safeText(
    cancelTarget.task_id || cancelTarget.taskId || decision.target_id,
    180
  );
  if (!taskId) throw new Error("board_manager_cancel_network_task_missing_task_id");
  const cancelReason = safeText(cancelTarget.reason || decision.reason, 1000);
  const referencedTaskIds = safeArray(cancelTarget.referenced_task_ids || cancelTarget.referencedTaskIds)
    .map((item) => safeText(item, 180))
    .filter(Boolean)
    .slice(0, 12);

  // Only the Board Manager issues Network Tasks, so it may retract its own
  // proposed/accepted offers. Confirm the target is a cancellable NETWORK task
  // before mutating anything; personal/engineering tasks are never touched.
  const existing = await query(
    `
      SELECT tp.task_id, tp.status, tp.title, tp.reward_actual_pft,
             (refs.task_id IS NOT NULL) AS is_network_task
      FROM task_projections tp
      LEFT JOIN network_project_task_refs refs
        ON refs.task_id = tp.task_id AND refs.source = 'network_task_generation'
      WHERE tp.task_id = $1
      LIMIT 1
    `,
    [taskId]
  );
  const task = existing.rows[0];
  if (!task) {
    return { executed: false, skipped: true, reason: "board_manager_cancel_task_not_found", taskId };
  }
  if (!task.is_network_task) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_cancel_task_not_network",
      taskId,
      status: task.status,
    };
  }
  const status = String(task.status || "").toLowerCase();
  // proposed/accepted only: pre-submission. Anything past acceptance may already
  // hold delivered work; canceling there is an economic decision for the operator.
  if (!["proposed", "accepted"].includes(status)) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_cancel_task_not_cancellable_state",
      taskId,
      status,
    };
  }
  // Defense-in-depth on reward integrity: never terminalize anything that
  // already paid. Unreachable given the status guard, but reward safety never
  // depends on a single check.
  if (status === "rewarded" || Number(task.reward_actual_pft || 0) > 0) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_cancel_task_already_rewarded",
      taskId,
      status,
    };
  }

  // proposed -> refused, accepted -> cancelled (matches shared/task-lifecycle.js
  // stop transitions). Race-safe: the WHERE only mutates rows still in a
  // cancellable state, so a concurrent transition cannot be clobbered.
  const transition = status === "proposed" ? "refused" : "cancelled";
  const audit = {
    agent_cancelled: true,
    agent_cancelled_by: "board_manager",
    agent_cancelled_reason: cancelReason,
    agent_cancelled_run_id: safeText(runId, 180),
    agent_cancelled_source_packet_digest: safeText(sourcePacket?.sourcePacketDigest, 120),
    agent_cancelled_transition: transition,
    agent_cancelled_referenced_task_ids: referencedTaskIds,
    agent_cancelled_at: new Date().toISOString(),
  };
  const updated = await query(
    `
      UPDATE task_projections
      SET status = $2,
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
      WHERE task_id = $1
        AND status = ANY($4::text[])
      RETURNING task_id, status
    `,
    [taskId, transition, jsonValue(audit), ["proposed", "accepted"]]
  );
  if (!updated.rows[0]) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_cancel_task_state_changed",
      taskId,
      status,
    };
  }

  // Propagate the terminal status to the network-task mirror tables
  // (network_project_task_refs / network_task_allocations / intents / project
  // counts / followups) so they do not lag behind the projection. The projection
  // terminal write above is the reward-safety boundary; this sync is consistency
  // only. Best-effort: a failure leaves mirrors stale until the next batch sync
  // and does not undo the cancel.
  let mirrorSync = { ok: true, skipped: true, reason: "not_invoked" };
  try {
    mirrorSync = await syncNetworkTaskProjection({ taskId });
  } catch (error) {
    mirrorSync = { ok: false, error: safeText(error?.message || error, 500) };
  }

  // Capacity is released automatically: listNetworkTaskCapacityBlockers excludes
  // tasks whose task_projections.status is terminal, so this cancelled/refused
  // task no longer blocks the candidate. The agent_cancelled metadata marker,
  // together with the reducer persist-time guard in repositories/tasks.js,
  // prevents the PFTL cache reducer from reviving this task on ANY later
  // re-derivation (a lagging contributor pointer or even a stale reward pointer),
  // so it can never reach the reward queue and can never be marked rewarded.
  return {
    executed: true,
    taskId,
    status: updated.rows[0].status,
    transition,
    cancelReason,
    referencedTaskIds,
    mirrorSync,
  };
}

export async function executeBoardManagerDecision({
  runId = "",
  decision = {},
  sourcePacket = {},
  dryRun = true,
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedDecision = normalizeBoardManagerDecision(decision);
  if (dryRun) {
    const result = { executed: false, dryRun: true, action: normalizedDecision.action };
    await recordResult({ runId, decision: normalizedDecision, result });
    return { ok: true, result };
  }

  let result;
  try {
    switch (normalizedDecision.action) {
      case "do_nothing":
        result = { executed: true, action: "do_nothing" };
        break;
      case "message_user":
        result = await executeMessageUser({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "refresh_hive_secretary":
        result = await executeRefreshHiveSecretary({ decision: normalizedDecision });
        break;
      case "create_project":
        result = await executeCreateProject({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "archive_project":
        result = await executeArchiveProject({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "restore_project":
        result = await executeRestoreProject({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "assign_contributor":
        result = await executeAssignContributor({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "refresh_project_document":
        result = await executeRefreshProjectDocument({
          runId,
          decision: normalizedDecision,
          sourcePacket,
        });
        break;
      case "initiate_network_task":
        result = await executeInitiateNetworkTask({
          runId,
          decision: normalizedDecision,
          sourcePacket,
        });
        break;
      case "cancel_network_task":
        result = await executeCancelNetworkTask({
          runId,
          decision: normalizedDecision,
          sourcePacket,
        });
        break;
      default:
        throw new Error(`board_manager_action_not_implemented:${normalizedDecision.action}`);
    }
  } catch (error) {
    const failure = {
      executed: false,
      error: error?.message || String(error),
      action: normalizedDecision.action,
    };
    await recordResult({ runId, decision: normalizedDecision, result: failure }).catch(() => null);
    throw error;
  }
  await recordResult({ runId, decision: normalizedDecision, result });
  return { ok: true, result };
}
