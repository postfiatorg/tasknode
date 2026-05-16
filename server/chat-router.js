import { appendChatTurn, getChatMessages } from "./runtime-store.js";

const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const providerTimeoutMs = Number(process.env.CHAT_PROVIDER_TIMEOUT_MS || 45000);
const maxChatAttachments = 4;
const maxAttachmentDataUrlBytes = 6 * 1024 * 1024;
const webSearchUsdPerCall = 0.01;

export const chatModePrices = {
  "Private Instant": {
    inputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28,
    provider: "openrouter",
    defaultModel: "deepseek/deepseek-v4-flash",
    maxOutputTokens: 700,
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

export function anyChatProviderEnabled() {
  return Object.values(chatModePrices).some((mode) => chatProviderEnabled(mode.provider));
}

export function chatModeConfig(mode) {
  return chatModePrices[mode] || chatModePrices["Private Instant"];
}

export function normalizedChatMode(mode) {
  return chatModePrices[mode] ? mode : "Private Instant";
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

function taskNodeInstructions() {
  return [
    "You are Task Node, a concise execution assistant for Post Fiat.",
    "Help the user clarify goals, plan useful work, and move toward high-quality personal task execution.",
    "Do not claim wallet, payment, task reward, or production account actions are complete unless the app has actually done them.",
    "Keep answers direct and practical. Ask a short clarifying question only when the next action is genuinely ambiguous.",
  ].join("\n");
}

function recentTranscript(conversationId, currentMessage) {
  const history = getChatMessages(conversationId)
    .slice(-12)
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.body}`)
    .join("\n");

  if (!history) return currentMessage;
  return `Recent conversation:\n${history}\n\nUser: ${currentMessage}`;
}

function chatAttachmentType(mimeType = "") {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/csv"
  ) {
    return "text";
  }
  return "file";
}

export function normalizeChatAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];

  return attachments
    .slice(0, maxChatAttachments)
    .map((attachment) => {
      const dataUrl = typeof attachment?.dataUrl === "string" ? attachment.dataUrl.trim() : "";
      if (!dataUrl.startsWith("data:") || dataUrl.length > maxAttachmentDataUrlBytes) return null;

      const mimeType = String(attachment?.mimeType || attachment?.type || "")
        .trim()
        .toLowerCase()
        .slice(0, 120);
      const name = String(attachment?.name || "attachment")
        .trim()
        .replace(/[^\w.\- ()[\]]+/g, "_")
        .slice(0, 160) || "attachment";
      const size = Math.max(0, Number(attachment?.size || 0));

      return {
        name,
        mimeType,
        size,
        dataUrl,
        kind: chatAttachmentType(mimeType),
      };
    })
    .filter(Boolean);
}

export function shouldUseWebSearch(message = "") {
  const text = String(message || "").toLowerCase();
  const currentInfoSignals = [
    "search",
    "look up",
    "web",
    "internet",
    "today",
    "current",
    "currently",
    "latest",
    "recent",
    "right now",
    "news",
    "what is going on",
    "what's going on",
  ];

  return currentInfoSignals.some((signal) => text.includes(signal));
}

function openAiTools({ message }) {
  if (!shouldUseWebSearch(message)) return [];

  return [
    {
      type: "web_search",
      search_context_size: process.env.OPENAI_WEB_SEARCH_CONTEXT_SIZE || "low",
    },
  ];
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

function decodeTextDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!match) return "";

  try {
    return Buffer.from(match[2], "base64").toString("utf8").replace(/\u0000/g, "").trim();
  } catch {
    return "";
  }
}

function openRouterAttachmentPart(attachment) {
  if (attachment.kind === "image") {
    return {
      type: "image_url",
      image_url: {
        url: attachment.dataUrl,
      },
    };
  }

  if (attachment.kind === "text") {
    const text = decodeTextDataUrl(attachment.dataUrl);
    return {
      type: "text",
      text: [
        `Attached file: ${attachment.name}`,
        text ? text.slice(0, 40_000) : "[The attached text file could not be decoded.]",
      ].join("\n\n"),
    };
  }

  return {
    type: "file",
    file: {
      filename: attachment.name,
      file_data: attachment.dataUrl,
    },
  };
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

export function openRouterMessages({ conversationId, message, attachments = [] }) {
  const normalizedAttachments = normalizeChatAttachments(attachments);
  const history = getChatMessages(conversationId)
    .slice(-12)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.body,
    }));
  const userContent =
    normalizedAttachments.length === 0
      ? message
      : [
          { type: "text", text: message },
          ...normalizedAttachments.map((attachment) => openRouterAttachmentPart(attachment)),
        ];

  return [
    { role: "system", content: taskNodeInstructions() },
    ...history,
    { role: "user", content: userContent },
  ];
}

export function openRouterChatRequest({
  mode,
  model,
  message,
  conversationId,
  attachments = [],
  stream = false,
}) {
  const config = chatModeConfig(mode);
  const normalizedAttachments = normalizeChatAttachments(attachments);

  return {
    model,
    messages: openRouterMessages({
      conversationId,
      message,
      attachments: normalizedAttachments,
    }),
    provider: openRouterProviderPreferences({
      providerOrder: config.providerOrder || [],
      requireParameters: Boolean(config.reasoningEffort),
    }),
    reasoning: config.reasoningEffort
      ? {
          effort: config.reasoningEffort,
          exclude: true,
        }
      : undefined,
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

export function openAiInput({ conversationId, message, attachments = [] }) {
  const content = [
    {
      type: "input_text",
      text: recentTranscript(conversationId, message),
    },
  ];

  for (const attachment of normalizeChatAttachments(attachments)) {
    if (attachment.kind === "image") {
      content.push({
        type: "input_image",
        image_url: attachment.dataUrl,
        detail: "auto",
      });
      continue;
    }

    content.push({
      type: "input_file",
      filename: attachment.name,
      file_data: attachment.dataUrl,
    });
  }

  return [{ role: "user", content }];
}

export function openAiResponseRequest({ mode, model, message, conversationId, attachments = [], stream = false }) {
  const config = chatModeConfig(mode);
  const tools = openAiTools({ message });
  return {
    model,
    instructions: taskNodeInstructions(),
    input: openAiInput({ conversationId, message, attachments }),
    max_output_tokens: config.maxOutputTokens,
    reasoning: config.reasoningEffort ? { effort: config.reasoningEffort } : undefined,
    stream: stream || undefined,
    store: false,
    tool_choice: tools.length > 0 ? "auto" : undefined,
    tools,
    max_tool_calls: tools.length > 0 ? 4 : undefined,
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

function countOpenAiOutputItems(body, type) {
  return (body?.output || []).filter((item) => item?.type === type).length;
}

function openAiUsage(body, mode) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const webSearchCalls = countOpenAiOutputItems(body, "web_search_call");
  const tokenCostUsd = actualChatCost(mode, { inputTokens, outputTokens });
  const toolCostUsd = Number((webSearchCalls * webSearchUsdPerCall).toFixed(6));
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens || inputTokens + outputTokens),
    webSearchCalls,
    toolCostUsd,
    costUsd: Number((tokenCostUsd + toolCostUsd).toFixed(6)),
  };
}

function openRouterUsage(body, mode) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const providerCost = Number(usage.cost || 0);
  const webSearchCalls = Number(usage.server_tool_use?.web_search_requests || 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens || inputTokens + outputTokens),
    webSearchCalls,
    toolCostUsd: 0,
    costUsd: Number(
      (providerCost || actualChatCost(mode, { inputTokens, outputTokens })).toFixed(6)
    ),
  };
}

function fallbackUsage({ mode, message, text }) {
  const inputTokens = Math.max(1, Math.ceil(String(message || "").length / 4));
  const outputTokens = Math.max(1, Math.ceil(String(text || "").length / 4));

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: actualChatCost(mode, { inputTokens, outputTokens }),
    estimated: true,
  };
}

async function executeOpenAi({ mode, model, message, conversationId, attachments = [] }) {
  const baseUrl = (process.env.OPENAI_BASE_URL || defaultOpenAiBaseUrl).replace(/\/+$/, "");
  const body = await fetchJson(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(openAiResponseRequest({ mode, model, message, conversationId, attachments })),
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

async function streamOpenAi({ mode, model, message, conversationId, attachments = [], onDelta, signal }) {
  const baseUrl = (process.env.OPENAI_BASE_URL || defaultOpenAiBaseUrl).replace(/\/+$/, "");
  const stream = await fetchEventStream(
    `${baseUrl}/responses`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(openAiResponseRequest({
        mode,
        model,
        message,
        conversationId,
        attachments,
        stream: true,
      })),
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

async function executeOpenRouter({ mode, model, message, conversationId, attachments = [] }) {
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
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
    body: JSON.stringify(openRouterChatRequest({ mode, model, message, conversationId, attachments })),
  });
  const text = outputTextFromOpenRouter(body);

  return {
    provider: "openrouter",
    model: body?.model || model,
    responseId: body?.id || null,
    text,
    usage: openRouterUsage(body, mode),
  };
}

async function streamOpenRouter({ mode, model, message, conversationId, attachments = [], onDelta, signal }) {
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
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
      body: JSON.stringify(openRouterChatRequest({
        mode,
        model,
        message,
        conversationId,
        attachments,
        stream: true,
      })),
    },
    { signal }
  );

  let text = "";
  let responseId = null;
  let responseModel = model;
  let usage = null;

  await readEventStream(stream, async ({ data }) => {
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data);
    responseId = chunk.id || responseId;
    responseModel = chunk.model || responseModel;
    if (chunk.usage) usage = openRouterUsage(chunk, mode);

    const delta = chunk.choices?.[0]?.delta?.content;
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
  return {
    provider: "openrouter",
    model: responseModel,
    responseId,
    text: finalText,
    usage: usage || fallbackUsage({ mode, message, text: finalText }),
  };
}

export async function executeChat({ accountId = "", mode, message, conversationId = "dev", attachments = [] }) {
  const normalizedMode = normalizedChatMode(mode);
  const status = chatExecutionStatus(normalizedMode);

  if (!status.enabled) {
    const error = new Error(status.configured ? "chat_provider_disabled" : "chat_provider_not_configured");
    error.status = status.configured ? 503 : 409;
    error.provider = status.provider;
    throw error;
  }

  const result =
    status.provider === "openai"
      ? await executeOpenAi({ mode: normalizedMode, model: status.model, message, conversationId, attachments })
      : await executeOpenRouter({
          mode: normalizedMode,
          model: status.model,
          message,
          conversationId,
          attachments,
        });

  if (!result.text) {
    const error = new Error("chat_provider_empty_response");
    error.status = 502;
    error.provider = status.provider;
    throw error;
  }

  const persisted = appendChatTurn({
    accountId,
    conversationId,
    mode: normalizedMode,
    provider: result.provider,
    model: result.model,
    responseId: result.responseId,
    userMessage: message,
    assistantMessage: result.text,
    usage: result.usage,
  });

  return {
    ...result,
    ...persisted,
  };
}

export async function executeChatStream({
  accountId = "",
  mode,
  message,
  conversationId = "dev",
  attachments = [],
  onDelta,
  signal,
}) {
  const normalizedMode = normalizedChatMode(mode);
  const status = chatExecutionStatus(normalizedMode);

  if (!status.enabled) {
    const error = new Error(status.configured ? "chat_provider_disabled" : "chat_provider_not_configured");
    error.status = status.configured ? 503 : 409;
    error.provider = status.provider;
    throw error;
  }

  const result =
    status.provider === "openai"
      ? await streamOpenAi({
          mode: normalizedMode,
          model: status.model,
          message,
          conversationId,
          attachments,
          onDelta,
          signal,
        })
      : await streamOpenRouter({
          mode: normalizedMode,
          model: status.model,
          message,
          conversationId,
          attachments,
          onDelta,
          signal,
        });

  if (!result.text) {
    const error = new Error("chat_provider_empty_response");
    error.status = 502;
    error.provider = status.provider;
    throw error;
  }

  const persisted = appendChatTurn({
    accountId,
    conversationId,
    mode: normalizedMode,
    provider: result.provider,
    model: result.model,
    responseId: result.responseId,
    userMessage: message,
    assistantMessage: result.text,
    usage: result.usage,
  });

  return {
    ...result,
    ...persisted,
  };
}
