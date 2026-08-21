import { randomUUID } from "node:crypto";
import {
  appendChatTurn,
  getChatMessagesForWrite,
} from "./repositories/chat-billing.js";
import { enqueueChatMemoryJob } from "./repositories/chat-memory.js";
import {
  chatMemoryContextForAccount,
  taskNodeInstructions,
} from "./chat-memory-context.js";
import { chatContextDocumentForAccount } from "./chat-account-context.js";
import { jobsRetrievalForChat } from "./jobs-corpus.js";
import { normalizeClientChatHistory } from "./chat-client-history.js";
import { taskContextForAccount } from "./chat-task-context.js";
import {
  fallbackUsage,
  openRouterUsage,
} from "./chat-provider-usage.js";
export {
  chatInputCharacterEstimate,
  normalizeChatAttachments,
} from "./chat-attachment-utils.js";
import { normalizeChatAttachments } from "./chat-attachment-utils.js";
import { buildChatContextStatus } from "./chat-context-status.js";
import { openRouterMessages } from "./chat-provider-message-builders.js";
import { helpModeInstructions, isHelpChatMode } from "./chat-help-mode.js";
import {
  ambientChatCompletion,
  ambientChatCompletionStream,
} from "./ambient-inference.js";
import { prepareAmbientChatAttachments } from "./ambient-attachments.js";
import { iChingProfilePromptPayload } from "./repositories/i-ching-profile.js";
import {
  chatPersonaIsModality,
  chatPersonaUsesJobsRetrieval,
  normalizeChatPersona,
} from "../shared/chat-personas.js";
import {
  chatExecutionStatus,
  chatModeConfig,
  chatProviderTimeoutMs,
  defaultProviderTimeoutMs,
  normalizedChatMode,
  unknownChatModeError,
} from "./chat-mode-runtime.js";
export * from "./chat-mode-runtime.js";
export {
  deepSeekMessages,
  openAiInput,
  openRouterMessages,
} from "./chat-provider-message-builders.js";



