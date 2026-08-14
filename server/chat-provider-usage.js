import { actualChatCost } from "./chat-router.js";
import { webSearchUsdPerCall } from "./chat-search-tools.js";

function hasOwn(object, key) {
  return Boolean(object && typeof object === "object" && Object.hasOwn(object, key));
}

function boundedTokenCount(value, max = Number.POSITIVE_INFINITY) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(0, Math.floor(parsed)), Math.max(0, max));
}

function promptCacheUsage(usage = {}, inputTokens = 0) {
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details
    : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details
    : {};
  const cacheUsageReported =
    hasOwn(usage, "prompt_cache_hit_tokens") ||
    hasOwn(usage, "prompt_cache_miss_tokens") ||
    hasOwn(usage, "cache_read_input_tokens") ||
    hasOwn(promptDetails, "cached_tokens") ||
    hasOwn(inputDetails, "cached_tokens");
  const promptCacheHitTokens = boundedTokenCount(
    usage.prompt_cache_hit_tokens ??
      usage.cache_read_input_tokens ??
      promptDetails.cached_tokens ??
      inputDetails.cached_tokens ??
      0,
    inputTokens
  );
  const explicitMissTokens = usage.prompt_cache_miss_tokens;
  const promptCacheMissTokens = explicitMissTokens === undefined || explicitMissTokens === null
    ? Math.max(0, inputTokens - promptCacheHitTokens)
    : boundedTokenCount(explicitMissTokens, inputTokens);
  const promptCacheHitRate = inputTokens > 0
    ? Number((promptCacheHitTokens / inputTokens).toFixed(6))
    : 0;

  return {
    cacheUsageReported,
    promptCacheHitTokens,
    promptCacheMissTokens,
    promptCacheHitRate,
  };
}

function cacheAwareUsageCost(mode, {
  inputTokens = 0,
  outputTokens = 0,
  promptCacheHitTokens = 0,
  promptCacheMissTokens = 0,
} = {}) {
  const cacheAwareCostUsd = actualChatCost(mode, {
    inputTokens,
    outputTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
  });
  const uncachedCostUsd = actualChatCost(mode, { inputTokens, outputTokens });
  return {
    cacheAwareCostUsd,
    cacheSavingsUsd: Number(Math.max(0, uncachedCostUsd - cacheAwareCostUsd).toFixed(6)),
  };
}

function countOpenAiOutputItems(body, type) {
  return (body?.output || []).filter((item) => item?.type === type).length;
}

export function openAiUsage(body, mode) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const webSearchCalls = Math.max(
    countOpenAiOutputItems(body, "web_search_call"),
    Number(usage.web_search_calls || usage.web_search_requests || 0)
  );
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

export function openRouterUsage(body, mode) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const cacheUsage = promptCacheUsage(usage, inputTokens);
  const configuredCost = cacheAwareUsageCost(mode, {
    inputTokens,
    outputTokens,
    ...cacheUsage,
  });
  const providerCost = usage.cost === undefined || usage.cost === null || usage.cost === ""
    ? null
    : Number(usage.cost);
  const webSearchCalls = Number(usage.server_tool_use?.web_search_requests || 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens || inputTokens + outputTokens),
    ...cacheUsage,
    cacheSavingsUsd: configuredCost.cacheSavingsUsd,
    providerCostUsd: Number.isFinite(providerCost) ? Number(providerCost.toFixed(6)) : null,
    costSource: cacheUsage.cacheUsageReported
      ? "configured_user_cache_tariff"
      : "configured_user_tariff",
    webSearchCalls,
    toolCostUsd: 0,
    costUsd: configuredCost.cacheAwareCostUsd,
  };
}

export function deepSeekUsage(body, mode) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const cacheUsage = promptCacheUsage(usage, inputTokens);
  const configuredCost = cacheAwareUsageCost(mode, {
    inputTokens,
    outputTokens,
    ...cacheUsage,
  });
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens || inputTokens + outputTokens),
    ...cacheUsage,
    cacheSavingsUsd: configuredCost.cacheSavingsUsd,
    costSource: cacheUsage.cacheUsageReported ? "configured_cache_pricing" : "configured_pricing",
    webSearchCalls: 0,
    toolCostUsd: 0,
    costUsd: configuredCost.cacheAwareCostUsd,
  };
}

export function fallbackUsage({ mode, message, text }) {
  const inputTokens = Math.max(1, Math.ceil(String(message || "").length / 4));
  const outputTokens = Math.max(1, Math.ceil(String(text || "").length / 4));
  const webSearchCalls = 0;
  const toolCostUsd = Number((webSearchCalls * webSearchUsdPerCall).toFixed(6));
  const tokenCostUsd = actualChatCost(mode, { inputTokens, outputTokens });

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheUsageReported: false,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: inputTokens,
    promptCacheHitRate: 0,
    cacheSavingsUsd: 0,
    costSource: "estimated_configured_pricing",
    webSearchCalls,
    toolCostUsd,
    costUsd: Number((tokenCostUsd + toolCostUsd).toFixed(6)),
    estimated: true,
  };
}
