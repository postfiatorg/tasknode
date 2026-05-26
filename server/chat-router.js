import {
  appendChatTurn,
  getChatMessages,
} from "./repositories/chat-billing.js";
import { enqueueChatMemoryJob } from "./repositories/chat-memory.js";
import {
  chatMemoryContextForAccount,
  taskNodeInstructions,
} from "./chat-memory-context.js";
import { chatContextDocumentForAccount } from "./chat-account-context.js";
import { jobsRetrievalForChat } from "./jobs-corpus.js";
import { taskContextForAccount } from "./chat-task-context.js";
import {
  fallbackUsage,
  openAiUsage,
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
  openAiInput,
  openRouterMessages,
} from "./chat-provider-message-builders.js";
export {
  openAiInput,
  openRouterMessages,
} from "./chat-provider-message-builders.js";

const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const providerTimeoutMs = Number(process.env.CHAT_PROVIDER_TIMEOUT_MS || 45000);

export const chatModePrices = {
  "Private Instant": {
    inputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28,
    provider: "openrouter",
    defaultModel: "deepseek/deepseek-v4-flash",
    maxOutputTokens: 16384,
    disableReasoning: true,
    providerOrder: ["parasail", "siliconflow", "atlas-cloud", "deepinfra", "akashml", "novita"],
  },
  "Private Thinking": {
    inputUsdPerMillion: 1.74,
    outputUsdPerMillion: 3.48,
    provider: "openrouter",
    defaultModel: "deepseek/deepseek-v4-pro",
    maxOutputTokens: 4096,
    reasoningEffort: "high",
    providerOrder: ["novita", "atlas-cloud", "siliconflow", "deepinfra"],
  },
  "Frontier Instant": {
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    provider: "openai",
    defaultModel: "chat-latest",
    maxOutputTokens: 700,
    reasoningEffort: "medium",
  },
  "Frontier Thinking": {
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    provider: "openai",
    defaultModel: "gpt-5.5",
    maxOutputTokens: 4096,
    reasoningEffort: "high",
  },
};
export { effectiveDefaultChatMode, fallbackChatModeLabel };
export const defaultChatMode = fallbackChatModeLabel;

function hasOpenAi() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function hasOpenRouter() {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER);
}

export function chatProviderConfigured(provider) {
  if (provider === "openai") return hasOpenAi();
  if (provider === "openrouter") return hasOpenRouter();
  return false;
}

function chatProviderEnabled(provider) {
  if (provider === "openai") return hasOpenAi();
  if (provider === "openrouter") {
    const explicitlyDisabled =
      process.env.OPENROUTER_CHAT_ENABLED === "false" ||
      process.env.TASKNODE_ENABLE_OPENROUTER_CHAT === "false";
    return hasOpenRouter() && !explicitlyDisabled;
  }
  return false;
}

export function isKnownChatMode(mode) {
  return Object.hasOwn(chatModePrices, String(mode || "").trim());
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
  return isKnownChatMode(normalized) ? normalized : "";
}

export function modelForMode(mode) {
  const normalizedMode = normalizedChatMode(mode);
  const config = chatModeConfig(normalizedMode);
  const envPrefix = normalizedMode.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const modeSpecificModel = process.env[`CHAT_MODEL_${envPrefix}`];

  if (modeSpecificModel) return modeSpecificModel;
  if (normalizedMode === "Frontier Instant" || normalizedMode === "Frontier Thinking") {
    return config.defaultModel;
  }

  return (
    (config.provider === "openai" ? process.env.OPENAI_MODEL : process.env.OPENROUTER_MODEL) ||
    config.defaultModel
  );
}

