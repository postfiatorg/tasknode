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

export async function executeChat({ mode, message, conversationId = "dev" }) {
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
