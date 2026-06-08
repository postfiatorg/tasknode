import {
  normalizeTaskStatus,
  TASK_STATUS,
  taskStatusLabel,
} from "../../../shared/task-lifecycle.js";

const RECEIPT_TTL_MS = 10 * 60 * 1000;
const MAX_RECEIPTS = 40;

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function taskId(task = {}) {
  return safeText(task.taskId || task.fullId || task.id, 180);
}

function taskTxHash(task = {}) {
  return safeText(task.txHash || task.metadata?.optimisticLastTxHash, 180);
}

function receiptExpired(receipt = {}, nowMs = Date.now()) {
  const expiresAt = Date.parse(receipt.expiresAt || "");
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Number(nowMs || 0);
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

export function taskActionReceiptFromObservedTask({
  accountId = "",
  walletAddress = "",
  task = {},
} = {}) {
  const taskIdValue = taskId(task);
  const expectedStatusKey = normalizeTaskStatus(task?.statusKey || task?.status);
  if (!taskIdValue || expectedStatusKey === TASK_STATUS.unknown) return null;
  const createdAt = new Date().toISOString();
  const txHash = taskTxHash(task);
  return {
    id: `receipt_observed_${taskIdValue}_${expectedStatusKey}_${txHash || "no_tx"}`,
    accountId: safeText(accountId, 180),
    walletAddress: safeText(walletAddress, 180),
    taskId: taskIdValue,
    actionType: "detail_observed",
    expectedStatusKey,
    expectedStatus: taskStatusLabel(expectedStatusKey),
    txHash,
    cid: "",
    clientActionPending: false,
    clientSyncLabel: "",
    clientSyncDetail: "",
    createdAt,
    expiresAt: new Date(Date.now() + RECEIPT_TTL_MS).toISOString(),
  };
}

export function appendTaskActionReceipt(receipts = [], receipt = null, nowMs = Date.now()) {
  if (!receipt?.taskId || !receipt?.expectedStatusKey) return pruneTaskActionReceipts(receipts, nowMs);
  const next = [
    receipt,
    ...pruneTaskActionReceipts(receipts, nowMs).filter((item) => (
      safeText(item.taskId || item.fullId || item.id, 180) !== receipt.taskId ||
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
