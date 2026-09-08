import { createHash, randomUUID } from "node:crypto";
import { isIdentifierChar } from "./inference-text.js";
import { taskRequestBundleDigest } from "./task-request-terminal-bundle.js";

export function taskRequestConflict() {
  return Object.assign(new Error("This request key already belongs to a different task request. Use a new key for new work."), {
    code: "task_request_idempotency_conflict", status: 409,
  });
}

export function taskRequestCorrelationId(value = "", prefix = "req") {
  const normalized = String(value || "").trim();
  const separator = normalized.indexOf("_");
  const validPrefix = separator > 0 && [...normalized.slice(0, separator)].every((char) => char >= "a" && char <= "z");
  const suffix = normalized.slice(separator + 1);
  if (validPrefix && suffix.length >= 8 && suffix.length <= 90 && [...suffix].every(isIdentifierChar)) return normalized;
  return `${prefix}_${randomUUID()}`;
}

// Keys identify commands within an authenticated account, never across accounts.
// The immutable body is checked separately so a changed body cannot create a
// second task under the same retry key.
export function taskRequestCommandIds({ accountId, idempotencyKey, requestId, bundleId } = {}) {
  if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === "") {
    return { requestId: taskRequestCorrelationId(requestId), bundleId: taskRequestCorrelationId(bundleId, "bundle") };
  }
  if (!accountId || typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 180) {
    throw Object.assign(new Error("A task request retry key must be a nonempty string of at most 180 characters."), {
      code: "task_request_idempotency_key_invalid", status: 400,
    });
  }
  const digest = createHash("sha256").update(JSON.stringify([accountId, "task_request", idempotencyKey])).digest("hex");
  return { requestId: `req_${digest}`, bundleId: `bundle_${digest}` };
}

export function taskRequestIntentDigest(request = {}) {
  const text = (value, max) => String(value || "").trim().slice(0, max);
  return taskRequestBundleDigest({
    requestText: text(request.requestText || request.request_text, 8000),
    userDetailText: text(request.userDetailText || request.user_detail_text, 8000),
    requestedTaskKind: text(request.requestedTaskKind || request.requested_task_kind || "personal", 80),
    conversationId: text(request.sourceConversationId || request.source_conversation_id || request.conversationId, 180),
    attachments: request.attachments || request.metadata?.requestBundle?.request?.attachments || [],
  });
}