function safeLogText(value = "", max = 600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeDebugText(value = "", max = 1200) {
  const text = String(value || "").trim().replace(/\n{4,}/g, "\n\n\n");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 15)).trimEnd()} [truncated]`;
}

function chatThinkingForJobsRetrieval({ jobsResult = null, renderedContext = "" } = {}) {
  const chunks = Array.isArray(jobsResult?.chunks) ? jobsResult.chunks : [];
  const included = Boolean(String(renderedContext || "").trim());
  const state = jobsResult?.skipped
    ? "skipped"
    : jobsResult?.ok === false
      ? "error"
      : included
        ? "included"
        : "empty";

  return {
    state: "finished",
    jobsRetrieval: {
      state,
      included,
      reason: jobsResult?.reason || undefined,
      chunkCount: chunks.length,
      chunks: chunks.slice(0, 5).map((chunk, index) => ({
        rank: index + 1,
        title: safeDebugText(chunk.title || "Jobs corpus excerpt", 160),
        content: safeDebugText(chunk.content || "", 1600),
      })),
    },
  };
}

function chatThinkingWithResponseGate(thinking = {}, responseGate = null) {
  if (!responseGate || typeof responseGate !== "object") return thinking;
  return {
    ...thinking,
    responseGate,
  };
}

function assistantChatMetadata({ thinking = {}, responseGate = null } = {}) {
  const assistantThinking = chatThinkingWithResponseGate(thinking, responseGate);
  return {
    assistantThinking,
    assistantMetadata: responseGate
      ? { thinking: assistantThinking, responseGate }
      : { thinking: assistantThinking },
  };
}

export function completedChatTurnReplay({
  messages = [],
  userMessageId = "",
  assistantMessageId = "",
  contextStatus = null,
  persona = "jobs",
} = {}) {
  if (!userMessageId || !assistantMessageId) return null;
  const user = messages.find((message) => message?.id === userMessageId && message.role === "user");
  const assistant = messages.find((message) => message?.id === assistantMessageId && message.role === "assistant");
  if (!user || !assistant) return null;
  return {
    text: String(assistant.body || ""),
    provider: assistant.provider || "",
    model: assistant.model || "",
    responseId: assistant.responseId || "",
    usage: {
      inputTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      promptCacheHitRate: 0,
      cacheUsageReported: false,
      cacheSavingsUsd: 0,
      costSource: "idempotent_replay",
      outputTokens: 0,
      totalTokens: 0,
      webSearchCalls: 0,
      toolCostUsd: 0,
      costUsd: 0,
    },
    user,
    assistant: {
      ...assistant,
      thinking: assistant.thinking || assistant.metadata?.thinking,
    },
    contextStatus,
    persona: normalizeChatPersona(persona) || "jobs",
    replayed: true,
  };
}

function transientChatTurn({
  conversationId = "dev",
  mode = "",
  provider = "",
  model = "",
  responseId = "",
  userMessage = "",
  assistantMessage = "",
  attachments = [],
  userMetadata = {},
  assistantMetadata = {},
} = {}) {
  const createdAt = new Date().toISOString();
  const user = {
    id: `anon_user_${randomUUID()}`,
    role: "user",
    body: userMessage,
    createdAt,
    mode,
    conversationId,
  };
  if (userMetadata && typeof userMetadata === "object" && Object.keys(userMetadata).length > 0) {
    user.metadata = userMetadata;
  }
  const normalizedAttachments = normalizeChatAttachments(attachments);
  if (normalizedAttachments.length > 0) user.attachments = normalizedAttachments;

  const assistant = {
    id: `anon_assistant_${randomUUID()}`,
    role: "assistant",
    body: assistantMessage,
    createdAt,
    mode,
    provider,
    model,
    responseId: responseId || undefined,
  };
  if (assistantMetadata && Object.keys(assistantMetadata).length > 0) {
    assistant.metadata = assistantMetadata;
  }

  return {
    user,
    assistant,
    ledgerEntry: null,
    modelRun: null,
  };
}

function chatDeliveryContext({ accountId = "", mode = "", source = "" } = {}) {
  const context = {};
  const normalizedSource = String(source || "").trim();
  if (normalizedSource) context.source = normalizedSource;
  if (isHelpChatMode(mode)) {
    context.accountStatus = accountId ? "signed_in" : "signed_out";
  }
  return Object.keys(context).length > 0 ? context : null;
}

function loggedUsage(usage = null) {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    promptTokens: Number(usage.prompt_tokens || usage.inputTokens || 0),
    completionTokens: Number(usage.completion_tokens || usage.outputTokens || 0),
    totalTokens: Number(usage.total_tokens || usage.totalTokens || 0),
    promptCacheHitTokens: Number(
      usage.prompt_cache_hit_tokens ||
        usage.prompt_tokens_details?.cached_tokens ||
        usage.promptCacheHitTokens ||
        0
    ),
    reasoningTokens: Number(
      usage.reasoning_tokens ||
        usage.completion_tokens_details?.reasoning_tokens ||
        usage.output_tokens_details?.reasoning_tokens ||
        usage.reasoningTokens ||
        0
    ),
    cost: Number(usage.cost || usage.costUsd || 0),
  };
}

function chatInstructionsOverride({
  mode,
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
  persona = "jobs",
} = {}) {
  if (!chatPersonaUsesJobsRetrieval(persona)) return "";
  if (!isHelpChatMode(mode)) return "";
  return helpModeInstructions({
    contextDocument,
    memoryContext,
    taskContext,
    jobsEssence,
    deliveryContext,
  });
}

export function logChatProviderError(error, context = {}) {
  if (!error || error.loggedChatProviderError) return;
  error.loggedChatProviderError = true;
  console.warn("chat_provider_failure", {
    action: safeLogText(context.action, 80),
    mode: safeLogText(context.mode || error.mode, 80),
    provider: safeLogText(context.provider || error.provider, 80),
    model: safeLogText(context.model || error.model, 160),
    responseModel: safeLogText(error.responseModel, 160),
    upstreamProvider: safeLogText(error.upstreamProvider, 120),
    status: Number(error.status || 0),
    error: safeLogText(error.message || "chat_provider_error", 160),
    providerMessage: safeLogText(error.providerMessage, 600),
    finishReason: safeLogText(error.finishReason, 80),
    responseId: safeLogText(error.responseId, 120),
    usage: loggedUsage(error.usage),
  });
}

function providerEmptyResponseError({
  body = null,
  provider = "ambient",
  providerLabel = "Ambient",
  mode = "",
  model = "",
  responseId = null,
  responseModel = "",
  upstreamProvider = "",
  finishReason = "",
  usage = null,
} = {}) {
  const choice = body?.choices?.[0] || {};
  const error = new Error("chat_provider_empty_response");
  error.status = 502;
  error.provider = provider;
  error.mode = mode;
  error.model = model;
  error.responseId = body?.id || responseId || null;
  error.responseModel = body?.model || responseModel || model;
  error.upstreamProvider = body?.provider || upstreamProvider || "";
  error.finishReason = choice.finish_reason || finishReason || "";
  error.usage = body?.usage || usage || null;
  error.providerMessage = `${providerLabel} returned empty message content${
    error.finishReason ? ` with finish_reason=${error.finishReason}` : ""
  }.`;
  return error;
}

function ambientResponseFormat(responseFormat = null) {
  if (!responseFormat) return undefined;
  if (responseFormat.type !== "json_schema" || responseFormat.json_schema) return responseFormat;
  return {
    type: "json_schema",
    json_schema: {
      name: responseFormat.name || "tasknode_chat_output",
      strict: responseFormat.strict !== false,
      schema: responseFormat.schema || {},
    },
  };
}

export function ambientChatRequest({
  mode,
  model,
  message,
  conversationId,
  attachments = [],
  historyMessages = null,
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
  instructionsOverride = "",
  responseInstructionBlock = "",
  responseFormat = null,
  toolsEnabled = true,
  persona = "jobs",
}) {
  const config = chatModeConfig(mode);
  const instructions = [
    instructionsOverride || taskNodeInstructions({ message, contextDocument, memoryContext, taskContext, jobsEssence, deliveryContext, persona }),
    responseInstructionBlock,
  ].filter(Boolean).join("\n\n");
  const messages = openRouterMessages({
    conversationId,
    message,
    attachments,
    historyMessages,
    contextDocument,
    memoryContext,
    taskContext,
    jobsEssence,
    deliveryContext,
    instructionsOverride: instructions,
    persona,
  });
  return {
    model,
    messages,
    reasoning: config.reasoningEffort
      ? { effort: config.reasoningEffort, exclude: true }
      : config.disableReasoning
        ? { effort: "none", enabled: false, exclude: true }
        : undefined,
    response_format: ambientResponseFormat(responseFormat),
    enabled_tools: toolsEnabled && config.webSearchEnabled ? ["websearch"] : undefined,
    max_tokens: config.maxOutputTokens || undefined,
  };
}

function enqueueMemoryForTurn({ accountId, conversationId, persisted }) {
  if (!accountId || !persisted?.user?.id || !persisted?.assistant?.id) return;
  enqueueChatMemoryJob({
    accountId,
    conversationId,
    userMessageId: persisted.user.id,
    assistantMessageId: persisted.assistant.id,
  }).catch((error) => {
    console.warn(`chat memory enqueue failed: ${error?.message || error}`);
  });
}

export async function executeAmbient({
  mode,
  model,
  message,
  conversationId,
  attachments = [],
  historyMessages = [],
  memoryContext = null,
  contextDocument = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
  instructionsOverride = "",
  responseInstructionBlock = "",
  responseFormat = null,
  toolsEnabled = true,
  timeoutMs = defaultProviderTimeoutMs,
  persona = "jobs",
}) {
  const preparedAttachments = await prepareAmbientChatAttachments(attachments);
  const capability = preparedAttachments.some((attachment) => attachment.kind === "image")
    ? "vision_text"
    : chatModeConfig(mode).capability;
  const request = ambientChatRequest({
    mode,
    model,
    message,
    conversationId,
    attachments: preparedAttachments,
    historyMessages,
    contextDocument,
    memoryContext,
    taskContext,
    jobsEssence,
    deliveryContext,
    instructionsOverride,
    responseInstructionBlock,
    responseFormat,
    toolsEnabled,
    persona,
  });
  const result = await ambientChatCompletion({ body: request, capability, timeoutMs });
  if (!result.text) throw providerEmptyResponseError({ body: result.body, provider: "ambient", providerLabel: "Ambient", mode, model });

  return {
    provider: "ambient",
    model: result.model,
    responseId: result.id,
    text: result.text,
    usage: openRouterUsage(result.body, mode),
  };
}

export async function executeOpenAi(request = {}) {
  return executeAmbient(request);
}

async function streamAmbient({
  mode,
  model,
  message,
  conversationId,
  attachments = [],
  historyMessages = [],
  memoryContext = null,
  contextDocument = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
  persona = "jobs",
  instructionsOverride = "",
  onDelta,
  signal,
  timeoutMs = defaultProviderTimeoutMs,
}) {
  const preparedAttachments = await prepareAmbientChatAttachments(attachments);
  const capability = preparedAttachments.some((attachment) => attachment.kind === "image")
    ? "vision_text"
    : chatModeConfig(mode).capability;
  const request = ambientChatRequest({
    mode,
    model,
    message,
    conversationId,
    attachments: preparedAttachments,
    historyMessages,
    contextDocument,
    memoryContext,
    taskContext,
    jobsEssence,
    deliveryContext,
    instructionsOverride: instructionsOverride || chatInstructionsOverride({
      mode,
      contextDocument,
      memoryContext,
      taskContext,
      jobsEssence,
      deliveryContext,
      persona,
    }),
    persona,
  });
  const result = await ambientChatCompletionStream({ body: request, capability, signal, timeoutMs, onDelta });
  return {
    provider: "ambient",
    model: result.model,
    responseId: result.id,
    text: result.text,
    usage: result.usage
      ? openRouterUsage({ usage: result.usage }, mode)
      : fallbackUsage({ mode, message, text: result.text }),
  };
}

export async function resolveChatJobsContext({
  persona = "jobs",
  jobsEssence,
  message = "",
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  retrieve = jobsRetrievalForChat,
} = {}) {
  const normalizedPersona = normalizeChatPersona(persona);
  if (!normalizedPersona) {
    const error = new Error("unknown_chat_persona");
    error.status = 400;
    throw error;
  }
  if (!chatPersonaUsesJobsRetrieval(normalizedPersona)) {
    return {
      ok: true,
      text: "",
      chunks: [],
      skipped: true,
      reason: "selected_persona_excludes_jobs_retrieval",
    };
  }
  if (jobsEssence !== undefined) {
    return { ok: true, text: String(jobsEssence || ""), chunks: [] };
  }
  return retrieve({ message, contextDocument, memoryContext, taskContext });
}

export async function executeChat({
  accountId = "",
  mode,
  message,
  conversationId = "dev",
  attachments = [],
  contextDocument,
  memoryContext,
  taskContext,
  contextStatus,
  jobsEssence,
  clientHistory = [],
  ephemeralHistoryMessages = [],
  userMetadata = {},
  source = "",
  providerTimeoutMs = 0,
  persona = "jobs",
  iChingProfile = null,
  userMessageId = "",
  assistantMessageId = "",
}) {
  const normalizedPersona = normalizeChatPersona(persona);
  if (!normalizedPersona) {
    const error = new Error("unknown_chat_persona");
    error.status = 400;
    throw error;
  }
  const normalizedMode = chatPersonaIsModality(normalizedPersona) ? "Thinking" : normalizedChatMode(mode);
  if (!normalizedMode) throw unknownChatModeError(mode);
  const status = chatExecutionStatus(normalizedMode);

  if (!status.enabled) {
    const error = new Error(status.configured ? "chat_provider_disabled" : "chat_provider_not_configured");
    error.status = status.configured ? 503 : 409;
    error.provider = status.provider;
    throw error;
  }
  const timeoutMs = Number(providerTimeoutMs) > 0
    ? Math.min(Math.max(Math.floor(Number(providerTimeoutMs)), 5_000), 300_000)
    : chatProviderTimeoutMs({ mode: normalizedMode, provider: status.provider, source });
  const deliveryContext = chatDeliveryContext({ accountId, mode: normalizedMode, source });
  const anonymousHelp = !accountId && isHelpChatMode(normalizedMode);
  const anonymousHistoryMessages = anonymousHelp
    ? normalizeClientChatHistory(
        Array.isArray(ephemeralHistoryMessages) && ephemeralHistoryMessages.length > 0
          ? ephemeralHistoryMessages
          : clientHistory
      )
    : [];

  const [historyMessages, resolvedContextDocument, resolvedMemoryContext, resolvedTaskContext] = await Promise.all([
    anonymousHelp ? anonymousHistoryMessages : getChatMessagesForWrite({ accountId, conversationId }),
    anonymousHelp ? null : contextDocument === undefined ? chatContextDocumentForAccount(accountId) : contextDocument,
    anonymousHelp ? null : memoryContext === undefined ? chatMemoryContextForAccount(accountId) : memoryContext,
    anonymousHelp ? null : taskContext === undefined ? taskContextForAccount(accountId) : taskContext,
  ]);
  const jobsResult = await resolveChatJobsContext({
    persona: normalizedPersona,
    jobsEssence,
    message,
    contextDocument: resolvedContextDocument,
    memoryContext: resolvedMemoryContext,
    taskContext: resolvedTaskContext,
  });
  const resolvedJobsEssence = jobsResult.text;
  const resolvedContextStatus = buildChatContextStatus({
    contextDocument: resolvedContextDocument,
    memoryContext: resolvedMemoryContext,
    taskContext: resolvedTaskContext,
    contextDocumentStatus: contextStatus?.contextDocument,
    memoryStatus: contextStatus?.memory,
    taskStatus: contextStatus?.tasks,
    jobsRetrieval: jobsResult,
  });
  const replay = completedChatTurnReplay({
    messages: historyMessages,
    userMessageId,
    assistantMessageId,
    contextStatus: resolvedContextStatus,
    persona: normalizedPersona,
  });
  if (replay) return replay;
  const thinking = chatThinkingForJobsRetrieval({
    jobsResult,
    renderedContext: resolvedJobsEssence,
  });
  if (normalizedPersona === "i-ching" && !iChingProfile?.combined) {
    const error = new Error("i_ching_profile_required");
    error.status = 409;
    throw error;
  }
  const personaInstructions = normalizedPersona === "i-ching"
    ? taskNodeInstructions({
        message,
        contextDocument: resolvedContextDocument,
        memoryContext: resolvedMemoryContext,
        taskContext: resolvedTaskContext,
        jobsEssence: resolvedJobsEssence,
        deliveryContext,
        persona: normalizedPersona,
        iChingProfile: iChingProfilePromptPayload(iChingProfile),
      })
    : "";
  const result = await executeAmbient({
    mode: normalizedMode,
    model: status.model,
    message,
    conversationId,
    attachments,
    historyMessages,
    contextDocument: resolvedContextDocument,
    memoryContext: resolvedMemoryContext,
    taskContext: resolvedTaskContext,
    jobsEssence: resolvedJobsEssence,
    deliveryContext,
    persona: normalizedPersona,
    instructionsOverride: personaInstructions,
    timeoutMs,
  });

  if (!result.text) {
    const error = new Error("chat_provider_empty_response");
    error.status = 502;
    error.provider = status.provider;
    throw error;
  }

  const { assistantThinking, assistantMetadata } = assistantChatMetadata({
    thinking,
    responseGate: result.responseGate,
  });

  if (anonymousHelp) {
    const transient = transientChatTurn({
      conversationId,
      mode: normalizedMode,
      provider: result.provider,
      model: result.model,
      responseId: result.responseId,
      userMessage: message,
      assistantMessage: result.text,
      attachments,
      userMetadata: { ...userMetadata, chatPersona: normalizedPersona },
      assistantMetadata: { ...assistantMetadata, chatPersona: normalizedPersona },
    });
    return {
      ...result,
      ...transient,
      assistant: {
        ...transient.assistant,
        thinking: assistantThinking,
      },
      contextStatus: resolvedContextStatus,
      persona: normalizedPersona,
    };
  }

  const persisted = await appendChatTurn({
    accountId,
    conversationId,
    mode: normalizedMode,
    provider: result.provider,
    model: result.model,
    responseId: result.responseId,
    userMessage: message,
    assistantMessage: result.text,
    attachments,
    usage: result.usage,
    userMetadata: { ...userMetadata, chatPersona: normalizedPersona },
    assistantMetadata: { ...assistantMetadata, chatPersona: normalizedPersona },
    runMetadata: { contextStatus: resolvedContextStatus, chatPersona: normalizedPersona },
    userMessageId,
    assistantMessageId,
  });
  enqueueMemoryForTurn({ accountId, conversationId, persisted });

  return {
    ...result,
    ...persisted,
    assistant: {
      ...persisted.assistant,
      thinking: assistantThinking,
    },
    contextStatus: resolvedContextStatus,
    persona: normalizedPersona,
  };
}

export async function executeChatStream({
  accountId = "",
  mode,
  message,
  conversationId = "dev",
  attachments = [],
  contextDocument,
  memoryContext,
  taskContext,
  contextStatus,
  jobsEssence,
  clientHistory = [],
  ephemeralHistoryMessages = [],
  userMetadata = {},
  onDelta,
  signal,
  source = "",
  providerTimeoutMs = 0,
  persona = "jobs",
  iChingProfile = null,
  userMessageId = "",
  assistantMessageId = "",
}) {
  const normalizedPersona = normalizeChatPersona(persona);
  if (!normalizedPersona) {
    const error = new Error("unknown_chat_persona");
    error.status = 400;
    throw error;
  }
  const normalizedMode = chatPersonaIsModality(normalizedPersona) ? "Thinking" : normalizedChatMode(mode);
  if (!normalizedMode) throw unknownChatModeError(mode);
  const status = chatExecutionStatus(normalizedMode);

  if (!status.enabled) {
    const error = new Error(status.configured ? "chat_provider_disabled" : "chat_provider_not_configured");
    error.status = status.configured ? 503 : 409;
    error.provider = status.provider;
    throw error;
  }
  const timeoutMs = Number(providerTimeoutMs) > 0
    ? Math.min(Math.max(Math.floor(Number(providerTimeoutMs)), 5_000), 300_000)
    : chatProviderTimeoutMs({ mode: normalizedMode, provider: status.provider, source });
  const deliveryContext = chatDeliveryContext({ accountId, mode: normalizedMode, source });
  const anonymousHelp = !accountId && isHelpChatMode(normalizedMode);
  const anonymousHistoryMessages = anonymousHelp
    ? normalizeClientChatHistory(
        Array.isArray(ephemeralHistoryMessages) && ephemeralHistoryMessages.length > 0
          ? ephemeralHistoryMessages
          : clientHistory
      )
    : [];

  const [historyMessages, resolvedContextDocument, resolvedMemoryContext, resolvedTaskContext] = await Promise.all([
    anonymousHelp ? anonymousHistoryMessages : getChatMessagesForWrite({ accountId, conversationId }),
    anonymousHelp ? null : contextDocument === undefined ? chatContextDocumentForAccount(accountId) : contextDocument,
    anonymousHelp ? null : memoryContext === undefined ? chatMemoryContextForAccount(accountId) : memoryContext,
    anonymousHelp ? null : taskContext === undefined ? taskContextForAccount(accountId) : taskContext,
  ]);
  const jobsResult = await resolveChatJobsContext({
    persona: normalizedPersona,
    jobsEssence,
    message,
    contextDocument: resolvedContextDocument,
    memoryContext: resolvedMemoryContext,
    taskContext: resolvedTaskContext,
  });
  const resolvedJobsEssence = jobsResult.text;
  const resolvedContextStatus = buildChatContextStatus({
    contextDocument: resolvedContextDocument,
    memoryContext: resolvedMemoryContext,
    taskContext: resolvedTaskContext,
    contextDocumentStatus: contextStatus?.contextDocument,
    memoryStatus: contextStatus?.memory,
    taskStatus: contextStatus?.tasks,
    jobsRetrieval: jobsResult,
  });
  const replay = completedChatTurnReplay({
    messages: historyMessages,
    userMessageId,
    assistantMessageId,
    contextStatus: resolvedContextStatus,
    persona: normalizedPersona,
  });
  if (replay) return replay;
  const thinking = chatThinkingForJobsRetrieval({
    jobsResult,
    renderedContext: resolvedJobsEssence,
  });
  if (normalizedPersona === "i-ching" && !iChingProfile?.combined) {
    const error = new Error("i_ching_profile_required");
    error.status = 409;
    throw error;
  }
  const personaInstructions = normalizedPersona === "i-ching"
    ? taskNodeInstructions({
        message,
        contextDocument: resolvedContextDocument,
        memoryContext: resolvedMemoryContext,
        taskContext: resolvedTaskContext,
        jobsEssence: resolvedJobsEssence,
        deliveryContext,
        persona: normalizedPersona,
        iChingProfile: iChingProfilePromptPayload(iChingProfile),
      })
    : "";
  const result = await streamAmbient({
    mode: normalizedMode,
    model: status.model,
    message,
    conversationId,
    attachments,
    historyMessages,
    contextDocument: resolvedContextDocument,
    memoryContext: resolvedMemoryContext,
    taskContext: resolvedTaskContext,
    jobsEssence: resolvedJobsEssence,
    deliveryContext,
    persona: normalizedPersona,
    instructionsOverride: personaInstructions,
    onDelta,
    signal,
    timeoutMs,
  });

  if (!result.text) {
    const error = new Error("chat_provider_empty_response");
    error.status = 502;
    error.provider = status.provider;
    throw error;
  }

  const { assistantThinking, assistantMetadata } = assistantChatMetadata({
    thinking,
    responseGate: result.responseGate,
  });

  if (anonymousHelp) {
    const transient = transientChatTurn({
      conversationId,
      mode: normalizedMode,
      provider: result.provider,
      model: result.model,
      responseId: result.responseId,
      userMessage: message,
      assistantMessage: result.text,
      attachments,
      userMetadata: { ...userMetadata, chatPersona: normalizedPersona },
      assistantMetadata: { ...assistantMetadata, chatPersona: normalizedPersona },
    });
    return {
      ...result,
      ...transient,
      assistant: {
        ...transient.assistant,
        thinking: assistantThinking,
      },
      contextStatus: resolvedContextStatus,
      persona: normalizedPersona,
    };
  }

  const persisted = await appendChatTurn({
    accountId,
    conversationId,
    mode: normalizedMode,
    provider: result.provider,
    model: result.model,
    responseId: result.responseId,
    userMessage: message,
    assistantMessage: result.text,
    attachments,
    usage: result.usage,
    userMetadata: { ...userMetadata, chatPersona: normalizedPersona },
    assistantMetadata: { ...assistantMetadata, chatPersona: normalizedPersona },
    runMetadata: { contextStatus: resolvedContextStatus, chatPersona: normalizedPersona },
    userMessageId,
    assistantMessageId,
  });
  enqueueMemoryForTurn({ accountId, conversationId, persisted });

  return {
    ...result,
    ...persisted,
    assistant: {
      ...persisted.assistant,
      thinking: assistantThinking,
    },
    contextStatus: resolvedContextStatus,
    persona: normalizedPersona,
  };
}
