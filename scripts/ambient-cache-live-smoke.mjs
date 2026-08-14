import { readFile } from "node:fs/promises";
import {
  AMBIENT_MODELS,
  ambientChatCompletion,
} from "../server/ambient-inference.js";
import { openRouterUsage } from "../server/chat-provider-usage.js";
import { taskNodeInstructions } from "../server/chat-memory-context.js";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function help() {
  console.log([
    "Paid live smoke for Ambient GLM prompt-cache reporting.",
    "",
    "Usage:",
    "  npm run ambient-cache-live-smoke -- --execute [--api-key-file /path/to/key.txt]",
    "",
    "The smoke sends the same bounded request twice, prints token/cache accounting only,",
    "and fails if Ambient does not report a positive cache hit on the second response.",
  ].join("\n"));
}

if (process.argv.includes("--help") || !process.argv.includes("--execute")) {
  help();
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

const apiKeyFile = argumentValue("--api-key-file");
const apiKey = apiKeyFile
  ? String(await readFile(apiKeyFile, "utf8")).trim()
  : String(process.env.AMBIENT_API_KEY || "").trim();
if (!apiKey) throw new Error("ambient_api_key_missing");

const env = {
  ...process.env,
  AMBIENT_API_KEY: apiKey,
};
const systemPrompt = taskNodeInstructions({});
const body = {
  model: AMBIENT_MODELS.reasoningText,
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Cache telemetry smoke. Reply with exactly OK." },
  ],
  reasoning: { effort: "none", exclude: true },
  max_tokens: 16,
};

async function runOnce() {
  const result = await ambientChatCompletion({
    body,
    capability: "reasoning_text",
    env,
    timeoutMs: 120_000,
  });
  return {
    id: result.id,
    model: result.model,
    usage: openRouterUsage({ usage: result.usage }, "Thinking"),
  };
}

const first = await runOnce();
const second = await runOnce();
const report = {
  ok: second.usage.cacheUsageReported && second.usage.promptCacheHitTokens > 0,
  model: second.model,
  stablePrefixCharacters: systemPrompt.length,
  first: {
    inputTokens: first.usage.inputTokens,
    outputTokens: first.usage.outputTokens,
    cacheUsageReported: first.usage.cacheUsageReported,
    promptCacheHitTokens: first.usage.promptCacheHitTokens,
    costUsd: first.usage.costUsd,
    costSource: first.usage.costSource,
  },
  second: {
    inputTokens: second.usage.inputTokens,
    outputTokens: second.usage.outputTokens,
    cacheUsageReported: second.usage.cacheUsageReported,
    promptCacheHitTokens: second.usage.promptCacheHitTokens,
    promptCacheHitRate: second.usage.promptCacheHitRate,
    cacheSavingsUsd: second.usage.cacheSavingsUsd,
    costUsd: second.usage.costUsd,
    costSource: second.usage.costSource,
  },
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) throw new Error("ambient_prompt_cache_hit_not_observed");
