import {
  chatExecutionStatus,
  chatModePrices,
  executeChat,
  isKnownChatMode,
  logChatProviderError,
  normalizedChatMode,
} from "./chat-router.js";
import { effectiveDefaultChatMode } from "./chat-mode-defaults.js";
import {
  contextEditMode,
  executeContextEditChat,
  isContextEditPayload,
} from "./context-edit-chat.js";
import { chatEstimate, chatEstimateForAccount } from "./chat-estimate.js";
import { getChatMessages, usageSummary } from "./repositories/chat-billing.js";
import { recordChatFailureObservability } from "./repositories/user-observability.js";
import { loadChatExecutionContext } from "./chat-context-load.js";
import { normalizeClientChatHistory } from "./chat-client-history.js";
import { getIChingProfile, iChingProfilePromptPayload } from "./repositories/i-ching-profile.js";
import { validateChatAttachments } from "./chat-attachment-utils.js";
import { isHelpChatMode } from "./chat-help-mode.js";
import { chatPersonaIsModality, normalizeChatPersona } from "../shared/chat-personas.js";
import { metadataWithMachineAgentOrigin } from "./agent-origin.js";
import { recordAgentActionJournal } from "./agent-quality-gates.js";
import { getActiveContextEditProposal } from "./repositories/context-edit.js";

function chatUserMetadata(payload = {}, agentOrigin = null) {
  return metadataWithMachineAgentOrigin(payload, agentOrigin);
}

function chatPayload(payload, { source = "", providerTimeoutMs = 0, agentOrigin = null } = {}) {
  const accountId = typeof payload?.accountId === "string" ? payload.accountId.trim().slice(0, 160) : "";
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  const contextMode = isContextEditPayload(payload) ? contextEditMode : "";
  const persona = contextMode ? "jobs" : normalizeChatPersona(payload?.persona);
  const requestedMode = typeof payload?.mode === "string" ? payload.mode.trim() : "";
  const mode = contextMode || chatPersonaIsModality(persona) ? "Thinking" : requestedMode || effectiveDefaultChatMode();
  const conversationId =
    typeof payload?.conversationId === "string" && payload.conversationId.trim()
      ? payload.conversationId.trim().slice(0, 160)
      : "dev";
  const dryRun = payload?.dryRun === true;
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const clientHistory = normalizeClientChatHistory(payload?.clientHistory);
  const clientRequestId = typeof payload?.clientRequestId === "string" ? payload.clientRequestId.trim().slice(0, 180) : "";
  const userMessageId = typeof payload?.userMessageId === "string" ? payload.userMessageId.trim().slice(0, 180) : "";
  const assistantMessageId = typeof payload?.assistantMessageId === "string" ? payload.assistantMessageId.trim().slice(0, 180) : "";
  return {
    accountId,
    message,
    mode: isKnownChatMode(mode) ? normalizedChatMode(mode) : "",
    requestedMode: mode,
    contextMode,
    conversationId,
    dryRun,
    attachments,
    clientHistory,
    clientRequestId,
    userMessageId,
    assistantMessageId,
    persona,
    userMetadata: chatUserMetadata(payload, agentOrigin),
    source: typeof source === "string" ? source.trim().slice(0, 80) : "",
    providerTimeoutMs: Number(providerTimeoutMs) > 0 ? Number(providerTimeoutMs) : 0,
  };
}

function chatAttachmentFailureBody(action, validation, estimate) {
  const tooLarge = validation.status === 413;
  return {
    ok: false,
    error: tooLarge ? "chat_attachment_too_large" : "chat_attachment_invalid",
    action,
    message: tooLarge
      ? "One or more attachments are too large."
      : "One or more attachments could not be accepted.",
    actionRequired: action === "chat_estimate"
      ? "Remove or replace the failed attachments before estimating chat."
      : "Remove or replace the failed attachments before sending.",
    attachmentErrors: validation.errors,
    estimate,
  };
}

