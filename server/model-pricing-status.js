import { collapseWhitespace } from "./inference-text.js";
import {
  chatExecutionStatus,
  chatModePrices,
} from "./chat-router.js";
import { inferenceModels } from "./inference.js";
import { providerBaseUrl } from "./inference-policy.js";
import { databaseEnabled, query } from "./db/pool.js";

const inferenceModelsUrl = `${providerBaseUrl("vercel")}/models`;
const pricingTimeoutMs = Math.min(
  Math.max(Number(process.env.TASKNODE_MODEL_PRICING_TIMEOUT_MS) || 2500, 500),
  8000
);
const pricingCacheTtlMs = Math.min(
  Math.max(Number(process.env.TASKNODE_MODEL_PRICING_TTL_MS) || 15 * 60 * 1000, 60 * 1000),
  60 * 60 * 1000
);

let pricingCache = null;
const cacheEfficiencyWindowDays = Math.min(
  Math.max(Number(process.env.TASKNODE_CHAT_CACHE_METRICS_WINDOW_DAYS) || 7, 1),
  90
);

const modeDescriptions = {
  Instant: "GLM 5.3 Flash through Vercel AI Gateway, with Ambient as backup.",
  Thinking: "GLM 5.3 with deep reasoning through Vercel AI Gateway, with Ambient as backup.",
  Help: "Plain-English Task Node help through Vercel AI Gateway, with Ambient as backup.",
};

