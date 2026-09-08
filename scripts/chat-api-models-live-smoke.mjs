import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { apiChatModels } from "../server/chat-api-models.js";
import { inferenceChatCompletion, inferenceChatCompletionStream } from "../server/inference.js";
import { openRouterUsage } from "../server/chat-provider-usage.js";

const labels = { "GPT-6 Astra": "vercel_astra", "Kimi K3": "vercel_kimi" };
const results = [];
const started = Date.now();
for (const [mode, config] of Object.entries(apiChatModels)) {
  let key;
  try {
    key = process.env.MODEL_CREDENTIAL_DIR
      ? (await readFile(join(process.env.MODEL_CREDENTIAL_DIR, labels[mode] + ".txt"), "utf8")).trim()
      : execFileSync("/home/pfrpc/.local/bin/corbanu", ["vault", "auth-helper", labels[mode]], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim();
    if (!key) throw new Error("empty_credential");
  } catch {
    const result = { mode, credentialLabel: labels[mode], ok: false, error: "credential_unavailable" };
    results.push(result);
    console.log(JSON.stringify(result));
    continue;
  }
  // Scope credentials to this call. Never print or persist the credential.
  const env = { VERCEL_AI_GATEWAY_API_KEY: key, INFERENCE_AMBIENT_BACKUP_ENABLED: "false" };
  for (const streaming of [true, false]) {
    const callStarted = Date.now();
    try {
      const complete = streaming ? inferenceChatCompletionStream : inferenceChatCompletion;
      let visible = "";
      const response = await complete({
        body: { model: config.defaultModel, messages: [{ role: "user", content: "What is 2 + 2? Reply with only the digit." }], max_tokens: 1024, reasoning: { effort: config.reasoningEffort, exclude: true } },
        capability: config.capability, env, timeoutMs: 45000, onDelta: text => { visible += text; },
      });
      const usage = openRouterUsage(response.body, mode);
      assert.equal(response.text.trim(), "4");
      if (streaming) assert.equal(visible.trim(), "4");
      assert.equal(usage.costSource, "provider_api_cost");
      assert.equal(usage.costUsd, usage.providerCostUsd);
      const result = { mode, credentialLabel: labels[mode], streaming, ok: true, requestedModel: config.defaultModel, returnedModel: response.model, text: response.text, responseId: response.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerCostUsd: usage.providerCostUsd, calculatedDebitUsd: usage.costUsd, elapsedMs: Date.now() - callStarted };
      results.push(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      const result = { mode, credentialLabel: labels[mode], streaming, ok: false, error: error.code || (error.name === "AssertionError" ? "response_assertion_failed" : error.message), status: error.status, elapsedMs: Date.now() - callStarted };
      results.push(result);
      console.log(JSON.stringify(result));
      break;
    }
  }
}
const report = { generatedAt: new Date().toISOString(), elapsedMs: Date.now() - started, providerCostUsd: Number(results.reduce((sum, result) => sum + (result.providerCostUsd || 0), 0).toFixed(6)), userLedgerWrites: 0, results };
if (process.env.MODEL_PROBE_OUTPUT) await writeFile(process.env.MODEL_PROBE_OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ elapsedMs: report.elapsedMs, providerCostUsd: report.providerCostUsd, passed: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length, userLedgerWrites: 0 }));
if (results.some(result => !result.ok)) process.exitCode = 1;
