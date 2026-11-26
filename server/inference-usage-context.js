import { AsyncLocalStorage } from "node:async_hooks";
import { inferenceProviderUsage } from "./inference-usage.js";

// Collects every completed inference call made inside a scope, so a worker can
// attribute what one unit of work spent without threading usage through every
// helper it calls. Calls outside a scope are not collected.
const scope = new AsyncLocalStorage();

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function inferenceUsageRecord({ provider = "", requestedModel = "", model = "", capability = "", body = {} } = {}) {
  const usage = body?.usage && typeof body.usage === "object" ? body.usage : {};
  const inputTokens = count(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = count(usage.completion_tokens ?? usage.output_tokens);
  const cost = inferenceProviderUsage(body);
  return {
    provider: String(provider || "").slice(0, 40),
    requestedModel: String(requestedModel || "").slice(0, 160),
    model: String(model || body?.model || "").slice(0, 160),
    capability: String(capability || "").slice(0, 60),
    responseId: String(body?.id || "").slice(0, 180),
    inputTokens,
    outputTokens,
    totalTokens: count(usage.total_tokens) || inputTokens + outputTokens,
    cachedInputTokens: count(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens),
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens),
    providerCostUsd: cost.providerCostUsd,
    webSearchCalls: cost.webSearchCalls,
    completedAt: new Date().toISOString(),
  };
}

export function reportInferenceCompletion(details = {}) {
  const store = scope.getStore();
  if (!store) return;
  try { store.completions.push(inferenceUsageRecord(details)); }
  catch { /* Accounting must never fail the inference call it observes. */ }
}

export async function withInferenceUsageScope(run) {
  const store = { completions: [] };
  try {
    const result = await scope.run(store, run);
    return { result, completions: store.completions };
  } catch (error) {
    if (error && typeof error === "object") error.inferenceCompletions = store.completions;
    throw error;
  }
}

// Accumulates usage across several scoped calls, including calls that fail
// after some completions were already paid for.
export function createInferenceUsageMeter() {
  const completions = [];
  return {
    completions,
    async run(work) {
      try {
        const scoped = await withInferenceUsageScope(work);
        completions.push(...scoped.completions);
        return scoped.result;
      } catch (error) {
        if (Array.isArray(error?.inferenceCompletions)) completions.push(...error.inferenceCompletions);
        throw error;
      }
    },
  };
}
