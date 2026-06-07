import {
  chatExecutionStatus,
  chatModePrices,
} from "./chat-router.js";

const openRouterModelsUrl = "https://openrouter.ai/api/v1/models";
const openRouterApiBaseUrl = "https://openrouter.ai/api/v1";
const pricingTimeoutMs = Math.min(
  Math.max(Number(process.env.TASKNODE_MODEL_PRICING_TIMEOUT_MS) || 2500, 500),
  8000
);
const pricingCacheTtlMs = Math.min(
  Math.max(Number(process.env.TASKNODE_MODEL_PRICING_TTL_MS) || 15 * 60 * 1000, 60 * 1000),
  60 * 60 * 1000
);

let pricingCache = null;

const modeDescriptions = {
  "Private Instant": "Fast ZDR OpenRouter route using DeepSeek V4 Flash with reasoning disabled.",
  "Private Thinking": "ZDR OpenRouter route using DeepSeek V4 Pro with high reasoning and an explicit provider allowlist.",
  "Discount Thinking": "Direct DeepSeek API route using DeepSeek V4 Pro high reasoning at the current direct discount price.",
  "Frontier Instant": "OpenAI Responses route for fast frontier chat with prompt-governed web search.",
  Help: "Direct DeepSeek API route for plain-English Task Node product help with account context and the user guide injected.",
  "Frontier Thinking": "OpenAI Responses route for deeper frontier reasoning and prompt-governed web search.",
};

const providerSlugAliases = {
  akashml: "akashml",
  alibaba: "alibaba",
  atlascloud: "atlas-cloud",
  baidu: "baidu",
  deepinfra: "deepinfra",
  deepseek: "deepseek",
  fireworks: "fireworks",
  gmicloud: "gmicloud",
  morph: "morph",
  novita: "novita",
  parasail: "parasail",
  siliconflow: "siliconflow",
  streamlake: "streamlake",
  together: "together",
  venice: "venice",
};

function pricingEnabled() {
  return process.env.TASKNODE_SYSTEM_STATUS_LIVE_PRICING_ENABLED !== "false";
}

function numberOrNull(value) {
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

function providerSlug(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return providerSlugAliases[normalized] || normalized;
}

function endpointSummary(endpoint = {}, allowedProviders = []) {
  const slug = providerSlug(endpoint.provider_name || endpoint.provider || endpoint.name);
  const pricing = endpoint.pricing || {};
  return {
    provider: endpoint.provider_name || endpoint.provider || endpoint.name || "",
    providerSlug: slug,
    allowed: allowedProviders.includes(slug),
    inputUsdPerMillion: usdPerMillion(pricing.prompt),
    outputUsdPerMillion: usdPerMillion(pricing.completion),
    cacheReadUsdPerMillion: usdPerMillion(pricing.input_cache_read),
    contextLength: Number(endpoint.context_length || 0) || null,
    maxCompletionTokens: Number(endpoint.max_completion_tokens || 0) || null,
    quantization: endpoint.quantization || "",
  };
}

function openRouterEndpointUrl(model = "") {
  return `${openRouterApiBaseUrl}/models/${encodeURI(String(model || "").trim())}/endpoints`;
}

async function fetchJsonWithTimeout(url, { fetchImpl = fetch, timeoutMs = pricingTimeoutMs } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.message || `pricing_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function modelSummary(model = null) {
  if (!model) return null;
  return {
    id: model.id || "",
    name: model.name || "",
    description: String(model.description || "").replace(/\s+/g, " ").trim().slice(0, 360),
    inputUsdPerMillion: usdPerMillion(model.pricing?.prompt),
    outputUsdPerMillion: usdPerMillion(model.pricing?.completion),
    cacheReadUsdPerMillion: usdPerMillion(model.pricing?.input_cache_read),
    contextLength: Number(model.context_length || model.top_provider?.context_length || 0) || null,
    maxCompletionTokens: Number(model.top_provider?.max_completion_tokens || 0) || null,
    sourceUrl: `https://openrouter.ai/${model.id || ""}`,
  };
}

