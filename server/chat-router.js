import { randomUUID } from "node:crypto";
import {
  appendChatTurn,
  getChatMessages,
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
import { effectiveDefaultChatMode, fallbackChatModeLabel } from "./chat-mode-defaults.js";
import {
  maxOpenAiWebSearchToolCalls,
  openAiTools,
  webSearchUsdPerCall,
} from "./chat-search-tools.js";
export {
  chatInputCharacterEstimate,
  normalizeChatAttachments,
} from "./chat-attachment-utils.js";
import { normalizeChatAttachments } from "./chat-attachment-utils.js";
import { buildChatContextStatus } from "./chat-context-status.js";
import {
  deepSeekMessages,
  openAiInput,
  openRouterMessages,
} from "./chat-provider-message-builders.js";
import { helpModeInstructions, isHelpChatMode } from "./chat-help-mode.js";
import {
  AMBIENT_MODELS,
  ambientChatCompletion,
  ambientChatCompletionStream,
  ambientConfigured,
  resolveAmbientModel,
} from "./ambient-inference.js";
import { prepareAmbientChatAttachments } from "./ambient-attachments.js";
import { iChingProfilePromptPayload } from "./repositories/i-ching-profile.js";
import {
  chatPersonaIsModality,
  chatPersonaUsesJobsRetrieval,
  normalizeChatPersona,
} from "../shared/chat-personas.js";
export {
  deepSeekMessages,
  openAiInput,
  openRouterMessages,
} from "./chat-provider-message-builders.js";

const defaultProviderTimeoutMs = 45_000;
const defaultThinkingProviderTimeoutMs = 300_000;
export const chatModePrices = {
  Instant: {
    inputUsdPerMillion: 0.063,
    inputCacheHitUsdPerMillion: 0.0126,
    outputUsdPerMillion: 0.126,
    provider: "ambient",
    providerLabel: "Ambient",
    capability: "fast_text",
    defaultModel: AMBIENT_MODELS.fastText,
    maxOutputTokens: 16384,
    disableReasoning: true,
  },
  Thinking: {
    inputUsdPerMillion: 0.4725,
    inputCacheHitUsdPerMillion: 0.09,
    outputUsdPerMillion: 1.98,
    provider: "ambient",
    providerLabel: "Ambient",
    capability: "reasoning_text",
    defaultModel: AMBIENT_MODELS.reasoningText,
    maxOutputTokens: 4096,
    reasoningEffort: "xhigh",
  },
  "Help": {
    inputUsdPerMillion: 0.063,
    inputCacheHitUsdPerMillion: 0.0126,
    outputUsdPerMillion: 0.126,
    provider: "ambient",
    providerLabel: "Ambient",
    capability: "fast_text",
    defaultModel: AMBIENT_MODELS.fastText,
    maxOutputTokens: 1200,
    estimatedOutputTokens: 1200,
  },
};

const deprecatedChatModeAliases = Object.freeze({
  "Private Instant": "Instant",
  "Frontier Instant": "Instant",
  "Private Thinking": "Thinking",
  "Discount Thinking": "Thinking",
  "Frontier Thinking": "Thinking",
});
export { effectiveDefaultChatMode, fallbackChatModeLabel };
export const defaultChatMode = fallbackChatModeLabel;

export function chatProviderConfigured(provider) {
  if (provider === "ambient") return ambientConfigured();
  return false;
}

function timeoutFromEnv(names = [], fallback = defaultProviderTimeoutMs) {
  for (const name of names) {
    const parsed = Number(process.env[name]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.max(Math.floor(parsed), 5_000), 300_000);
    }
  }
  return Math.min(Math.max(Math.floor(Number(fallback) || defaultProviderTimeoutMs), 5_000), 300_000);
}

export function chatProviderTimeoutMs({ mode = "", provider = "", source = "" } = {}) {
  const normalizedMode = normalizedChatMode(mode) || String(mode || "").trim();
  void provider;
  void source;
  if (normalizedMode === "Thinking") {
    return timeoutFromEnv(
      [
        normalizedMode === "Help" ? "CHAT_PROVIDER_HELP_TIMEOUT_MS" : "",
        "CHAT_PROVIDER_AMBIENT_THINKING_TIMEOUT_MS",
        "CHAT_PROVIDER_THINKING_TIMEOUT_MS",
        "CHAT_PROVIDER_TIMEOUT_MS",
      ].filter(Boolean),
      defaultThinkingProviderTimeoutMs
    );
  }
  return timeoutFromEnv(["CHAT_PROVIDER_TIMEOUT_MS"], defaultProviderTimeoutMs);
}

function chatProviderEnabled(provider) {
  if (provider === "ambient") return ambientConfigured() && process.env.AMBIENT_CHAT_ENABLED !== "false";
  return false;
}

