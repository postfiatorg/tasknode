import {
  normalizeTaskStatus,
  TASK_STATUS,
  taskIsTerminal,
  taskLifecycleActions,
  taskRequiresRefresh,
  taskStatusColor,
  taskStatusInfo,
  taskStatusLabel,
  taskStatusTab,
} from "../../../shared/task-lifecycle.js";
import {
  pruneTaskActionReceipts,
} from "./task-action-receipts.js";
import {
  shouldForceTaskSyncNotice,
  taskRefreshPolicy,
} from "./task-refresh-policy.js";

const TASK_STATUS_PROGRESS = Object.freeze({
  [TASK_STATUS.unknown]: 0,
  [TASK_STATUS.proposed]: 10,
  [TASK_STATUS.accepted]: 20,
  [TASK_STATUS.submitted]: 30,
  [TASK_STATUS.verificationRequested]: 40,
  [TASK_STATUS.verificationResponseSubmitted]: 50,
  [TASK_STATUS.rewardDecided]: 60,
  [TASK_STATUS.rewarded]: 70,
  [TASK_STATUS.refused]: 70,
  [TASK_STATUS.rejected]: 70,
  [TASK_STATUS.cancelled]: 70,
  [TASK_STATUS.expired]: 70,
});

export function taskArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function requestAgeMs(request = {}, nowMs = Date.now()) {
  const timestamp = Date.parse(request.updatedAt || request.createdAt || "");
  return Number.isFinite(timestamp) ? Number(nowMs || Date.now()) - timestamp : Number.POSITIVE_INFINITY;
}

export function activeTaskRequests(requests = [], { nowMs = Date.now() } = {}) {
  return taskArray(requests).filter((request) => {
    if (request?.generatedTaskId || request?.isTerminal === true) return false;
    if (request?.isActive === true) return true;
    if (request?.isActive === false) return false;
    const status = safeText(request?.status, 80).toLowerCase();
    if (!status || status === "proposed" || status === "cancelled") return false;
    if (request?.generatedTaskId) return false;
    if (status === "failed") return requestAgeMs(request, nowMs) < 24 * 60 * 60 * 1000;
    if (["signing", "queued", "generating"].includes(status)) return true;
    if (status === "published") return requestAgeMs(request, nowMs) < 20 * 60 * 1000 && !request.generatedTaskId;
    return false;
  });
}

export function processingTaskRequests(requests = [], { nowMs = Date.now() } = {}) {
  return activeTaskRequests(requests, { nowMs }).filter((request) => {
    if (request?.isProcessing === true) return true;
    if (request?.isProcessing === false) return false;
    const status = safeText(request?.status, 80).toLowerCase();
    if (["signing", "queued", "generating"].includes(status)) return true;
    return status === "published" && requestAgeMs(request, nowMs) < 20 * 60 * 1000 && !request.generatedTaskId;
  });
}

export function attentionTaskRequests(requests = [], { nowMs = Date.now() } = {}) {
  return activeTaskRequests(requests, { nowMs }).filter((request) => {
    if (request?.needsAttention === true) return true;
    if (request?.needsAttention === false) return false;
    return safeText(request?.status, 80).toLowerCase() === "failed" &&
      requestAgeMs(request, nowMs) < 24 * 60 * 60 * 1000 &&
      !request.generatedTaskId;
  });
}

export function taskRequestArray(tasks = {}) {
  return Array.isArray(tasks?.requests?.items) ? tasks.requests.items : [];
}

export function allTaskBuckets(tasks = {}) {
  return [
    ...taskArray(tasks.outstanding),
    ...taskArray(tasks.verification),
    ...taskArray(tasks.refused),
    ...taskArray(tasks.rewarded),
  ];
}

export function findTaskById(tasks = {}, taskId = "") {
  const normalized = safeText(taskId, 180);
  if (!normalized) return null;
  return allTaskBuckets(tasks).find((task) =>
    [task.taskId, task.fullId, task.id].some((value) => String(value || "") === normalized)
  ) || null;
}

export function taskStatusProgress(status = "") {
  return TASK_STATUS_PROGRESS[normalizeTaskStatus(status)] ?? TASK_STATUS_PROGRESS[TASK_STATUS.unknown];
}

