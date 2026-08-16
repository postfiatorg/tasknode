function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
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

export function normalizedBoardManagerMessagePrecondition(decision = {}) {
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
  const precondition = normalizedBoardManagerMessagePrecondition(decision);
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
  const precondition = normalizedBoardManagerMessagePrecondition(decision);
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
