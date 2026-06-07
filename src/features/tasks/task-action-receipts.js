import {
  normalizeTaskStatus,
  TASK_STATUS,
  taskIsTerminal,
  taskStatusColor,
  taskStatusInfo,
  taskStatusLabel,
  taskStatusTab,
} from "../../../shared/task-lifecycle.js";

const RECEIPT_TTL_MS = 10 * 60 * 1000;
const MAX_RECEIPTS = 40;

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

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function statusProgress(status = "") {
  return TASK_STATUS_PROGRESS[normalizeTaskStatus(status)] ?? TASK_STATUS_PROGRESS[TASK_STATUS.unknown];
}

function receiptTaskId(receipt = {}) {
  return safeText(receipt.taskId || receipt.fullId || receipt.id, 180);
}

function taskId(task = {}) {
  return safeText(task.taskId || task.fullId || task.id, 180);
}

function receiptAppliesToTask(receipt = {}, task = {}, { accountId = "", walletAddress = "" } = {}) {
  if (!receiptTaskId(receipt) || receiptTaskId(receipt) !== taskId(task)) return false;
  if (receipt.accountId && accountId && receipt.accountId !== accountId) return false;
  if (receipt.walletAddress && walletAddress && receipt.walletAddress !== walletAddress) return false;
  return true;
}