function taskId(task = {}) {
  return safeText(task.taskId || task.fullId || task.id, 180);
}

function receiptTaskId(receipt = {}) {
  return safeText(receipt.taskId || receipt.fullId || receipt.id, 180);
}

function receiptAppliesToTask(receipt = {}, task = {}, { accountId = "", walletAddress = "" } = {}) {
  if (!receiptTaskId(receipt) || receiptTaskId(receipt) !== taskId(task)) return false;
  if (receipt.accountId && accountId && receipt.accountId !== accountId) return false;
  if (receipt.walletAddress && walletAddress && receipt.walletAddress !== walletAddress) return false;
  return true;
}

function uniqueTaskIds(values = []) {
  return [...new Set(taskArray(values).map((value) => safeText(value, 180)).filter(Boolean))];
}

function relativeAge(value, nowMs = Date.now()) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Number(nowMs || Date.now()) - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function visibleTaskStateFromTask(task = {}) {
  const statusKey = normalizeTaskStatus(task?.statusKey || task?.status);
  if (statusKey === TASK_STATUS.unknown) return null;
  return {
    status: safeText(task?.status, 120) || taskStatusLabel(statusKey),
    statusKey,
    txHash: safeText(task?.txHash || task?.metadata?.optimisticLastTxHash, 180),
    clientActionPending: Boolean(task?.clientActionPending),
    clientSyncLabel: safeText(task?.clientSyncLabel, 80),
    clientSyncDetail: safeText(task?.clientSyncDetail, 240),
    pendingActionReceipt: task?.metadata?.pendingActionReceipt || null,
  };
}

export function visibleTaskStateFromActionReceipt(receipt = {}) {
  const statusKey = normalizeTaskStatus(receipt?.expectedStatusKey || receipt?.statusKey);
  if (statusKey === TASK_STATUS.unknown) return null;
  const hasClientSyncLabel = Object.prototype.hasOwnProperty.call(receipt, "clientSyncLabel");
  const hasClientSyncDetail = Object.prototype.hasOwnProperty.call(receipt, "clientSyncDetail");
  const clientActionPending = receipt?.clientActionPending === false ? false : true;
  return {
    status: safeText(receipt?.expectedStatus || receipt?.status, 120) || taskStatusLabel(statusKey),
    statusKey,
    txHash: safeText(receipt?.txHash, 180),
    clientActionPending,
    clientSyncLabel: hasClientSyncLabel ? safeText(receipt?.clientSyncLabel, 80) : "syncing",
    clientSyncDetail: hasClientSyncDetail
      ? safeText(receipt?.clientSyncDetail, 240)
      : statusKey === TASK_STATUS.submitted
        ? "Evidence was submitted. Task state is updating."
        : "Task action was signed. Task state is updating.",
    pendingActionReceipt: {
      actionType: safeText(receipt?.actionType, 80),
      expectedStatusKey: statusKey,
      txHash: safeText(receipt?.txHash, 180),
      createdAt: safeText(receipt?.createdAt, 80),
    },
  };
}

export function shouldApplyVisibleTaskState(task = {}, visibleState = {}) {
  if (!visibleState?.statusKey) return false;
  const currentStatus = normalizeTaskStatus(task.statusKey || task.status);
  const nextStatus = normalizeTaskStatus(visibleState.statusKey);
  if (taskIsTerminal(currentStatus)) return false;
  return taskStatusProgress(currentStatus) < taskStatusProgress(nextStatus);
}

