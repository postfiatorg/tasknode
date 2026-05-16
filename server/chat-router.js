import { appendChatTurn, getChatMessages } from "./runtime-store.js";

const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const providerTimeoutMs = Number(process.env.CHAT_PROVIDER_TIMEOUT_MS || 45000);

export const chatModePrices = {
  "Private Instant": {
    inputUsdPerMillion: 0.8,
    outputUsdPerMillion: 1.6,
    provider: "openrouter",
    defaultModel: "openrouter/auto",
    maxOutputTokens: 700,
  },
  "Private Thinking": {
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 8,
    provider: "openrouter",
    defaultModel: "openrouter/auto",
    maxOutputTokens: 1400,
  },
  "Frontier Instant": {
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 10,
    provider: "openai",
    defaultModel: "gpt-5.5",
    maxOutputTokens: 700,
    reasoningEffort: "low",
  },
  "Frontier Thinking": {
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    provider: "openai",
    defaultModel: "gpt-5.5",
    maxOutputTokens: 1400,
    reasoningEffort: "medium",
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
    return (
      hasOpenRouter() &&
      (process.env.OPENROUTER_CHAT_ENABLED === "true" ||
        process.env.TASKNODE_ENABLE_OPENROUTER_CHAT === "true")
    );
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
  const config = chatModeConfig(mode);
  const envPrefix = normalizedChatMode(mode).toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  return (
    process.env[`CHAT_MODEL_${envPrefix}`] ||
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

function openAiUsage(body, mode) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens || inputTokens + outputTokens),
    costUsd: actualChatCost(mode, { inputTokens, outputTokens }),
  };
}

function openRouterUsage(body, mode) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.prompt_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || 0);
  const providerCost = Number(usage.cost || 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens || inputTokens + outputTokens),
    costUsd: Number((providerCost || actualChatCost(mode, { inputTokens, outputTokens })).toFixed(6)),
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

async function executeOpenAi({ mode, model, message, conversationId }) {
  const config = chatModeConfig(mode);
  const baseUrl = (process.env.OPENAI_BASE_URL || defaultOpenAiBaseUrl).replace(/\/+$/, "");
  const body = await fetchJson(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: taskNodeInstructions(),
      input: recentTranscript(conversationId, message),
      max_output_tokens: config.maxOutputTokens,
      reasoning: config.reasoningEffort ? { effort: config.reasoningEffort } : undefined,
      store: false,
      metadata: {
        app: "tasknodeofficial",
        mode,
      },
    }),
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

async function streamOpenAi({ mode, model, message, conversationId, onDelta, signal }) {
  const config = chatModeConfig(mode);
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
      body: JSON.stringify({
        model,
        instructions: taskNodeInstructions(),
        input: recentTranscript(conversationId, message),
        max_output_tokens: config.maxOutputTokens,
        reasoning: config.reasoningEffort ? { effort: config.reasoningEffort } : undefined,
        stream: true,
        store: false,
        metadata: {
          app: "tasknodeofficial",
          mode,
        },
      }),
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

async function executeOpenRouter({ mode, model, message, conversationId }) {
  const config = chatModeConfig(mode);
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const referer =
    process.env.OPENROUTER_REFERER ||
    process.env.TASKNODE_PUBLIC_URL ||
    process.env.VITE_SITE_ORIGIN ||
    "https://tasknodeofficial-dev.fly.dev";
  const title = process.env.OPENROUTER_TITLE || "Task Node Official";
  const history = getChatMessages(conversationId)
    .slice(-12)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.body,
    }));
  const body = await fetchJson(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY || process.env.OPENROUTER}`,
      "content-type": "application/json",
      "http-referer": referer,
      "x-title": title,
      "x-openrouter-title": title,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: taskNodeInstructions() },
        ...history,
        { role: "user", content: message },
      ],
      max_tokens: config.maxOutputTokens,
      usage: {
        include: true,
      },
    }),
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

async function streamOpenRouter({ mode, model, message, conversationId, onDelta, signal }) {
  const config = chatModeConfig(mode);
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const referer =
    process.env.OPENROUTER_REFERER ||
    process.env.TASKNODE_PUBLIC_URL ||
    process.env.VITE_SITE_ORIGIN ||
    "https://tasknodeofficial-dev.fly.dev";
  const title = process.env.OPENROUTER_TITLE || "Task Node Official";
  const history = getChatMessages(conversationId)
    .slice(-12)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.body,
    }));
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
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: taskNodeInstructions() },
          ...history,
          { role: "user", content: message },
        ],
        max_tokens: config.maxOutputTokens,
        stream: true,
        stream_options: {
          include_usage: true,
        },
      }),
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

export async function executeChat({ accountId = "", mode, message, conversationId = "dev" }) {
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
      ? await executeOpenAi({ mode: normalizedMode, model: status.model, message, conversationId })
      : await executeOpenRouter({ mode: normalizedMode, model: status.model, message, conversationId });

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
          onDelta,
          signal,
        })
      : await streamOpenRouter({
          mode: normalizedMode,
          model: status.model,
          message,
          conversationId,
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