function unknownChatModeBody(action = "chat_estimate") {
  return {
    ok: false,
    error: "unknown_chat_mode",
    action,
    message: "The requested chat mode is not available.",
    actionRequired: "Choose one of the configured chat modes before sending.",
  };
}

function unknownChatPersonaBody(action = "chat_estimate") {
  return {
    ok: false,
    error: "unknown_chat_persona",
    action,
    message: "The requested chat personality is not available.",
    actionRequired: "Choose an available chat personality or modality before sending.",
  };
}

export async function chatEstimateStart(payload, accountId = "") {
  const attachmentValidation = validateChatAttachments(payload?.attachments);
  const estimatePayload = {
    ...payload,
    attachments: attachmentValidation.ok ? attachmentValidation.attachments : [],
  };

  let estimate;
  try {
    estimate = attachmentValidation.ok
      ? await chatEstimateForAccount(estimatePayload, accountId)
      : chatEstimate(estimatePayload);
  } catch (error) {
    if (error?.message === "unknown_chat_mode") {
      return { status: 400, body: unknownChatModeBody("chat_estimate") };
    }
    if (error?.message === "unknown_chat_persona") {
      return { status: 400, body: unknownChatPersonaBody("chat_estimate") };
    }
    throw error;
  }

  if (!attachmentValidation.ok) {
    return {
      status: attachmentValidation.status,
      body: chatAttachmentFailureBody("chat_estimate", attachmentValidation, estimate),
    };
  }

  return { status: 200, body: estimate };
}

