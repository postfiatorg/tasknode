import { apiChatModels } from "./chat-api-models.js";
import {
  INFERENCE_MODELS,
  inferenceConfigured,
  inferenceProviderConfigured,
  resolveInferenceModel,
} from "./inference.js";
import { effectiveDefaultChatMode, fallbackChatModeLabel } from "./chat-mode-defaults.js";

export const defaultProviderTimeoutMs = 45_000;
const defaultThinkingProviderTimeoutMs = 300_000;
export const chatModePrices = {
  Instant: {
    inputUsdPerMillion: 0.063,
    inputCacheHitUsdPerMillion: 0.0126,
    outputUsdPerMillion: 0.126,
    provider: "vercel",
    providerLabel: "Vercel AI Gateway",
    capability: "instant_text",
    defaultModel: INFERENCE_MODELS.instantText,
    maxOutputTokens: 16384,
    disableReasoning: true,
  },
  Thinking: {
    inputUsdPerMillion: 0.4725,
    inputCacheHitUsdPerMillion: 0.09,
    outputUsdPerMillion: 1.98,
    provider: "vercel",
    providerLabel: "Vercel AI Gateway",
    capability: "reasoning_text",
    defaultModel: INFERENCE_MODELS.reasoningText,
    maxOutputTokens: 4096,
    reasoningEffort: "xhigh",
  },
  ...apiChatModels,
  "Help": {
    inputUsdPerMillion: 0.063,
    inputCacheHitUsdPerMillion: 0.0126,
    outputUsdPerMillion: 0.126,
    provider: "vercel",
    providerLabel: "Vercel AI Gateway",
    capability: "fast_text",
    defaultModel: INFERENCE_MODELS.fastText,
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
  if (["vercel", "ambient"].includes(provider)) return inferenceProviderConfigured(provider);
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
  if (normalizedMode === "Thinking" || chatModePrices[normalizedMode]?.exactModel) {
    return timeoutFromEnv(
      [
        normalizedMode === "Help" ? "CHAT_PROVIDER_HELP_TIMEOUT_MS" : "",
        "CHAT_PROVIDER_VERCEL_THINKING_TIMEOUT_MS",
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
  if (provider === "vercel") return inferenceConfigured() && process.env.INFERENCE_CHAT_ENABLED !== "false";
  return false;
}

export function isKnownChatMode(mode) {
  const normalized = String(mode || "").trim();
  const canonical = deprecatedChatModeAliases[normalized] || normalized;
  return Object.hasOwn(chatModePrices, canonical);
}

export function unknownChatModeError(mode) {
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
  return resolveInferenceModel({
    model: config.defaultModel,
    capability: config.capability,
  });
}

export function chatExecutionStatus(mode) {
  const normalizedMode = normalizedChatMode(mode);
  const config = chatModeConfig(normalizedMode);
  const primaryConfigured = inferenceProviderConfigured("vercel", process.env, modelForMode(normalizedMode));
  const configured = config.exactModel ? primaryConfigured : inferenceConfigured();
  const enabled = configured && (config.exactModel ? process.env.INFERENCE_CHAT_ENABLED !== "false" : chatProviderEnabled(config.provider));

  return {
    mode: normalizedMode,
    provider: config.provider,
    providerLabel: config.providerLabel || config.provider,
    model: modelForMode(normalizedMode),
    configured,
    primaryConfigured,
    backupConfigured: !config.exactModel && process.env.INFERENCE_AMBIENT_BACKUP_ENABLED !== "false" && chatProviderConfigured("ambient"),
    backupProvider: config.exactModel ? "" : "ambient",
    enabled,
    status: enabled ? "ready" : configured ? "disabled" : "missing_config",
  };
}

export function actualChatCost(mode, usage) {
  const baseConfig = chatModeConfig(mode);
  const inputTokens = Number(usage?.inputTokens || 0);
  const config = baseConfig.longContext && inputTokens >= baseConfig.longContext.threshold
    ? { ...baseConfig, ...baseConfig.longContext } : baseConfig;
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
