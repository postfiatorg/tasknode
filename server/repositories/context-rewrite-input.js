import { createHash } from "node:crypto";
import { safeText } from "./context-rewrite-projection.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export function contextRewriteStateError(row = null, jobId = "") {
  const status = safeText(row?.status || "", 80);
  const stage = safeText(row?.current_stage || "", 80);
  const error = new Error(status === "cancelled" ? "context_rewrite_cancelled" : "context_rewrite_job_not_running");
  error.contextRewriteTerminal = terminalStatuses.has(status) || status !== "running";
  error.contextRewriteStatus = status;
  error.contextRewriteStage = stage;
  error.contextRewriteJobId = safeText(row?.id || jobId, 180);
  return error;
}

function contextRewriteLockError(row = null, expected = "") {
  const error = new Error("context_rewrite_job_lock_lost");
  error.contextRewriteTerminal = true;
  error.contextRewriteStatus = safeText(row?.status || "", 80);
  error.contextRewriteStage = safeText(row?.current_stage || "", 80);
  error.contextRewriteJobId = safeText(row?.id || "", 180);
  error.expectedLockedBy = safeText(expected, 120);
  return error;
}

export function expectedLockedBy(job = {}) {
  return safeText(job?.lockedBy || job?.locked_by || "", 120);
}

export function currentAttemptId(job = {}) {
  return safeText(job?.currentAttemptId || job?.current_attempt_id || "", 180);
}

export function assertRunningRow(row = null, { jobId = "", lockedBy = "" } = {}) {
  if (!row || row.status !== "running") {
    throw contextRewriteStateError(row, jobId);
  }
  if (lockedBy && safeText(row.locked_by, 120) !== lockedBy) {
    throw contextRewriteLockError(row, lockedBy);
  }
}

export function isContextRewriteTerminalError(error = null) {
  return Boolean(error?.contextRewriteTerminal);
}

export function safeAccountId(accountId = "") {
  return safeText(accountId, 160);
}

export function safeConversationId(conversationId = "") {
  return safeText(conversationId || "dev", 180) || "dev";
}

function safeConversationAccountId(accountId = "") {
  return String(accountId || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function assertConversationIdAccountBoundary({ accountId = "", conversationId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  if (!normalizedConversationId.startsWith("account_")) return;
  const accountPrefix = safeConversationAccountId(normalizedAccountId)
    ? `account_${safeConversationAccountId(normalizedAccountId)}_`
    : "";
  if (!accountPrefix || !normalizedConversationId.startsWith(accountPrefix)) {
    const error = new Error("chat_conversation_not_found");
    error.status = 404;
    throw error;
  }
}

export function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}