export function isKnownChatMode(mode) {
  const normalized = String(mode || "").trim();
  const canonical = deprecatedChatModeAliases[normalized] || normalized;
  return Object.hasOwn(chatModePrices, canonical);
}

function unknownChatModeError(mode) {
  const error = new Error("unknown_chat_mode");
  error.status = 400;
  error.mode = mode;
  return error;
}

export function anyChatProviderEnabled() {
  return Object.values(chatModePrices).some((mode) => chatProviderEnabled(mode.provider));
}

export function chatModeConfig(mode) {
  const normalizedMode = normalizedChatMode(mode);
  if (!normalizedMode) throw unknownChatModeError(mode);
  return chatModePrices[normalizedMode];
}

export function normalizedChatMode(mode) {
  const normalized = String(mode || "").trim();
  if (!normalized) return effectiveDefaultChatMode();
  const canonical = deprecatedChatModeAliases[normalized] || normalized;
  return Object.hasOwn(chatModePrices, canonical) ? canonical : "";
}

export function modelForMode(mode) {
  const normalizedMode = normalizedChatMode(mode);
  const config = chatModeConfig(normalizedMode);
  return resolveAmbientModel({
    model: config.defaultModel,
    capability: config.capability,
  });
}

export function chatExecutionStatus(mode) {
  const normalizedMode = normalizedChatMode(mode);
  const config = chatModeConfig(normalizedMode);
  const configured = chatProviderConfigured(config.provider);
  const enabled = chatProviderEnabled(config.provider);

  return {
    mode: normalizedMode,
    provider: config.provider,
    providerLabel: config.providerLabel || config.provider,
    model: modelForMode(normalizedMode),
    configured,
    enabled,
    status: enabled ? "ready" : configured ? "disabled" : "missing_config",
  };
}

export function actualChatCost(mode, usage) {
  const config = chatModeConfig(mode);
  const inputTokens = Number(usage?.inputTokens || 0);
  const outputTokens = Number(usage?.outputTokens || 0);
  const promptCacheHitTokens = Math.max(0, Number(usage?.promptCacheHitTokens || 0));
  const promptCacheMissTokens = Math.max(
    0,
    Number(
      usage?.promptCacheMissTokens ||
        (promptCacheHitTokens > 0 ? Math.max(0, inputTokens - promptCacheHitTokens) : 0)
    )
  );
  const uncachedInputTokens = promptCacheHitTokens || promptCacheMissTokens
    ? promptCacheMissTokens
    : inputTokens;
  const cachedInputCostUsd = promptCacheHitTokens && config.inputCacheHitUsdPerMillion
    ? (promptCacheHitTokens * config.inputCacheHitUsdPerMillion) / 1_000_000
    : 0;
  const costUsd =
    (uncachedInputTokens * config.inputUsdPerMillion) / 1_000_000 +
    cachedInputCostUsd +
    (outputTokens * config.outputUsdPerMillion) / 1_000_000;

  return Number(costUsd.toFixed(6));
}

function openRouterProviderPreferences({ providerOrder = [], requireParameters = false } = {}) {
  const provider = {
    zdr: true,
    data_collection: "deny",
  };

  if (requireParameters) provider.require_parameters = true;
  if (providerOrder.length > 0) {
    provider.order = providerOrder;
    provider.only = providerOrder;
  }
  return provider;
}

function openRouterReasoningConfig(config = {}) {
  if (config.reasoningEffort) {
    return {
      effort: config.reasoningEffort,
      exclude: true,
    };
  }

  if (config.disableReasoning) {
    return {
      effort: "none",
      exclude: true,
    };
  }

  return undefined;
}

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