async function chatExecutionPreflight(payload, method, action = "chat_send", options = {}) {
  let chat = chatPayload(payload, options);
  let estimate = null;

  if (!chat.mode) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "unknown_chat_mode",
        action,
        message: "The requested chat mode is not available.",
        actionRequired: "Choose one of the configured chat modes before sending.",
      },
      chat,
      estimate,
    };
  }

  if (!chat.persona) {
    return {
      ok: false,
      status: 400,
      body: unknownChatPersonaBody(action),
      chat,
      estimate,
    };
  }

  if (chat.persona === "i-ching" && !chat.message) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "i_ching_question_required",
        action,
        message: "I Ching requires a specific written question before casting.",
        actionRequired: "Type the situation or decision you want the I Ching to read.",
      },
      chat,
      estimate,
    };
  }

  estimate = chatEstimate({ ...payload, mode: chat.mode, persona: chat.persona, attachments: chat.attachments });

  if (method !== "POST") {
    return {
      ok: false,
      status: 405,
      body: {
        ok: false,
        error: `${action}_method_not_allowed`,
        action,
        message: action === "chat_stream" ? "Chat stream requires POST." : "Chat send requires POST.",
        actionRequired: "Send chat payloads with POST.",
      },
      chat,
      estimate,
    };
  }

  if (!chat.message && chat.attachments.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "chat_message_required",
        action,
        message: action === "chat_stream"
          ? "Chat stream requires a non-empty message."
          : "Chat send requires a non-empty message.",
        actionRequired: "Send a message before requesting chat execution.",
      },
      chat,
      estimate,
    };
  }

  const signedOutHelp = !chat.accountId && isHelpChatMode(chat.mode) && !chat.contextMode && chat.persona === "jobs";
  if (!chat.accountId && !signedOutHelp) {
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: "chat_login_required",
        action,
        message: "Sign in before sending billable chat requests.",
        actionRequired: "Use an account login before starting chat execution.",
        estimate,
      },
      chat,
      estimate,
    };
  }

  if (chat.persona === "i-ching") {
    const iChingProfile = await getIChingProfile({ accountId: chat.accountId });
    if (!iChingProfile?.combined) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: "i_ching_profile_required",
          action,
          message: "Set up your private birth chart before requesting an I Ching reading.",
          actionRequired: "Enter birth date, birth time, birth location, and gender in I Ching setup.",
          setupPath: "/api/i-ching/profile",
        },
        chat,
        estimate,
      };
    }
    chat = { ...chat, iChingProfile };
  }

  const attachmentValidation = validateChatAttachments(chat.attachments);
  if (!attachmentValidation.ok) {
    estimate = chatEstimate({ ...payload, mode: chat.mode, persona: chat.persona, attachments: [] });
    return {
      ok: false,
      status: attachmentValidation.status,
      body: chatAttachmentFailureBody(action, attachmentValidation, estimate),
      chat,
      estimate,
    };
  }
  chat = { ...chat, attachments: attachmentValidation.attachments };
  const estimatePayload = { ...payload, mode: chat.mode, persona: chat.persona, attachments: chat.attachments };
  estimate = chatEstimate(estimatePayload, signedOutHelp ? { historyMessages: chat.clientHistory } : undefined);

  if (chat.dryRun) {
    if (signedOutHelp) {
      return {
        ok: false,
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          action,
          conversationId: chat.conversationId,
          message: estimate.executionReady
            ? "Help chat is configured. Dry run skipped the provider call."
            : "Help chat is not configured in this environment. Dry run skipped the provider call.",
          estimate,
          contextStatus: null,
        },
        chat: {
          ...chat,
          contextDocument: null,
          memoryContext: null,
          taskContext: null,
          contextStatus: null,
        },
        estimate,
      };
    }

    const [executionContext, historyMessages, activeProposal] = await Promise.all([
      loadChatExecutionContext(chat.accountId),
      chat.accountId && chat.conversationId
        ? getChatMessages({ accountId: chat.accountId, conversationId: chat.conversationId, limit: 12 }).catch(() => [])
        : [],
      chat.accountId && chat.conversationId && chat.contextMode === contextEditMode
        ? getActiveContextEditProposal({ accountId: chat.accountId, conversationId: chat.conversationId }).catch(() => null)
        : null,
    ]);
    estimate = chatEstimate(estimatePayload, {
      contextDocument: executionContext.contextDocument,
      memoryContext: executionContext.memoryContext,
      taskContext: executionContext.taskContext,
      historyMessages,
      activeProposal,
      iChingProfile: iChingProfilePromptPayload(chat.iChingProfile),
    });
    return {
      ok: false,
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        action,
        conversationId: chat.conversationId,
        message: estimate.executionReady
          ? "Chat execution is configured. Dry run skipped the provider call."
          : "Chat execution is not configured for this mode. Dry run skipped the provider call.",
        estimate,
        contextStatus: executionContext.contextStatus,
      },
      chat: {
        ...chat,
        contextDocument: executionContext.contextDocument,
        memoryContext: executionContext.memoryContext,
        taskContext: executionContext.taskContext,
        contextStatus: executionContext.contextStatus,
      },
      estimate,
    };
  }

  if (!estimate.executionReady) {
    const configured = estimate.providerConfigured;
    return {
      ok: false,
      status: configured ? 503 : 409,
      body: {
        ok: false,
        error: configured ? "chat_provider_disabled" : "chat_provider_not_configured",
        action,
        message: `${chat.mode} is not enabled for chat execution in this environment.`,
        actionRequired: configured
          ? `Enable and verify the ${estimate.provider} route for this mode or choose a ready mode.`
          : `Configure the ${estimate.provider} provider for this mode or choose a ready mode.`,
        estimate,
      },
      chat,
      estimate,
    };
  }

  if (signedOutHelp) {
    return {
      ok: true,
      status: 200,
      chat: {
        ...chat,
        contextDocument: null,
        memoryContext: null,
        taskContext: null,
        contextStatus: null,
        clientHistory: chat.clientHistory,
        ephemeralHistoryMessages: chat.clientHistory,
      },
      estimate,
    };
  }

  const executionContext = await loadChatExecutionContext(chat.accountId);
  const [historyMessages, activeProposal] = await Promise.all([
    chat.accountId && chat.conversationId
      ? getChatMessages({ accountId: chat.accountId, conversationId: chat.conversationId, limit: 12 }).catch(() => [])
      : [],
    chat.accountId && chat.conversationId && chat.contextMode === contextEditMode
      ? getActiveContextEditProposal({ accountId: chat.accountId, conversationId: chat.conversationId }).catch(() => null)
      : null,
  ]);
  estimate = chatEstimate(estimatePayload, {
    contextDocument: executionContext.contextDocument,
    memoryContext: executionContext.memoryContext,
    taskContext: executionContext.taskContext,
    historyMessages,
    activeProposal,
    iChingProfile: iChingProfilePromptPayload(chat.iChingProfile),
  });

  const usage = await usageSummary({ accountId: chat.accountId, conversationId: chat.conversationId });
  if (Number(usage.availableCreditUsd || 0) < Number(estimate.estimatedUsd || 0)) {
    return {
      ok: false,
      status: 402,
      body: {
        ok: false,
        error: "chat_credit_required",
        action,
        message: "Available chat credit is too low for this request.",
        actionRequired: "Top up the account balance or use an account with available credit.",
        estimate,
        contextStatus: executionContext.contextStatus,
        usage: {
          billingModel: "usage_based",
          currency: "USD",
          currentSpendUsd: usage.currentSpendUsd,
          currentCreditUsd: usage.currentCreditUsd,
          availableCreditUsd: usage.availableCreditUsd,
          ledgerEntryCount: usage.ledgerEntryCount,
        },
      },
      chat,
      estimate,
    };
  }

  return {
    ok: true,
    status: 200,
    chat: {
      ...chat,
      contextDocument: executionContext.contextDocument,
      memoryContext: executionContext.memoryContext,
      taskContext: executionContext.taskContext,
      contextStatus: executionContext.contextStatus,
    },
    estimate,
  };
}

