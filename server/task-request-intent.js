import { randomUUID } from "node:crypto";
import { validateChatAttachments } from "./chat-attachment-utils.js";
import { appendChatTurn } from "./repositories/chat-billing.js";

export const taskRequestCanonicalText =
  "Request a task using my current context document, account memory, recent messages, and the additional task details I just provided.";

function actionResponse({ status, error, action, message, actionRequired }) {
  return {
    status,
    body: {
      ok: false,
      error,
      action,
      message,
      actionRequired,
    },
  };
}

function safeTaskString(value = "", maxLength = 4000) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function safeTaskCorrelationId(value = "", prefix = "req") {
  const normalized = String(value || "").trim().slice(0, 96);
  if (/^[a-z]+_[A-Za-z0-9_-]{8,90}$/.test(normalized)) return normalized;
  return `${prefix}_${randomUUID()}`;
}

function taskRequestIntentPayload(payload) {
  const accountId = typeof payload?.accountId === "string" ? payload.accountId.trim().slice(0, 160) : "";
  const conversationId =
    typeof payload?.conversationId === "string" && payload.conversationId.trim()
      ? payload.conversationId.trim().slice(0, 160)
      : "dev";
  const userDetailText = safeTaskString(payload?.userDetailText || payload?.message || "", 8000);
  const sourceConversationTitle = safeTaskString(payload?.sourceConversationTitle || "", 160);
  const source = safeTaskString(payload?.source || "user_chat", 80) || "user_chat";
  const requestedTaskKind = safeTaskString(payload?.requestedTaskKind || "personal", 80) || "personal";
  const requestId = safeTaskCorrelationId(payload?.requestId, "req");
  const bundleId = safeTaskCorrelationId(payload?.bundleId, "bundle");
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  return {
    accountId,
    conversationId,
    userDetailText,
    sourceConversationTitle,
    source,
    requestedTaskKind,
    requestId,
    bundleId,
    attachments,
    status: safeTaskString(payload?.status || "intent_recorded", 80) || "intent_recorded",
    requestEventCid: safeTaskString(payload?.requestEventCid || payload?.cid || "", 240),
    requestBundleCid: safeTaskString(payload?.requestBundleCid || "", 240),
    txHash: safeTaskString(payload?.txHash || "", 120),
    assistantMessage: safeTaskString(payload?.assistantMessage || "", 1000),
  };
}

function taskAttachmentFailure(validation) {
  const tooLarge = validation.status === 413;
  return actionResponse({
    status: validation.status,
    error: tooLarge ? "task_request_attachment_too_large" : "task_request_attachment_invalid",
    action: "task_request_intent",
    message: tooLarge
      ? "One or more task request attachments are too large."
      : "One or more task request attachments could not be accepted.",
    actionRequired: "Remove or replace the failed attachments before requesting the task.",
  });
}

export async function taskRequestIntentStart(payload, method) {
  const action = "task_request_intent";
  let request = taskRequestIntentPayload(payload);

  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "task_request_method_not_allowed",
      action,
      message: "Task request intents require POST.",
      actionRequired: "Send task request payloads with POST.",
    });
  }

  if (!request.accountId) {
    return actionResponse({
      status: 401,
      error: "task_request_login_required",
      action,
      message: "Sign in before requesting tasks.",
      actionRequired: "Use an account login before starting a task request.",
    });
  }

  const attachmentValidation = validateChatAttachments(request.attachments);
  if (!attachmentValidation.ok) {
    const failure = taskAttachmentFailure(attachmentValidation);
    failure.body.attachmentErrors = attachmentValidation.errors;
    return failure;
  }
  request = { ...request, attachments: attachmentValidation.attachments };

  if (!request.userDetailText && request.attachments.length === 0) {
    return actionResponse({
      status: 400,
      error: "task_request_detail_required",
      action,
      message: "Task requests need detail text or an attachment.",
      actionRequired: "Add the relevant details for the task request before sending.",
    });
  }

  const taskRequestMessageId = `msg_${request.requestId}_request_user`.slice(0, 180);
  const assistantMessageId = `msg_${request.requestId}_request_assistant`.slice(0, 180);
  const baseMetadata = {
    schema: "pf.task.request_intent.v1",
    kind: "task_request_intent",
    requestId: request.requestId,
    bundleId: request.bundleId,
    conversationId: request.conversationId,
    taskRequestMessageId,
    requestText: taskRequestCanonicalText,
    userDetailText: request.userDetailText,
    requestedTaskKind: request.requestedTaskKind,
    source: request.source,
    sourceConversationTitle: request.sourceConversationTitle || "New chat",
    status: request.status,
    requestEventCid: request.requestEventCid || undefined,
    requestBundleCid: request.requestBundleCid || undefined,
    txHash: request.txHash || undefined,
  };

  let persisted;
  try {
    persisted = await appendChatTurn({
      accountId: request.accountId,
      conversationId: request.conversationId,
      mode: "Task Request",
      provider: "tasknode",
      model: "request-intent-v1",
      responseId: request.requestId,
      userMessage: request.userDetailText || "See attached task request files.",
      assistantMessage:
        request.assistantMessage ||
        "Task request recorded. Preparing the context, memory, and recent chat bundle for PFTL signing.",
      userMessageId: taskRequestMessageId,
      assistantMessageId,
      userMetadata: {
        ...baseMetadata,
        role: "request_detail",
      },
      assistantMetadata: {
        ...baseMetadata,
        role: "request_receipt",
      },
      runMetadata: baseMetadata,
      conversationStatus: request.source === "task_interface" ? "task_request" : "active",
      attachments: request.attachments,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    });
  } catch (error) {
    if (error?.code === "23505") {
      return actionResponse({
        status: 409,
        error: "task_request_duplicate",
        action,
        message: "This task request was already recorded.",
        actionRequired: "Start a new task request or refresh the conversation.",
      });
    }
    throw error;
  }

  return {
    status: 200,
    body: {
      ok: true,
      action,
      message: "Task request intent recorded.",
      conversationId: request.conversationId,
      request: baseMetadata,
      user: persisted.user,
      assistant: persisted.assistant,
    },
  };
}