export function overlayTaskWithVisibleState(task = {}, visibleState = {}, { nowMs = Date.now() } = {}) {
  if (!shouldApplyVisibleTaskState(task, visibleState)) return task;
  const statusKey = normalizeTaskStatus(visibleState.statusKey);
  const info = taskStatusInfo(statusKey);
  const hasClientSyncLabel = Object.prototype.hasOwnProperty.call(visibleState, "clientSyncLabel");
  const hasClientSyncDetail = Object.prototype.hasOwnProperty.call(visibleState, "clientSyncDetail");
  return {
    ...task,
    status: taskStatusLabel(statusKey),
    statusKey,
    statusTone: info.tone,
    statusColor: taskStatusColor(statusKey),
    statusTab: taskStatusTab(statusKey),
    lifecycle: info,
    ago: relativeAge(visibleState.pendingActionReceipt?.createdAt, nowMs) || task.ago,
    updatedAt: visibleState.pendingActionReceipt?.createdAt || task.updatedAt,
    txHash: visibleState.txHash || task.txHash,
    clientActionPending: Boolean(visibleState.clientActionPending),
    clientSyncLabel: hasClientSyncLabel ? visibleState.clientSyncLabel : "syncing",
    clientSyncDetail: hasClientSyncDetail ? visibleState.clientSyncDetail : "Task action was signed. Task state is updating.",
    metadata: {
      ...(task.metadata || {}),
      optimisticLastTxHash: visibleState.txHash || "",
      pendingActionReceipt: visibleState.pendingActionReceipt,
    },
  };
}

export function shouldRetainVisibleTaskDetailState(detail = null, visibleState = null) {
  if (!visibleState?.statusKey) return false;
  const incomingTask = detail?.task;
  if (!incomingTask) return false;

  const incomingStatus = normalizeTaskStatus(incomingTask.statusKey || incomingTask.status);
  if (taskIsTerminal(incomingStatus)) return false;

  return taskStatusProgress(incomingStatus) < taskStatusProgress(visibleState.statusKey);
}

export function overlayTaskDetailWithVisibleState(detail = null, visibleState = null) {
  if (!detail?.task || !shouldRetainVisibleTaskDetailState(detail, visibleState)) return detail;
  const statusKey = normalizeTaskStatus(visibleState.statusKey);
  const statusInfo = taskStatusInfo(statusKey);
  const hasClientSyncLabel = Object.prototype.hasOwnProperty.call(visibleState, "clientSyncLabel");
  const hasClientSyncDetail = Object.prototype.hasOwnProperty.call(visibleState, "clientSyncDetail");

  return {
    ...detail,
    task: {
      ...detail.task,
      status: visibleState.status || taskStatusLabel(statusKey),
      statusKey,
      statusTone: statusInfo.tone,
      statusColor: taskStatusColor(statusKey),
      statusTab: statusInfo.tab,
      lifecycle: statusInfo,
      txHash: visibleState.txHash || detail.task.txHash,
      clientActionPending: Boolean(visibleState.clientActionPending || detail.task.clientActionPending),
      clientSyncLabel: hasClientSyncLabel ? visibleState.clientSyncLabel : detail.task.clientSyncLabel,
      clientSyncDetail: hasClientSyncDetail ? visibleState.clientSyncDetail : detail.task.clientSyncDetail,
      metadata: {
        ...(detail.task.metadata || {}),
        optimisticLastTxHash: visibleState.txHash || detail.task.metadata?.optimisticLastTxHash || "",
        pendingActionReceipt: visibleState.pendingActionReceipt || detail.task.metadata?.pendingActionReceipt,
      },
    },
    actions: taskLifecycleActions(statusKey),
  };
}

export function groupTasksByVisibleStatus(tasks = []) {
  const grouped = { outstanding: [], verification: [], refused: [], rewarded: [] };
  for (const task of taskArray(tasks)) {
    const tab = taskStatusTab(task.statusKey || task.status);
    if (tab === "verification") grouped.verification.push(task);
    else if (tab === "refused") grouped.refused.push(task);
    else if (tab === "rewarded") grouped.rewarded.push(task);
    else grouped.outstanding.push(task);
  }
  return grouped;
}

