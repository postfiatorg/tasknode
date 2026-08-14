import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  actualChatCost,
  chatModeConfig,
} from "../server/chat-router.js";
import { openRouterUsage } from "../server/chat-provider-usage.js";

const thinking = chatModeConfig("Thinking");
assert.equal(thinking.inputUsdPerMillion, 0.4725);
assert.equal(thinking.inputCacheHitUsdPerMillion, 0.09);
assert.equal(thinking.outputUsdPerMillion, 1.98);

const cached = openRouterUsage({
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 2000,
    total_tokens: 3000,
    prompt_tokens_details: {
      cached_tokens: 800,
    },
  },
}, "Thinking");
assert.deepEqual(cached, {
  inputTokens: 1000,
  outputTokens: 2000,
  totalTokens: 3000,
  cacheUsageReported: true,
  promptCacheHitTokens: 800,
  promptCacheMissTokens: 200,
  promptCacheHitRate: 0.8,
  cacheSavingsUsd: 0.000306,
  providerCostUsd: null,
  costSource: "configured_user_cache_tariff",
  webSearchCalls: 0,
  toolCostUsd: 0,
  costUsd: 0.004126,
});

const providerPriced = openRouterUsage({
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 2000,
    total_tokens: 3000,
    prompt_tokens_details: {
      cached_tokens: 800,
    },
    cost: 0.008765,
  },
}, "Thinking");
assert.equal(providerPriced.costUsd, 0.004126);
assert.equal(providerPriced.providerCostUsd, 0.008765);
assert.equal(providerPriced.costSource, "configured_user_cache_tariff");
assert.equal(providerPriced.promptCacheHitTokens, 800);
assert.equal(providerPriced.cacheSavingsUsd, 0.000306);

const reportedMiss = openRouterUsage({
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 10,
    prompt_tokens_details: {
      cached_tokens: 0,
    },
  },
}, "Thinking");
assert.equal(reportedMiss.cacheUsageReported, true);
assert.equal(reportedMiss.promptCacheHitTokens, 0);
assert.equal(reportedMiss.promptCacheMissTokens, 1000);
assert.equal(reportedMiss.promptCacheHitRate, 0);
assert.equal(reportedMiss.cacheSavingsUsd, 0);

const unreported = openRouterUsage({
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 10,
  },
}, "Thinking");
assert.equal(unreported.cacheUsageReported, false);
assert.equal(unreported.costSource, "configured_user_tariff");
assert.equal(unreported.promptCacheMissTokens, 1000);

assert.equal(actualChatCost("Thinking", {
  inputTokens: 1_000_000,
  outputTokens: 0,
  promptCacheHitTokens: 1_000_000,
  promptCacheMissTokens: 0,
}), 0.09);

const flash = chatModeConfig("Instant");
assert.deepEqual({
  input: flash.inputUsdPerMillion,
  cachedInput: flash.inputCacheHitUsdPerMillion,
  output: flash.outputUsdPerMillion,
}, {
  input: 0.063,
  cachedInput: 0.0126,
  output: 0.126,
});

const migration = await readFile(
  new URL("../server/db/migrations/107_chat_prompt_cache_accounting.sql", import.meta.url),
  "utf8"
);
for (const column of [
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "cache_usage_reported",
  "cache_savings_usd",
  "cost_source",
]) {
  assert.match(migration, new RegExp(column));
}
assert.match(migration, /ALTER TABLE chat_model_runs/);
assert.match(migration, /ALTER TABLE billing_ledger_entries/);

const providerCostMigration = await readFile(
  new URL("../server/db/migrations/109_chat_provider_cost_accounting.sql", import.meta.url),
  "utf8"
);
assert.match(providerCostMigration, /provider_cost_usd/);
assert.match(providerCostMigration, /ALTER TABLE chat_model_runs/);
assert.match(providerCostMigration, /ALTER TABLE billing_ledger_entries/);

console.log("chat cache accounting smoke ok");
