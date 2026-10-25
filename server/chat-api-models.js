// Vercel AI Gateway catalogue, verified 2026-09-07 (Opus 5.5: 2026-09-24).
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
  "Kimi K3.1 Pro": {
    ...common,
    defaultModel: "moonshotai/kimi-k3.1-pro",
    inputUsdPerMillion: 2,
    inputCacheHitUsdPerMillion: 0.2,
    inputCacheWriteUsdPerMillion: 2,
    outputUsdPerMillion: 10,
  },
  // Every Anthropic route Vercel offers for Opus 5.5 supports ZDR; the gateway
  // fails the request rather than use a retaining provider.
  "Claude Opus 5.5": {
    ...common,
    defaultModel: "anthropic/claude-opus-5.5",
    inputUsdPerMillion: 4,
    inputCacheHitUsdPerMillion: 0.2,
    inputCacheWriteUsdPerMillion: 5,
    outputUsdPerMillion: 20,
    zeroDataRetention: true,
  },
});
