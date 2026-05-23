export const TASK_STATUS = Object.freeze({
  accepted: "accepted",
  cancelled: "cancelled",
  expired: "expired",
  proposed: "proposed",
  refused: "refused",
  rejected: "rejected",
  rewardDecided: "reward_decided",
  rewarded: "rewarded",
  submitted: "submitted",
  unknown: "unknown",
  verificationRequested: "verification_requested",
  verificationResponseSubmitted: "verification_response_submitted",
});

export const TASK_TABS = Object.freeze({
  outstanding: "outstanding",
  refused: "refused",
  rewarded: "rewarded",
  verification: "verification",
});

const taskStatusDefinitions = Object.freeze({
  [TASK_STATUS.proposed]: {
    label: "Proposed",
    tab: TASK_TABS.outstanding,
    tone: "pending",
    color: "#7a5a1f",
    canAccept: true,
    canRefuse: true,
    canStop: true,
    stopAction: "refuse",
    stopLabel: "Refuse task",
    stopTransition: "refused",
  },
  [TASK_STATUS.accepted]: {
    label: "Accepted",
    tab: TASK_TABS.outstanding,
    tone: "active",
    color: "#4a5934",
    canCancel: true,
    canStop: true,
    canSubmitInitialEvidence: true,
    stopAction: "cancel",
    stopLabel: "Cancel task",
    stopTransition: "cancelled",
  },
  [TASK_STATUS.submitted]: {
    label: "Submitted",
    tab: TASK_TABS.outstanding,
    tone: "review",
    color: "#4a5934",
    canCancel: true,
    canStop: true,
    requiresRefresh: true,
    reviewLoop: true,
    stopAction: "cancel",
    stopLabel: "Cancel task",
    stopTransition: "cancelled",
  },
  [TASK_STATUS.verificationRequested]: {
    label: "Verification requested",
    tab: TASK_TABS.verification,
    tone: "review",
    color: "#5b4b8a",
    canCancel: true,
    canStop: true,
    canSubmitVerificationEvidence: true,
    requiresRefresh: true,
    reviewLoop: true,
    stopAction: "cancel",
    stopLabel: "Cancel task",
    stopTransition: "cancelled",
  },
  [TASK_STATUS.verificationResponseSubmitted]: {
    label: "Awaiting review",
    tab: TASK_TABS.verification,
    tone: "review",
    color: "#5b4b8a",
    canCancel: true,
    canStop: true,
    requiresRefresh: true,
    reviewLoop: true,
    stopAction: "cancel",
    stopLabel: "Cancel task",
    stopTransition: "cancelled",
  },
  [TASK_STATUS.rewardDecided]: {
    label: "Reward decided",
    tab: TASK_TABS.rewarded,
    tone: "rewarded",
    color: "#6e5223",
    requiresRefresh: true,
    reviewLoop: true,
  },
  [TASK_STATUS.rewarded]: {
    label: "Rewarded",
    tab: TASK_TABS.rewarded,
    tone: "rewarded",
    color: "#6e5223",
    terminal: true,
  },
  [TASK_STATUS.refused]: {
    label: "Refused",
    tab: TASK_TABS.refused,
    tone: "stopped",
    color: "#7c3c2e",
    terminal: true,
  },
  [TASK_STATUS.rejected]: {
    label: "Rejected",
    tab: TASK_TABS.refused,
    tone: "stopped",
    color: "#7c3c2e",
    terminal: true,
  },
  [TASK_STATUS.expired]: {
    label: "Expired",
    tab: TASK_TABS.refused,
    tone: "stopped",
    color: "#7c3c2e",
    terminal: true,
  },
  [TASK_STATUS.cancelled]: {
    label: "Cancelled",
    tab: TASK_TABS.refused,
    tone: "stopped",
    color: "#7c3c2e",
    terminal: true,
  },
  [TASK_STATUS.unknown]: {
    label: "Unknown",
    tab: TASK_TABS.outstanding,
    tone: "unknown",
    color: "#3d3d38",
  },
});

export function normalizeTaskStatus(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  return taskStatusDefinitions[normalized] ? normalized : TASK_STATUS.unknown;
}

