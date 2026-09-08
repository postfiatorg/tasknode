// Vercel AI Gateway catalogue, verified 2026-09-07.
// Base rates estimate requests; the returned Gateway cost is the final debit.
const common = {
  provider: "vercel",
  providerLabel: "Vercel AI Gateway",
  capability: "selected_model",
  billingPolicy: "provider_api_cost",
  exactModel: true,
  maxOutputTokens: 16384,
  estimatedOutputTokens: 1800,
  reasoningEffort: "high",
};
export const apiChatModels = Object.freeze({
  "GPT-6 Astra": {
    ...common,
    defaultModel: "openai/gpt-6-astra",
    inputUsdPerMillion: 10,
    inputCacheHitUsdPerMillion: 1,
    inputCacheWriteUsdPerMillion: 12.5,
    outputUsdPerMillion: 50,
    longContext: { threshold: 272001, inputUsdPerMillion: 20, inputCacheHitUsdPerMillion: 2, inputCacheWriteUsdPerMillion: 25, outputUsdPerMillion: 75 },
  },
  "Kimi K3": {
    ...common,
    defaultModel: "moonshotai/kimi-k3",
    inputUsdPerMillion: 3,
    inputCacheHitUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
  },
});