export function chatExecutionStatus(mode) {
  const normalizedMode = normalizedChatMode(mode);
  const config = chatModeConfig(normalizedMode);
  const configured = chatProviderConfigured(config.provider);
  const enabled = chatProviderEnabled(config.provider);

  return {
    mode: normalizedMode,
    provider: config.provider,
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
  const costUsd =
    (inputTokens * config.inputUsdPerMillion) / 1_000_000 +
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

function openRouterPlugins(attachments = []) {
  if (!attachments.some((attachment) => attachment.kind === "pdf")) return undefined;

  return [
    {
      id: "file-parser",
      pdf: {
        engine: process.env.OPENROUTER_PDF_ENGINE || "cloudflare-ai",
      },
    },
  ];
}

function safeLogText(value = "", max = 600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function loggedUsage(usage = null) {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    promptTokens: Number(usage.prompt_tokens || usage.inputTokens || 0),
    completionTokens: Number(usage.completion_tokens || usage.outputTokens || 0),
    totalTokens: Number(usage.total_tokens || usage.totalTokens || 0),
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

function openRouterEmptyResponseError({
  body = null,
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
  error.provider = "openrouter";
  error.mode = mode;
  error.model = model;
  error.responseId = body?.id || responseId || null;
  error.responseModel = body?.model || responseModel || model;
  error.upstreamProvider = body?.provider || upstreamProvider || "";
  error.finishReason = choice.finish_reason || finishReason || "";
  error.usage = body?.usage || usage || null;
  error.providerMessage = `OpenRouter returned empty message content${
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
    }),
    provider: openRouterProviderPreferences({
      providerOrder: config.providerOrder || [],
      requireParameters: Boolean(reasoning),
    }),
    reasoning,
    max_tokens: config.maxOutputTokens,
    plugins: openRouterPlugins(normalizedAttachments),
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
  responseFormat = null,
  toolsEnabled = true,
}) {
  const config = chatModeConfig(mode);
  const tools = toolsEnabled ? openAiTools() : [];
  return {
    model,
    instructions: instructionsOverride || taskNodeInstructions({ contextDocument, memoryContext, taskContext, jobsEssence }),
    input: openAiInput({
      conversationId,
      message,
      attachments,
      historyMessages: instructionsOverride ? [] : historyMessages,
    }),
    max_output_tokens: config.maxOutputTokens,
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
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const error = new Error("provider_request_failed");
      error.status = response.status;
      error.providerMessage =
        body?.error?.message || body?.message || `Provider returned HTTP ${response.status}`;
      throw error;
    }

    return body;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("provider_timeout");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEventStream(url, options = {}, { signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);

  function abortFromParent() {
    controller.abort();
  }

  if (signal) {
    if (signal.aborted) controller.abort();
    signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const error = new Error("provider_request_failed");
      error.status = response.status;
      error.providerMessage =
        body?.error?.message || body?.message || text || `Provider returned HTTP ${response.status}`;
      throw error;
    }

    if (!response.body) {
      const error = new Error("provider_stream_unavailable");
      error.status = 502;
      throw error;
    }

    return response.body;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(signal?.aborted ? "client_aborted" : "provider_timeout");
      timeoutError.status = signal?.aborted ? 499 : 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function parseSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/);
  let event = "message";
  const data = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim() || "message";
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  return { event, data: data.join("\n") };
}

async function readEventStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n|\r\n\r\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed.data) await onEvent(parsed);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseBlock(buffer);
    if (parsed.data) await onEvent(parsed);
  }
}

function outputTextFromOpenAi(body) {
  if (typeof body?.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }

  const parts = [];
  for (const item of body?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function outputTextFromOpenRouter(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
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

export async function executeOpenAi({
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
  instructionsOverride = "",
  responseFormat = null,
  toolsEnabled = true,
}) {
  const baseUrl = (process.env.OPENAI_BASE_URL || defaultOpenAiBaseUrl).replace(/\/+$/, "");
  const request = {
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
    instructionsOverride,
    responseFormat,
    toolsEnabled,
  };
  const body = await fetchJson(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(openAiResponseRequest(request)),
  });
  const text = outputTextFromOpenAi(body);

  return {
    provider: "openai",
    model: body?.model || model,
    responseId: body?.id || null,
    text,
    usage: openAiUsage(body, mode),
  };
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
  onDelta,
  signal,
}) {
  const baseUrl = (process.env.OPENAI_BASE_URL || defaultOpenAiBaseUrl).replace(/\/+$/, "");
  const request = {
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
  };
  const stream = await fetchEventStream(
    `${baseUrl}/responses`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(openAiResponseRequest({ ...request, stream: true })),
    },
    { signal }
  );

  let text = "";
  let completedResponse = null;
  let responseId = null;
  let responseModel = model;

  await readEventStream(stream, async ({ data }) => {
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);

    if (event.type === "response.created" || event.type === "response.in_progress") {
      responseId = event.response?.id || responseId;
      responseModel = event.response?.model || responseModel;
      return;
    }

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      await onDelta?.(event.delta);
      return;
    }

    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      text = event.text;
      return;
    }

    if (event.type === "response.completed") {
      completedResponse = event.response || null;
      responseId = completedResponse?.id || responseId;
      responseModel = completedResponse?.model || responseModel;
      return;
    }

    if (event.type === "response.failed" || event.type === "error") {
      const error = new Error(event.error?.message || "provider_stream_failed");
      error.status = 502;
      throw error;
    }
  });

  const finalText = outputTextFromOpenAi(completedResponse) || text.trim();
  return {
    provider: "openai",
    model: responseModel,
    responseId,
    text: finalText,
    usage: completedResponse?.usage
      ? openAiUsage(completedResponse, mode)
      : fallbackUsage({ mode, message, text: finalText }),
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
}) {
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const request = {
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
  };
  const referer =
    process.env.OPENROUTER_REFERER ||
    process.env.TASKNODE_PUBLIC_URL ||
    process.env.VITE_SITE_ORIGIN ||
    "https://tasknodeofficial-dev.fly.dev";
  const title = process.env.OPENROUTER_TITLE || "Task Node Official";
  const body = await fetchJson(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY || process.env.OPENROUTER}`,
      "content-type": "application/json",
      "http-referer": referer,
      "x-title": title,
      "x-openrouter-title": title,
    },
    body: JSON.stringify(openRouterChatRequest(request)),
  });
  const text = outputTextFromOpenRouter(body);
  if (!text) {
    throw openRouterEmptyResponseError({ body, mode, model });
  }

  return {
    provider: "openrouter",
    model: body?.model || model,
    responseId: body?.id || null,
    text,
    usage: openRouterUsage(body, mode),
  };
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
  onDelta,
  signal,
}) {
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const request = {
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
  };
  const referer =
    process.env.OPENROUTER_REFERER ||
    process.env.TASKNODE_PUBLIC_URL ||
    process.env.VITE_SITE_ORIGIN ||
    "https://tasknodeofficial-dev.fly.dev";
  const title = process.env.OPENROUTER_TITLE || "Task Node Official";
  const stream = await fetchEventStream(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY || process.env.OPENROUTER}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "http-referer": referer,
        "x-title": title,
        "x-openrouter-title": title,
      },
      body: JSON.stringify(openRouterChatRequest({ ...request, stream: true })),
    },
    { signal }
  );

  let text = "";
  let responseId = null;
  let responseModel = model;
  let upstreamProvider = "";
  let finishReason = "";
  let usage = null;
  let rawUsage = null;

  await readEventStream(stream, async ({ data }) => {
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data);
    responseId = chunk.id || responseId;
    responseModel = chunk.model || responseModel;
    upstreamProvider = chunk.provider || upstreamProvider;
    if (chunk.usage) {
      rawUsage = chunk.usage;
      usage = openRouterUsage(chunk, mode);
    }

    const choice = chunk.choices?.[0] || {};
    finishReason = choice.finish_reason || finishReason;
    const delta = choice.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      await onDelta?.(delta);
    }

    if (chunk.error) {
      const error = new Error(chunk.error?.message || "provider_stream_failed");
      error.status = chunk.error?.code || 502;
      throw error;
    }
  });

  const finalText = text.trim();
  if (!finalText) {
    throw openRouterEmptyResponseError({
      mode,
      model,
      responseId,
      responseModel,
      upstreamProvider,
      finishReason,
      usage: rawUsage || usage,
    });
  }
  return {
    provider: "openrouter",
    model: responseModel,
    responseId,
    text: finalText,
    usage: usage || fallbackUsage({ mode, message, text: finalText }),
  };
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
}) {
  const normalizedMode = normalizedChatMode(mode);
  if (!normalizedMode) throw unknownChatModeError(mode);
  const status = chatExecutionStatus(normalizedMode);

  if (!status.enabled) {
    const error = new Error(status.configured ? "chat_provider_disabled" : "chat_provider_not_configured");
    error.status = status.configured ? 503 : 409;
    error.provider = status.provider;
    throw error;
  }

  const [historyMessages, resolvedContextDocument, resolvedMemoryContext, resolvedTaskContext] = await Promise.all([
    getChatMessages({ accountId, conversationId }),
    contextDocument === undefined ? chatContextDocumentForAccount(accountId) : contextDocument,
    memoryContext === undefined ? chatMemoryContextForAccount(accountId) : memoryContext,
    taskContext === undefined ? taskContextForAccount(accountId) : taskContext,
  ]);
  const jobsResult = jobsEssence === undefined
    ? await jobsRetrievalForChat({
        message,
        contextDocument: resolvedContextDocument,
        memoryContext: resolvedMemoryContext,
        taskContext: resolvedTaskContext,
      })
    : { ok: true, text: jobsEssence, chunks: [] };
  const resolvedJobsEssence = jobsEssence === undefined ? jobsResult.text : jobsEssence;
  const resolvedContextStatus = buildChatContextStatus({
    contextDocument: resolvedContextDocument,
    memoryContext: resolvedMemoryContext,
    taskContext: resolvedTaskContext,
    contextDocumentStatus: contextStatus?.contextDocument,
    memoryStatus: contextStatus?.memory,
    taskStatus: contextStatus?.tasks,
    jobsRetrieval: jobsResult,
  });
  const result =
    status.provider === "openai"
      ? await executeOpenAi({
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
        })
      : await executeOpenRouter({
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
        });

  if (!result.text) {
    const error = new Error("chat_provider_empty_response");
    error.status = 502;
    error.provider = status.provider;
    throw error;
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
    runMetadata: { contextStatus: resolvedContextStatus },
  });
  enqueueMemoryForTurn({ accountId, conversationId, persisted });

  return {
    ...result,
    ...persisted,
    contextStatus: resolvedContextStatus,
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
  onDelta,
  signal,
}) {
  const normalizedMode = normalizedChatMode(mode);
  if (!normalizedMode) throw unknownChatModeError(mode);
  const status = chatExecutionStatus(normalizedMode);

  if (!status.enabled) {
    const error = new Error(status.configured ? "chat_provider_disabled" : "chat_provider_not_configured");
    error.status = status.configured ? 503 : 409;
    error.provider = status.provider;
    throw error;
  }

  const [historyMessages, resolvedContextDocument, resolvedMemoryContext, resolvedTaskContext] = await Promise.all([
    getChatMessages({ accountId, conversationId }),
    contextDocument === undefined ? chatContextDocumentForAccount(accountId) : contextDocument,
    memoryContext === undefined ? chatMemoryContextForAccount(accountId) : memoryContext,
    taskContext === undefined ? taskContextForAccount(accountId) : taskContext,
  ]);
  const jobsResult = jobsEssence === undefined
    ? await jobsRetrievalForChat({
        message,
        contextDocument: resolvedContextDocument,
        memoryContext: resolvedMemoryContext,
        taskContext: resolvedTaskContext,
      })
    : { ok: true, text: jobsEssence, chunks: [] };
  const resolvedJobsEssence = jobsEssence === undefined ? jobsResult.text : jobsEssence;
  const resolvedContextStatus = buildChatContextStatus({
    contextDocument: resolvedContextDocument,
    memoryContext: resolvedMemoryContext,
    taskContext: resolvedTaskContext,
    contextDocumentStatus: contextStatus?.contextDocument,
    memoryStatus: contextStatus?.memory,
    taskStatus: contextStatus?.tasks,
    jobsRetrieval: jobsResult,
  });
  const result =
    status.provider === "openai"
      ? await streamOpenAi({
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
          onDelta,
          signal,
        })
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
          onDelta,
          signal,
        });

  if (!result.text) {
    const error = new Error("chat_provider_empty_response");
    error.status = 502;
    error.provider = status.provider;
    throw error;
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
    runMetadata: { contextStatus: resolvedContextStatus },
  });
  enqueueMemoryForTurn({ accountId, conversationId, persisted });

  return {
    ...result,
    ...persisted,
    contextStatus: resolvedContextStatus,
  };
}