export function taskStatusInfo(status = "") {
  const statusKey = normalizeTaskStatus(status);
  return {
    key: statusKey,
    ...taskStatusDefinitions[statusKey],
  };
}

export function taskStatusLabel(status = "") {
  return taskStatusInfo(status).label;
}

export function taskStatusTab(status = "") {
  return taskStatusInfo(status).tab;
}

export function taskStatusTone(status = "") {
  return taskStatusInfo(status).tone;
}

export function taskStatusColor(status = "") {
  return taskStatusInfo(status).color;
}

export function taskIsTerminal(status = "") {
  return Boolean(taskStatusInfo(status).terminal);
}

export function taskRequiresRefresh(status = "") {
  return Boolean(taskStatusInfo(status).requiresRefresh);
}

export function taskIsReviewLoop(status = "") {
  return Boolean(taskStatusInfo(status).reviewLoop);
}

export function parseRewardPftAmount(value = "") {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function statusFromRewardAmount(rewardPft = "") {
  return parseRewardPftAmount(rewardPft) > 0 ? TASK_STATUS.rewardDecided : TASK_STATUS.rewarded;
}

export function taskLifecycleActions(status = "") {
  const info = taskStatusInfo(status);
  const canSubmitInitialEvidence = Boolean(info.canSubmitInitialEvidence);
  const canSubmitVerificationEvidence = Boolean(info.canSubmitVerificationEvidence);

  return {
    canAccept: Boolean(info.canAccept),
    canRefuse: Boolean(info.canRefuse),
    canCancel: Boolean(info.canCancel),
    canStop: Boolean(info.canStop),
    stopAction: info.stopAction || "",
    stopLabel: info.stopLabel || "",
    stopTransition: info.stopTransition || "",
    canSubmitInitialEvidence,
    canSubmitVerificationEvidence,
    browserSubmissionEnabled: canSubmitInitialEvidence || canSubmitVerificationEvidence,
    browserTaskUpdateEnabled: true,
    submissionReason:
      "Evidence is encrypted locally, pinned to IPFS, and published as a signed PFTL task pointer.",
  };
}

export function canApplyTaskStopAction(status = "", action = "") {
  const actions = taskLifecycleActions(status);
  const normalizedAction = String(action || actions.stopAction || "").trim().toLowerCase();
  if (!actions.canStop) return false;
  if (normalizedAction === "accept") return actions.canAccept;
  if (normalizedAction === "cancel") return actions.canCancel;
  if (normalizedAction === "refuse") return actions.canRefuse;
  return false;
}

export function taskRefreshMetadata({ tasks = [], activeRequestCount = 0 } = {}) {
  const refreshTasks = tasks
    .filter((task) => taskRequiresRefresh(task?.statusKey || task?.status))
    .map((task) => task?.taskId || task?.fullId || task?.id || "")
    .filter(Boolean);
  const activeTasks = tasks
    .filter((task) => {
      const status = normalizeTaskStatus(task?.statusKey || task?.status);
      return [
        TASK_STATUS.accepted,
        TASK_STATUS.submitted,
        TASK_STATUS.verificationRequested,
        TASK_STATUS.verificationResponseSubmitted,
        TASK_STATUS.rewardDecided,
      ].includes(status);
    })
    .map((task) => task?.taskId || task?.fullId || task?.id || "")
    .filter(Boolean);
  const requestCount = Number(activeRequestCount || 0);
  const refreshTaskIds = [...new Set([...refreshTasks, ...activeTasks])];
  const requiresRefresh = requestCount > 0 || refreshTaskIds.length > 0;

  return {
    requiresRefresh,
    nextPollMs: requiresRefresh ? (requestCount > 0 || refreshTasks.length > 0 ? 2500 : 10000) : null,
    refreshReason: requestCount > 0
      ? "task_requests_active"
      : refreshTasks.length > 0
        ? "task_review_active"
        : activeTasks.length > 0
          ? "task_state_active"
        : "",
    activeRequestCount: requestCount,
    refreshTaskIds,
  };
}

export function statusSlug(status = "") {
  return String(status || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