export async function chatSend(payload, method, options = {}) {
  const preflight = await chatExecutionPreflight(payload, method, "chat_send", options);
  const {
    accountId,
    message,
    mode,
    conversationId,
    attachments,
    contextDocument,
    memoryContext,
    taskContext,
    contextStatus,
    clientHistory,
    userMetadata,
    persona,
    iChingProfile,
    userMessageId,
    assistantMessageId,
  } = preflight.chat;
  const { estimate } = preflight;
  if (!preflight.ok) return { status: preflight.status, body: preflight.body };

  try {
    const result = preflight.chat.contextMode === contextEditMode
      ? await executeContextEditChat({
          accountId,
          message,
          conversationId,
          attachments,
          contextDocument,
          memoryContext,
          taskContext,
          contextStatus,
          persona,
          userMetadata,
        })
      : await executeChat({
          accountId,
          mode,
          message,
          conversationId,
          attachments,
          contextDocument,
          memoryContext,
          taskContext,
          contextStatus,
          userMetadata,
          ephemeralHistoryMessages: clientHistory,
          source: preflight.chat.source,
          providerTimeoutMs: preflight.chat.providerTimeoutMs,
          persona,
          iChingProfile,
          userMessageId,
          assistantMessageId,
        });
    const orcWorkJournal = options.agentOrigin
      ? await recordAgentActionJournal({
          agentOrigin: options.agentOrigin,
          action: "chatbot_chat",
          status: "recorded",
          outcomeStatus: "sent",
          accountId,
          conversationId,
          metadata: {
            mode,
            persona: result.persona || persona,
            provider: result.provider,
            model: result.model,
            userMessageId: result.user?.id || "",
            assistantMessageId: result.assistant?.id || "",
            responseId: result.responseId || "",
            messageCharacterCount: message.length,
          },
          idempotencyKey: `agent_chatbot_chat:${options.agentOrigin.walletAddress || accountId}:${conversationId}:${result.user?.id || result.responseId || ""}`,
        })
      : null;
    return {
      status: 200,
      body: {
        ok: true,
        action: "chat_send",
        message: "Chat response generated.",
        conversationId,
        mode,
        persona: result.persona || persona,
        provider: result.provider,
        model: result.model,
        responseId: result.responseId,
        user: result.user,
        assistant: result.assistant,
        estimate,
        contextStatus: result.contextStatus || contextStatus,
        usage: {
          billingModel: "usage_based",
          currency: "USD",
          inputTokens: result.usage.inputTokens,
          promptCacheHitTokens: result.usage.promptCacheHitTokens || 0,
          promptCacheMissTokens: result.usage.promptCacheMissTokens || 0,
          promptCacheHitRate: result.usage.promptCacheHitRate || 0,
          cacheUsageReported: result.usage.cacheUsageReported === true,
          cacheSavingsUsd: result.usage.cacheSavingsUsd || 0,
          costSource: result.usage.costSource || "",
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          webSearchCalls: result.usage.webSearchCalls || 0,
          toolCostUsd: result.usage.toolCostUsd || 0,
          costUsd: result.usage.costUsd,
        },
        ledgerEntry: result.ledgerEntry,
        orcWorkJournal,
      },
    };
  } catch (error) {
    const status = error?.status || 502;
    logChatProviderError(error, {
      action: "chat_send",
      mode,
      provider: estimate?.provider,
      model: estimate?.model,
    });
    await recordChatFailureObservability({
      accountId,
      conversationId,
      mode,
      provider: estimate?.provider,
      model: estimate?.model,
      status,
      error,
      sourceRoute: "server/product-chat-contracts.js::chatSend",
    }).catch(() => {});
    return {
      status,
      body: {
        ok: false,
        error: error?.message || "chat_provider_error",
        action: "chat_send",
        message:
          status === 504
            ? "The chat provider timed out before returning a response."
            : "The chat provider could not complete this response.",
        actionRequired:
          "Retry with a shorter prompt, choose another configured mode, or check provider health.",
        providerStatus: status,
        providerMessage: error?.providerMessage || "",
        estimate,
      },
    };
  }
}