function receiptExpired(receipt = {}, nowMs = Date.now()) {
  const expiresAt = Date.parse(receipt.expiresAt || "");
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Number(nowMs || 0);
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

function nextStatusForLifecycleAction(taskAction = "") {
  const action = safeText(taskAction, 40).toLowerCase();
  if (action === "accept" || action === "accepted") return TASK_STATUS.accepted;
  if (action === "refuse" || action === "refused" || action === "reject" || action === "rejected") {
    return TASK_STATUS.refused;
  }
  if (action === "cancel" || action === "cancelled") return TASK_STATUS.cancelled;
  return TASK_STATUS.unknown;
}

export function taskActionReceiptFromEvidenceResult({
  accountId = "",
  walletAddress = "",
  result = {},
  task = {},
} = {}) {
  const taskIdValue = safeText(result?.taskId || taskId(task), 180);
  const schema = safeText(result?.submissionPayload?.schema, 120);
  const expectedStatusKey = schema === "pf.task.verification_response.v1"
    ? TASK_STATUS.verificationResponseSubmitted
    : TASK_STATUS.submitted;
  if (!taskIdValue) return null;
  const createdAt = new Date().toISOString();
  return {
    id: `receipt_${taskIdValue}_${safeText(result?.txHash, 80) || Date.now()}`,
    accountId: safeText(accountId, 180),
    walletAddress: safeText(walletAddress, 180),
    taskId: taskIdValue,
    actionType: schema === "pf.task.verification_response.v1" ? "verification_response" : "submission",
    expectedStatusKey,
    expectedStatus: taskStatusLabel(expectedStatusKey),
    txHash: safeText(result?.txHash, 180),
    cid: safeText(result?.cid, 180),
    createdAt,
    expiresAt: new Date(Date.now() + RECEIPT_TTL_MS).toISOString(),
  };
}

export function taskActionReceiptFromLifecycleResult({
  accountId = "",
  walletAddress = "",
  result = {},
  task = {},
  taskAction = "",
} = {}) {
  const taskIdValue = safeText(result?.taskId || taskId(task), 180);
  const expectedStatusKey = nextStatusForLifecycleAction(taskAction);
  if (!taskIdValue || expectedStatusKey === TASK_STATUS.unknown) return null;
  const createdAt = new Date().toISOString();
  return {
    id: `receipt_${taskIdValue}_${safeText(result?.txHash, 80) || Date.now()}`,
    accountId: safeText(accountId, 180),
    walletAddress: safeText(walletAddress, 180),
    taskId: taskIdValue,
    actionType: safeText(taskAction, 40).toLowerCase(),
    expectedStatusKey,
    expectedStatus: taskStatusLabel(expectedStatusKey),
    txHash: safeText(result?.txHash, 180),
    cid: safeText(result?.cid, 180),
    createdAt,
    expiresAt: new Date(Date.now() + RECEIPT_TTL_MS).toISOString(),
  };
}

export function appendTaskActionReceipt(receipts = [], receipt = null, nowMs = Date.now()) {
  if (!receipt?.taskId || !receipt?.expectedStatusKey) return pruneTaskActionReceipts(receipts, nowMs);
  const next = [
    receipt,
    ...pruneTaskActionReceipts(receipts, nowMs).filter((item) => (
      receiptTaskId(item) !== receipt.taskId ||
      safeText(item.txHash, 180) !== safeText(receipt.txHash, 180)
    )),
  ];
  return next.slice(0, MAX_RECEIPTS);
}

export function pruneTaskActionReceipts(receipts = [], nowMs = Date.now()) {
  return (Array.isArray(receipts) ? receipts : [])
    .filter((receipt) => receipt?.taskId && receipt?.expectedStatusKey && !receiptExpired(receipt, nowMs))
    .slice(0, MAX_RECEIPTS);
}

function shouldOverlayReceipt(task = {}, receipt = {}, nowMs = Date.now()) {
  if (receiptExpired(receipt, nowMs)) return false;
  const currentStatus = normalizeTaskStatus(task.statusKey || task.status);
  const expectedStatus = normalizeTaskStatus(receipt.expectedStatusKey);
  if (taskIsTerminal(currentStatus)) return false;
  return statusProgress(currentStatus) < statusProgress(expectedStatus);
}

function overlayTask(task = {}, receipt = {}, nowMs = Date.now()) {
  const expectedStatus = normalizeTaskStatus(receipt.expectedStatusKey);
  const info = taskStatusInfo(expectedStatus);
  return {
    ...task,
    status: taskStatusLabel(expectedStatus),
    statusKey: expectedStatus,
    statusTone: info.tone,
    statusColor: taskStatusColor(expectedStatus),
    statusTab: taskStatusTab(expectedStatus),
    lifecycle: info,
    ago: relativeAge(receipt.createdAt, nowMs) || task.ago,
    updatedAt: receipt.createdAt || task.updatedAt,
    txHash: receipt.txHash || task.txHash,
    clientActionPending: true,
    clientSyncLabel: "syncing",
    clientSyncDetail:
      expectedStatus === TASK_STATUS.submitted
        ? "Evidence was submitted. Task state is updating."
        : "Task action was signed. Task state is updating.",
    metadata: {
      ...(task.metadata || {}),
      optimisticLastTxHash: receipt.txHash || "",
      pendingActionReceipt: {
        actionType: receipt.actionType || "",
        expectedStatusKey: expectedStatus,
        txHash: receipt.txHash || "",
        createdAt: receipt.createdAt || "",
      },
    },
  };
}

function groupTasks(tasks = []) {
  const grouped = { outstanding: [], verification: [], refused: [], rewarded: [] };
  for (const task of tasks) {
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
  if (!activeReceipts.length) return tasks;

  const sourceTasks = [
    ...(Array.isArray(tasks?.outstanding) ? tasks.outstanding : []),
    ...(Array.isArray(tasks?.verification) ? tasks.verification : []),
    ...(Array.isArray(tasks?.refused) ? tasks.refused : []),
    ...(Array.isArray(tasks?.rewarded) ? tasks.rewarded : []),
  ];

  const mergedTasks = sourceTasks.map((task) => {
    const receipt = activeReceipts.find((item) => receiptAppliesToTask(item, task, { accountId, walletAddress }));
    return receipt && shouldOverlayReceipt(task, receipt, nowMs) ? overlayTask(task, receipt, nowMs) : task;
  });
  const grouped = groupTasks(mergedTasks);

  return {
    ...tasks,
    ...grouped,
    sync: {
      ...(tasks?.sync || {}),
      activeReceiptCount: activeReceipts.length,
      optimisticSyncTaskIds: mergedTasks
        .filter((task) => task?.clientActionPending)
        .map((task) => task.taskId || task.fullId || task.id || "")
        .filter(Boolean),
    },
  };
}

export function pruneTaskActionReceiptsForTaskState(receipts = [], tasks = {}, {
  accountId = "",
  walletAddress = "",
  nowMs = Date.now(),
} = {}) {
  const sourceTasks = [
    ...(Array.isArray(tasks?.outstanding) ? tasks.outstanding : []),
    ...(Array.isArray(tasks?.verification) ? tasks.verification : []),
    ...(Array.isArray(tasks?.refused) ? tasks.refused : []),
    ...(Array.isArray(tasks?.rewarded) ? tasks.rewarded : []),
  ];

  return pruneTaskActionReceipts(receipts, nowMs).filter((receipt) => {
    const task = sourceTasks.find((item) => receiptAppliesToTask(receipt, item, { accountId, walletAddress }));
    if (!task) return true;
    return shouldOverlayReceipt(task, receipt, nowMs);
  });
}

export function loadTaskActionReceipts(storage, key = "tasknode_task_action_receipts") {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key) || "[]");
    return pruneTaskActionReceipts(parsed);
  } catch {
    return [];
  }
}

export function saveTaskActionReceipts(storage, receipts = [], key = "tasknode_task_action_receipts") {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(pruneTaskActionReceipts(receipts)));
  } catch {
    // Session storage is an optimization for reload continuity.
  }
}

export function taskSyncNoticeForStatus(sync = {}) {
  const status = safeText(sync?.status, 80);
  const indexingLagCount = Number(sync?.indexingLagCount || 0);
  if (status === "reducer_attention") {
    return {
      label: "Task sync needs attention",
      body: `Some task updates failed to process${sync.failedReducerCount ? ` (${sync.failedReducerCount} failed)` : ""}. Task rows may lag until sync recovers.`,
    };
  }
  if (status === "indexing_lag" && indexingLagCount > 3) {
    return {
      label: "Task list is updating",
      body: "Several recently signed task changes are still syncing. Task rows refresh automatically.",
    };
  }
  return null;
}