export function mergeTaskStateWithActionReceipts(tasks = {}, receipts = [], {
  accountId = "",
  walletAddress = "",
  nowMs = Date.now(),
} = {}) {
  const activeReceipts = pruneTaskActionReceipts(receipts, nowMs);
  const buildSync = (mergedTasks = []) => {
    const optimisticSyncTaskIds = mergedTasks
      .filter((task) => task?.clientActionPending)
      .map((task) => task.taskId || task.fullId || task.id || "")
      .filter(Boolean);
    const lifecycleRefreshTaskIds = mergedTasks
      .filter((task) => taskRequiresRefresh(task?.statusKey || task?.status))
      .map((task) => task.taskId || task.fullId || task.id || "")
      .filter(Boolean);
    const hasOptimisticSync = optimisticSyncTaskIds.length > 0;
    const hasLifecycleRefresh = lifecycleRefreshTaskIds.length > 0;
    const shouldRefresh = Boolean(tasks?.sync?.requiresRefresh || hasOptimisticSync || hasLifecycleRefresh);
    const refreshReason = hasOptimisticSync
      ? "task_action_receipt_pending"
      : hasLifecycleRefresh && !tasks?.sync?.refreshReason
        ? "task_review_active"
        : tasks?.sync?.refreshReason;
    const serverNextPollMs = Number(tasks?.sync?.nextPollMs || 0);
    // Only a pending optimistic receipt may clamp polling down to the fast
    // 2.5s tier. Otherwise the server-suggested cadence is respected so the
    // slow 10s tier (and database-error backoff) stays reachable.
    const nextPollMs = !shouldRefresh
      ? tasks?.sync?.nextPollMs
      : hasOptimisticSync
        ? Math.min(Math.max(serverNextPollMs || 2500, 1000), 2500)
        : Math.min(Math.max(serverNextPollMs || (hasLifecycleRefresh ? 2500 : 10000), 1000), 30000);

    return {
      ...(tasks?.sync || {}),
      activeReceiptCount: activeReceipts.length,
      optimisticSyncTaskIds,
      refreshTaskIds: uniqueTaskIds([
        ...(taskArray(tasks?.sync?.refreshTaskIds)),
        ...optimisticSyncTaskIds,
        ...lifecycleRefreshTaskIds,
      ]),
      requiresRefresh: shouldRefresh,
      forceProjectionRefresh: Boolean(tasks?.sync?.forceProjectionRefresh || hasOptimisticSync),
      nextPollMs,
      refreshReason,
    };
  };

  if (!activeReceipts.length) {
    const sourceTasks = allTaskBuckets(tasks);
    return {
      ...tasks,
      sync: buildSync(sourceTasks),
    };
  }

  const sourceTasks = allTaskBuckets(tasks);
  const mergedTasks = sourceTasks.map((task) => {
    const receipt = activeReceipts.find((item) => receiptAppliesToTask(item, task, { accountId, walletAddress }));
    const visibleState = receipt ? visibleTaskStateFromActionReceipt(receipt) : null;
    return visibleState ? overlayTaskWithVisibleState(task, visibleState, { nowMs }) : task;
  });
  const grouped = groupTasksByVisibleStatus(mergedTasks);

  return {
    ...tasks,
    ...grouped,
    sync: buildSync(mergedTasks),
  };
}

export function pruneTaskActionReceiptsForTaskState(receipts = [], tasks = {}, {
  accountId = "",
  walletAddress = "",
  nowMs = Date.now(),
} = {}) {
  const sourceTasks = allTaskBuckets(tasks);

  return pruneTaskActionReceipts(receipts, nowMs).filter((receipt) => {
    const task = sourceTasks.find((item) => receiptAppliesToTask(receipt, item, { accountId, walletAddress }));
    if (!task) return true;
    const visibleState = visibleTaskStateFromActionReceipt(receipt);
    return shouldApplyVisibleTaskState(task, visibleState);
  });
}

export function needsLegacyTaskRefresh(tasks = {}) {
  // Covers review-loop states genuinely awaiting the worker (submitted,
  // verification_response_submitted, reward_decided). verification_requested
  // waits on the user's own response and stays on the slow tier; route-open
  // and focus/visibility refreshes cover cross-device cancels.
  return allTaskBuckets(tasks).some((task) => taskRequiresRefresh(task?.statusKey || task?.status));
}

export function taskSyncNoticeForStatus(sync = {}, { directOffchain = false } = {}) {
  const status = safeText(sync?.status, 80);
  const indexingLagCount = Number(sync?.indexingLagCount || 0);
  if (status === "database_error") {
    return {
      label: "Task state is reconnecting",
      body: "Task Node could not read the task projection cache. The app will keep retrying without clearing your current task view.",
    };
  }
  if (status === "integrity_unavailable") {
    return {
      label: "Task sync check is retrying",
      body: "Task rows are visible, but the projection integrity check could not finish. The app will keep refreshing task state.",
    };
  }
  if (status === "reducer_attention") {
    return {
      label: "Task sync needs attention",
      body: `Some task updates failed to process${sync.failedReducerCount ? ` (${sync.failedReducerCount} failed)` : ""}. Task rows may lag until sync recovers.`,
    };
  }
  if (!directOffchain && status === "indexing_lag" && indexingLagCount > 3) {
    return {
      label: "Task list is updating",
      body: "Several recently signed task changes are still syncing. Task rows refresh automatically.",
    };
  }
  return null;
}