function pricingEnabled() {
  return process.env.TASKNODE_SYSTEM_STATUS_LIVE_PRICING_ENABLED !== "false";
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usdPerMillion(value) {
  const perToken = numberOrNull(value);
  if (perToken === null) return null;
  return Number((perToken * 1_000_000).toFixed(6));
}

function configuredPricing(config = {}) {
  return {
    inputUsdPerMillion: Number(config.inputUsdPerMillion || 0),
    inputCacheHitUsdPerMillion: Number(config.inputCacheHitUsdPerMillion || 0) || null,
    outputUsdPerMillion: Number(config.outputUsdPerMillion || 0),
  };
}

function cacheEfficiencyUnavailable(status, error = "") {
  return {
    enabled: databaseEnabled(),
    status,
    windowDays: cacheEfficiencyWindowDays,
    runs: 0,
    reportedRuns: 0,
    reportingCoveragePercent: null,
    reportedInputTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cacheHitPercent: null,
    cacheSavingsUsd: 0,
    modes: [],
    error,
  };
}

function cacheEfficiencyRow(row = {}) {
  const runs = Number(row.runs || 0);
  const reportedRuns = Number(row.reported_runs || 0);
  const reportedInputTokens = Number(row.reported_input_tokens || 0);
  const promptCacheHitTokens = Number(row.prompt_cache_hit_tokens || 0);
  const promptCacheMissTokens = Number(row.prompt_cache_miss_tokens || 0);
  return {
    mode: row.mode || "",
    model: row.model || "",
    runs,
    reportedRuns,
    reportingCoveragePercent: runs > 0
      ? Number(((reportedRuns / runs) * 100).toFixed(1))
      : null,
    reportedInputTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    cacheHitPercent: reportedInputTokens > 0
      ? Number(((promptCacheHitTokens / reportedInputTokens) * 100).toFixed(1))
      : null,
    cacheSavingsUsd: Number(Number(row.cache_savings_usd || 0).toFixed(6)),
  };
}

export async function chatCacheEfficiencyStatus() {
  if (!databaseEnabled()) return cacheEfficiencyUnavailable("database_disabled");
  try {
    const result = await query(
      `
        SELECT
          CASE mode
            WHEN 'Private Instant' THEN 'Instant'
            WHEN 'Frontier Instant' THEN 'Instant'
            WHEN 'Private Thinking' THEN 'Thinking'
            WHEN 'Discount Thinking' THEN 'Thinking'
            WHEN 'Frontier Thinking' THEN 'Thinking'
            ELSE mode
          END AS mode,
          model,
          COUNT(*)::integer AS runs,
          COUNT(*) FILTER (WHERE cache_usage_reported)::integer AS reported_runs,
          COALESCE(SUM(input_tokens) FILTER (WHERE cache_usage_reported), 0)::bigint AS reported_input_tokens,
          COALESCE(SUM(prompt_cache_hit_tokens) FILTER (WHERE cache_usage_reported), 0)::bigint AS prompt_cache_hit_tokens,
          COALESCE(SUM(prompt_cache_miss_tokens) FILTER (WHERE cache_usage_reported), 0)::bigint AS prompt_cache_miss_tokens,
          COALESCE(SUM(cache_savings_usd) FILTER (WHERE cache_usage_reported), 0)::numeric AS cache_savings_usd
        FROM chat_model_runs
        WHERE provider IN ('vercel', 'ambient')
          AND status = 'completed'
          AND started_at >= now() - ($1::text || ' days')::interval
        GROUP BY 1, model
        ORDER BY 1, model
      `,
      [cacheEfficiencyWindowDays]
    );
    const modes = result.rows.map(cacheEfficiencyRow);
    const totals = cacheEfficiencyRow(modes.reduce((total, row) => ({
      runs: total.runs + row.runs,
      reported_runs: total.reported_runs + row.reportedRuns,
      reported_input_tokens: total.reported_input_tokens + row.reportedInputTokens,
      prompt_cache_hit_tokens: total.prompt_cache_hit_tokens + row.promptCacheHitTokens,
      prompt_cache_miss_tokens: total.prompt_cache_miss_tokens + row.promptCacheMissTokens,
      cache_savings_usd: total.cache_savings_usd + row.cacheSavingsUsd,
    }), {
      runs: 0,
      reported_runs: 0,
      reported_input_tokens: 0,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 0,
      cache_savings_usd: 0,
    }));
    return {
      enabled: true,
      status: totals.reportedRuns > 0 ? "ok" : "awaiting_reported_usage",
      windowDays: cacheEfficiencyWindowDays,
      runs: totals.runs,
      reportedRuns: totals.reportedRuns,
      reportingCoveragePercent: totals.reportingCoveragePercent,
      reportedInputTokens: totals.reportedInputTokens,
      promptCacheHitTokens: totals.promptCacheHitTokens,
      promptCacheMissTokens: totals.promptCacheMissTokens,
      cacheHitPercent: totals.cacheHitPercent,
      cacheSavingsUsd: totals.cacheSavingsUsd,
      modes,
      error: "",
    };
  } catch (error) {
    return cacheEfficiencyUnavailable("error", error?.message || String(error));
  }
}

function modelSummary(model = null) {
  if (!model) return null;
  return {
    id: model.id || "",
    name: model.name || "",
    description: collapseWhitespace(model.description).slice(0, 360),
    inputUsdPerMillion: usdPerMillion(model.pricing?.input ?? model.pricing?.prompt),
    outputUsdPerMillion: usdPerMillion(model.pricing?.output ?? model.pricing?.completion),
    cacheReadUsdPerMillion: usdPerMillion(model.pricing?.input_cache_read),
    contextLength: Number(model.context_window || model.context_length || model.top_provider?.context_length || 0) || null,
    maxCompletionTokens: Number(model.max_tokens || model.top_provider?.max_completion_tokens || 0) || null,
    sourceUrl: inferenceModelsUrl,
  };
}

function baseModeRows(liveByModel = new Map(), endpointsByModel = new Map()) {
  return Object.keys(chatModePrices).map((mode) => {
    const config = chatModePrices[mode];
    const execution = chatExecutionStatus(mode);
    const liveModel = modelSummary(liveByModel.get(execution.model));
    return {
      mode,
      provider: execution.provider,
      providerLabel: execution.providerLabel,
      model: execution.model,
      status: execution.status,
      configured: execution.configured,
      enabled: execution.enabled,
      description: modeDescriptions[mode] || mode,
      billingPolicy: config.billingPolicy || "configured_user_tariff",
      configuredPricing: configuredPricing(config),
      maxOutputTokens: Number.isFinite(Number(config.maxOutputTokens)) && Number(config.maxOutputTokens) > 0
        ? Number(config.maxOutputTokens)
        : null,
      estimatedOutputTokens: Number.isFinite(Number(config.estimatedOutputTokens)) && Number(config.estimatedOutputTokens) > 0
        ? Number(config.estimatedOutputTokens)
        : null,
      reasoning: config.reasoningEffort
        ? config.reasoningEffort
        : config.disableReasoning
          ? "none"
          : "",
      privacyPolicy: config.exactModel ? "Requests use the selected model through Vercel AI Gateway." : "Requests go to Vercel AI Gateway, with Ambient as backup. OpenAI Images is isolated to sanitized profile NFT rendering.",
      providerOrder: ["vercel", ...(!config.exactModel && process.env.INFERENCE_AMBIENT_BACKUP_ENABLED !== "false" ? ["ambient"] : [])],
      liveModel,
      liveEndpoints: endpointsByModel.get(execution.model) || [],
    };
  });
}

async function fetchLiveGatewayPricing({ fetchImpl = fetch } = {}) {
  const modelsBody = await inferenceModels({ fetchImpl, timeoutMs: pricingTimeoutMs });
  const models = Array.isArray(modelsBody?.data) ? modelsBody.data : [];
  const modelIds = [...new Set(Object.keys(chatModePrices)
    .map((mode) => chatExecutionStatus(mode))
    .filter((status) => status.provider === "vercel")
    .map((status) => status.model)
    .filter(Boolean))];
  const endpointsByModel = new Map();
  for (const modelId of modelIds) endpointsByModel.set(modelId, []);

  return {
    models,
    liveByModel: new Map(models.map((model) => [model.id, model])),
    endpointsByModel,
  };
}

export async function chatPricingStatus({ fetchImpl = fetch } = {}) {
  const now = Date.now();
  if (pricingCache && now - pricingCache.cachedAtMs < pricingCacheTtlMs) return pricingCache.value;

  const live = {
    enabled: pricingEnabled(),
    status: pricingEnabled() ? "loading" : "disabled",
    fetchedAt: null,
    error: "",
    sourceUrls: [
      inferenceModelsUrl,
    ],
  };
  const cacheEfficiencyPromise = chatCacheEfficiencyStatus();
  let liveByModel = new Map();
  let endpointsByModel = new Map();

  if (live.enabled) {
    try {
      const fetched = await fetchLiveGatewayPricing({ fetchImpl });
      liveByModel = fetched.liveByModel;
      endpointsByModel = fetched.endpointsByModel;
      live.status = "ok";
      live.fetchedAt = new Date().toISOString();
    } catch (error) {
      live.status = "error";
      live.error = error?.message || String(error);
    }
  }

  const value = {
    generatedAt: new Date().toISOString(),
    live,
    cacheEfficiency: await cacheEfficiencyPromise,
    modes: baseModeRows(liveByModel, endpointsByModel),
    references: [],
    notes: [
      "Instant, Thinking, and Help use the configured user tariff for estimates and ledger debits.",
      "GPT-6 Astra and Kimi K3 estimates use published base API rates; final debits equal Vercel-reported cost without markup. Missing provider cost prevents a debit.",
    ],
  };
  pricingCache = { cachedAtMs: now, value };
  return value;
}