export async function chatStreamStart(payload, method, options = {}) {
  const preflight = await chatExecutionPreflight(payload, method, "chat_stream", options);
  if (!preflight.ok) return { status: preflight.status, body: preflight.body };
  if (preflight.chat.contextMode === contextEditMode) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "context_edit_requires_send",
        action: "chat_stream",
        message: "Context Edit uses the non-streaming chat route so the structured proposal can be validated before display.",
        actionRequired: "Send Context Edit requests through /api/chat/send.",
        estimate: preflight.estimate,
      },
    };
  }

  return {
    status: 200,
    stream: true,
    chat: preflight.chat,
    estimate: preflight.estimate,
    body: {
      ok: true,
      action: "chat_stream",
      conversationId: preflight.chat.conversationId,
      mode: preflight.chat.mode,
      persona: preflight.chat.persona,
      provider: preflight.estimate.provider,
      model: preflight.estimate.model,
      estimate: preflight.estimate,
      contextStatus: preflight.chat.contextStatus,
    },
  };
}

export function chatModes({ signedOut = false } = {}) {
  return Object.keys(chatModePrices).map((label) => {
    const status = chatExecutionStatus(label);
    const config = chatModePrices[label];
    const loginRequired = signedOut && !isHelpChatMode(label);
    return {
      label,
      provider: status.provider,
      providerLabel: status.providerLabel,
      model: status.model,
      configured: status.configured,
      enabled: loginRequired ? false : status.enabled,
      status: loginRequired ? "login_required" : status.status,
      actionRequired: loginRequired ? "Sign in to use billable chat modes." : undefined,
      privacy: "Ambient inference route",
      latency: config.reasoningEffort ? "Deep" : "Fast",
    };
  });
}
