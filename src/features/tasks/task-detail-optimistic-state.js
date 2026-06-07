import {
  normalizeTaskStatus,
  TASK_STATUS,
  taskLifecycleActions,
  taskIsTerminal,
  taskStatusColor,
  taskStatusInfo,
  taskStatusLabel,
} from "../../../shared/task-lifecycle.js";

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

function statusProgress(status = "") {
  return TASK_STATUS_PROGRESS[normalizeTaskStatus(status)] ?? TASK_STATUS_PROGRESS[TASK_STATUS.unknown];
}

export function optimisticEvidenceStateFromSubmission(result = {}) {
  const schema = String(result?.submissionPayload?.schema || "");
  const verificationResponse = schema === "pf.task.verification_response.v1";
  return {
    schema,
    status: verificationResponse ? "Awaiting review" : "Submitted",
    statusKey: verificationResponse
      ? TASK_STATUS.verificationResponseSubmitted
      : TASK_STATUS.submitted,
    txHash: String(result?.txHash || "").trim(),
  };
}

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

export function optimisticTaskStateFromTask(task = {}) {
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

export function optimisticTaskStateFromActionReceipt(receipt = {}) {
  const statusKey = normalizeTaskStatus(receipt?.expectedStatusKey || receipt?.statusKey);
  if (statusKey === TASK_STATUS.unknown) return null;
  return {
    status: safeText(receipt?.expectedStatus || receipt?.status, 120) || taskStatusLabel(statusKey),
    statusKey,
    txHash: safeText(receipt?.txHash, 180),
    clientActionPending: true,
    clientSyncLabel: "syncing",
    clientSyncDetail:
      statusKey === TASK_STATUS.submitted
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

export function shouldRetainOptimisticEvidenceState(detail = null, optimistic = null) {
  if (!optimistic?.statusKey) return false;
  const incomingTask = detail?.task;
  if (!incomingTask) return true;

  const incomingStatus = normalizeTaskStatus(incomingTask.statusKey || incomingTask.status);
  if (taskIsTerminal(incomingStatus)) return false;

  return statusProgress(incomingStatus) < statusProgress(optimistic.statusKey);
}

export function shouldRetainOptimisticTaskState(detail = null, optimistic = null) {
  if (!optimistic?.statusKey) return false;
  const incomingTask = detail?.task;
  if (!incomingTask) return false;

  const incomingStatus = normalizeTaskStatus(incomingTask.statusKey || incomingTask.status);
  if (taskIsTerminal(incomingStatus)) return false;

  return statusProgress(incomingStatus) < statusProgress(optimistic.statusKey);
}

export function overlayTaskDetailWithOptimisticTaskState(detail = null, optimistic = null) {
  if (!detail?.task || !shouldRetainOptimisticTaskState(detail, optimistic)) return detail;
  const statusKey = normalizeTaskStatus(optimistic.statusKey);
  const statusInfo = taskStatusInfo(statusKey);

  return {
    ...detail,
    task: {
      ...detail.task,
      status: optimistic.status || taskStatusLabel(statusKey),
      statusKey,
      statusTone: statusInfo.tone,
      statusColor: taskStatusColor(statusKey),
      statusTab: statusInfo.tab,
      lifecycle: statusInfo,
      txHash: optimistic.txHash || detail.task.txHash,
      clientActionPending: optimistic.clientActionPending || detail.task.clientActionPending,
      clientSyncLabel: optimistic.clientSyncLabel || detail.task.clientSyncLabel,
      clientSyncDetail: optimistic.clientSyncDetail || detail.task.clientSyncDetail,
      metadata: {
        ...(detail.task.metadata || {}),
        optimisticLastTxHash: optimistic.txHash || detail.task.metadata?.optimisticLastTxHash || "",
        pendingActionReceipt: optimistic.pendingActionReceipt || detail.task.metadata?.pendingActionReceipt,
      },
    },
    actions: taskLifecycleActions(statusKey),
  };
}

export function overlayTaskDetailWithOptimisticEvidence(detail = null, optimistic = null) {
  if (!detail?.task || !shouldRetainOptimisticEvidenceState(detail, optimistic)) return detail;

  return {
    ...detail,
    task: {
      ...detail.task,
      status: optimistic.status,
      statusKey: optimistic.statusKey,
      metadata: {
        ...(detail.task.metadata || {}),
        optimisticLastTxHash: optimistic.txHash || "",
      },
    },
    actions: {
      ...(detail.actions || {}),
      browserSubmissionEnabled: false,
      canSubmitInitialEvidence: false,
      canSubmitVerificationEvidence: false,
    },
  };
}