function directProviderModelSummary({ model = "", provider = "", config = {} } = {}) {
  if (provider !== "deepseek") return null;
  return {
    id: model,
    name: "DeepSeek-V4-Pro",
    description: "Direct DeepSeek API model. This is not the Task Node private/ZDR provider path.",
    inputUsdPerMillion: Number(config.inputUsdPerMillion || 0),
    outputUsdPerMillion: Number(config.outputUsdPerMillion || 0),
    cacheReadUsdPerMillion: Number(config.inputCacheHitUsdPerMillion || 0) || null,
    contextLength: 1_000_000,
    maxCompletionTokens: 384_000,
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
  };
}

function baseModeRows(liveByModel = new Map(), endpointsByModel = new Map()) {
  return Object.keys(chatModePrices).map((mode) => {
    const config = chatModePrices[mode];
    const execution = chatExecutionStatus(mode);
    const allowedProviders = Array.isArray(config.providerOrder) ? config.providerOrder : [];
    const endpointRows = (endpointsByModel.get(execution.model) || [])
      .map((endpoint) => endpointSummary(endpoint, allowedProviders))
      .sort((left, right) => {
        if (left.allowed !== right.allowed) return left.allowed ? -1 : 1;
        return (left.outputUsdPerMillion ?? Infinity) - (right.outputUsdPerMillion ?? Infinity);
      });
    const liveModel = modelSummary(liveByModel.get(execution.model)) ||
      directProviderModelSummary({ model: execution.model, provider: execution.provider, config });
    return {
      mode,
      provider: execution.provider,
      providerLabel: execution.providerLabel,
      model: execution.model,
      status: execution.status,
      configured: execution.configured,
      enabled: execution.enabled,
      description: modeDescriptions[mode] || "",
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
      privacyPolicy: execution.provider === "openrouter"
        ? "OpenRouter request sets zdr=true, data_collection=deny, and mode-specific provider allowlist."
        : execution.provider === "deepseek"
          ? "Direct DeepSeek API route. Not OpenRouter ZDR; no web search; user billing is computed from DeepSeek token usage and configured direct prices."
          : "OpenAI Responses request sets store=false; Frontier modes may use prompt-governed web search.",
      providerOrder: allowedProviders,
      liveModel,
      liveEndpoints: endpointRows,
    };
  });
}

async function fetchLiveOpenRouterPricing({ fetchImpl = fetch } = {}) {
  const modelsBody = await fetchJsonWithTimeout(openRouterModelsUrl, { fetchImpl });
  const models = Array.isArray(modelsBody?.data) ? modelsBody.data : [];
  const modelIds = [...new Set(Object.keys(chatModePrices)
    .map((mode) => chatExecutionStatus(mode))
    .filter((status) => status.provider === "openrouter")
    .map((status) => status.model)
    .filter(Boolean))];
  const endpointsByModel = new Map();
  await Promise.all(modelIds.map(async (modelId) => {
    try {
      const body = await fetchJsonWithTimeout(openRouterEndpointUrl(modelId), { fetchImpl });
      endpointsByModel.set(modelId, body?.data?.endpoints || body?.endpoints || []);
    } catch (error) {
      endpointsByModel.set(modelId, []);
    }
  }));

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
      openRouterModelsUrl,
      "https://api-docs.deepseek.com/quick_start/pricing",
      "https://openrouter.ai/docs/guides/routing/provider-selection",
    ],
  };
  let liveByModel = new Map();
  let endpointsByModel = new Map();

  if (live.enabled) {
    try {
      const fetched = await fetchLiveOpenRouterPricing({ fetchImpl });
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
    modes: baseModeRows(liveByModel, endpointsByModel),
    references: [],
    notes: [
      "Configured pricing is the preflight estimate in server/chat-router.js; actual OpenRouter billing uses provider-returned usage.cost.",
      "Direct DeepSeek billing uses the token usage returned by DeepSeek and the configured direct API token prices, including cache-hit pricing when DeepSeek reports cache-hit tokens.",
      "OpenRouter headline model pricing can refer to the cheapest provider endpoint. Task Node private modes also require zdr=true and data_collection=deny, so the cheapest endpoint may not be eligible.",
      "Endpoint metadata is public OpenRouter metadata. ZDR eligibility is enforced by the request body at execution time.",
    ],
  };
  pricingCache = { cachedAtMs: now, value };
  return value;
}