function isRecoverableStreamTermination(error) {
  const message = String(error?.message || "").toLowerCase();
  const causeCode = String(error?.cause?.code || error?.code || "").toLowerCase();
  return (
    !error?.status &&
    (
      message === "terminated" ||
      message === "fetch failed" ||
      message.includes("socket") ||
      message.includes("premature close") ||
      causeCode.includes("und_err_socket")
    )
  );
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

export function openRouterChatRequest({
  mode,
  model,
  message,
  conversationId,
  attachments = [],
  stream = false,
  historyMessages = null,
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
  instructionsOverride = "",
  persona = "jobs",
}) {
  const config = chatModeConfig(mode);
  const normalizedAttachments = normalizeChatAttachments(attachments);
  const reasoning = openRouterReasoningConfig(config);

  return {
    model,
    messages: openRouterMessages({
      conversationId,
      message,
      attachments: normalizedAttachments,
      historyMessages,
      contextDocument,
      memoryContext,
      taskContext,
      jobsEssence,
      deliveryContext,
      instructionsOverride,
      persona,
    }),
    provider: openRouterProviderPreferences({
      providerOrder: config.providerOrder || [],
      requireParameters: Boolean(reasoning),
    }),
    reasoning,
    max_tokens: config.maxOutputTokens,
    stream: stream || undefined,
    stream_options: stream
      ? {
          include_usage: true,
        }
      : undefined,
    usage: stream
      ? undefined
      : {
          include: true,
        },
  };
}

export function openAiResponseRequest({
  mode,
  model,
  message,
  conversationId,
  attachments = [],
  stream = false,
  historyMessages = null,
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  jobsEssence = "",
  instructionsOverride = "",
  responseInstructionBlock = "",
  responseFormat = null,
  toolsEnabled = true,
  deliveryContext = null,
  persona = "jobs",
}) {
  const config = chatModeConfig(mode);
  const tools = toolsEnabled ? openAiTools() : [];
  const instructions = [
    instructionsOverride || taskNodeInstructions({ message, contextDocument, memoryContext, taskContext, jobsEssence, deliveryContext, persona }),
    responseInstructionBlock,
  ].filter(Boolean).join("\n\n");
  const request = {
    model,
    instructions,
    input: openAiInput({
      conversationId,
      message,
      attachments,
      historyMessages,
    }),
    reasoning: config.reasoningEffort ? { effort: config.reasoningEffort } : undefined,
    text: responseFormat ? { format: responseFormat } : undefined,
    stream: stream || undefined,
    store: false,
    tool_choice: tools.length > 0 ? "auto" : undefined,
    tools,
    max_tool_calls: tools.length > 0 ? maxOpenAiWebSearchToolCalls : undefined,
    metadata: {
      app: "tasknodeofficial",
      mode,
    },
  };
  const maxOutputTokens = Number(config.maxOutputTokens || 0);
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    request.max_output_tokens = maxOutputTokens;
  }
  return request;
}

export function deepSeekChatRequest({
  mode,
  model,
  message,
  conversationId,
  attachments = [],
  stream = false,
  historyMessages = null,
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
  instructionsOverride = "",
  persona = "jobs",
}) {
  const config = chatModeConfig(mode);
  const request = {
    model,
    messages: deepSeekMessages({
      conversationId,
      message,
      attachments,
      historyMessages,
      contextDocument,
      memoryContext,
      taskContext,
      jobsEssence,
      deliveryContext,
      instructionsOverride,
      persona,
    }),
    thinking: config.reasoningEffort ? { type: "enabled" } : { type: "disabled" },
    reasoning_effort: config.reasoningEffort || undefined,
    stream: stream || undefined,
    stream_options: stream
      ? {
          include_usage: true,
        }
      : undefined,
  };
  const maxOutputTokens = Number(config.maxOutputTokens || 0);
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    request.max_tokens = maxOutputTokens;
  }
  return request;
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

async function streamOpenAi({
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

async function executeOpenRouter({
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
  timeoutMs = defaultProviderTimeoutMs,
}) {
  return executeAmbient({
    mode,
    model,
    message,
    conversationId,
    attachments,
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
    timeoutMs,
  });
}

async function executeDeepSeek({
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
  timeoutMs = defaultProviderTimeoutMs,
}) {
  return executeAmbient({
    mode,
    model,
    message,
    conversationId,
    attachments,
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
    timeoutMs,
  });
}

async function streamOpenRouter({
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
  return streamOpenAi({
    mode,
    model,
    message,
    conversationId,
    attachments,
    historyMessages,
    contextDocument,
    memoryContext,
    taskContext,
    jobsEssence,
    deliveryContext,
    persona,
    instructionsOverride,
    onDelta,
    signal,
    timeoutMs,
  });
}

async function streamDeepSeek({
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
  return streamOpenAi({
    mode,
    model,
    message,
    conversationId,
    attachments,
    historyMessages,
    contextDocument,
    memoryContext,
    taskContext,
    jobsEssence,
    deliveryContext,
    persona,
    instructionsOverride,
    onDelta,
    signal,
    timeoutMs,
  });
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
  const result =
    status.provider === "deepseek"
        ? await (async () => {
            let emittedVisibleDelta = false;
            const trackDelta = async (delta) => {
              emittedVisibleDelta = emittedVisibleDelta || Boolean(String(delta || ""));
              await onDelta?.(delta);
            };
            try {
              return await streamDeepSeek({
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
                onDelta: trackDelta,
                signal,
                timeoutMs,
              });
            } catch (error) {
              if (emittedVisibleDelta || signal?.aborted || !isRecoverableStreamTermination(error)) throw error;
              console.warn("chat_provider_stream_fallback", {
                mode: normalizedMode,
                provider: status.provider,
                model: status.model,
                error: safeLogText(error?.message || "stream_terminated", 160),
              });
              return executeDeepSeek({
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
            }
          })()
        : await streamOpenRouter({
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