export function reconcileTaskVisibleState({
  accountId = "",
  directOffchain = false,
  linkedWalletAddress = "",
  nowMs = Date.now(),
  receipts = [],
  selectedTaskId = "",
  taskReadFailureCount = 0,
  taskRequestSettleUntilMs = 0,
  tasks = {},
  tasksTab = "outstanding",
  walletAddress = "",
} = {}) {
  const wallet = linkedWalletAddress || walletAddress;
  const visibleTasks = mergeTaskStateWithActionReceipts(tasks, receipts, {
    accountId,
    walletAddress: wallet,
    nowMs,
  });
  const outstanding = taskArray(visibleTasks.outstanding);
  const verification = taskArray(visibleTasks.verification);
  const refused = taskArray(visibleTasks.refused);
  const rewarded = taskArray(visibleTasks.rewarded);
  const requests = taskRequestArray(visibleTasks);
  const activeRequests = activeTaskRequests(requests, { nowMs });
  const processingRequests = processingTaskRequests(requests, { nowMs });
  const attentionRequests = attentionTaskRequests(requests, { nowMs });
  const taskSync = visibleTasks?.sync || {};
  const handoffProjectionPending = taskSync?.handoff?.requestHandoffState === "generated_projection_pending";
  const polling = taskRefreshPolicy({
    directOffchain,
    handoffProjectionPending: Boolean(taskSync?.handoffProjectionPending || handoffProjectionPending),
    legacyRefreshNeeded: needsLegacyTaskRefresh(visibleTasks),
    nextPollMs: taskSync.nextPollMs,
    nowMs,
    // Failed requests stay in the attention strip but exert no refresh
    // pressure; only processing requests keep the fast forced-refresh loop.
    processingRequestCount: processingRequests.length,
    settleUntilMs: taskRequestSettleUntilMs,
    taskReadFailureCount,
    taskSyncForceProjection: Boolean(taskSync.forceProjectionRefresh),
    taskSyncRequiresRefresh: taskSync.requiresRefresh,
    taskSyncStatus: safeText(taskSync.status || "ready", 80),
  });
  const counts = {
    outstanding: outstanding.length,
    verification: verification.length,
    refused: refused.length,
    rewarded: rewarded.length,
  };
  const totalPftInFlight = [...outstanding, ...verification].reduce((sum, task) => sum + Number(task.pft || 0), 0);
  const tabs = [
    { key: "outstanding", label: "Outstanding", count: counts.outstanding },
    { key: "verification", label: "Verification", count: counts.verification },
    { key: "refused", label: "Refused", count: counts.refused },
    { key: "rewarded", label: "Rewarded", count: counts.rewarded },
  ];

  return {
    tasks: visibleTasks,
    outstanding,
    verification,
    refused,
    rewarded,
    requests,
    activeRequests,
    activeRequestCount: activeRequests.length,
    processingRequests,
    processingRequestCount: processingRequests.length,
    attentionRequests,
    attentionRequestCount: attentionRequests.length,
    allTasks: [...outstanding, ...verification, ...refused, ...rewarded],
    counts,
    totalPftInFlight,
    tabs,
    currentTabTasks: {
      outstanding,
      verification,
      refused,
      rewarded,
    }[tasksTab] || [],
    selectedTask: selectedTaskId ? findTaskById(visibleTasks, selectedTaskId) : null,
    sync: taskSync,
    handoff: taskSync?.handoff || null,
    taskSyncNotice: shouldForceTaskSyncNotice(taskSync, { directOffchain })
      ? taskSyncNoticeForStatus(taskSync, { directOffchain })
      : null,
    polling,
    prunedReceipts: pruneTaskActionReceiptsForTaskState(receipts, tasks, {
      accountId,
      walletAddress: wallet,
      nowMs,
    }),
  };
}
