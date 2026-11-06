import assert from "node:assert/strict";

// Fixture keys only. The smoke asserts they never appear in any output.
const KIMI_KEY = "vck_fixture_kimi_key_must_not_leak";
const GATEWAY_KEY = "vck_fixture_gateway_key_must_not_leak";
process.env.VERCEL_KIMI_API_KEY = KIMI_KEY;
process.env.VERCEL_AI_GATEWAY_API_KEY = GATEWAY_KEY;
process.env.VERCEL_AI_GATEWAY_BASE_URL = "https://gateway.invalid/v1";
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_ASTRA_API_KEY;
delete process.env.TASKNODE_TASKGEN_PROVIDER_MOCK;
delete process.env.INFERENCE_AMBIENT_BACKUP_ENABLED;
process.env.TASKNODE_GATEWAY_CREDIT_LOW_BALANCE_USD = "25";

const credits = await import("../server/inference-credits.js");
const { taskGenerationInferenceModels } = await import("../server/task-generation-contract.js");
const { inferenceChatCompletion, INFERENCE_MODELS } = await import("../server/inference.js");
const { createInferenceUsageMeter } = await import("../server/inference-usage-context.js");
const { publicTaskRequest } = await import("../server/repositories/task-requests.js");
const { assessTaskIntent } = await import("../server/task-intent-assessment.js");
const { readiness } = await import("../server/product-contracts.js");

const checks = [];
const check = (name) => checks.push(name);
const noKeys = (value) => {
  const text = JSON.stringify(value);
  assert.equal(text.includes(KIMI_KEY), false, "kimi key leaked");
  assert.equal(text.includes(GATEWAY_KEY), false, "gateway key leaked");
};
const balances = new Map([[KIMI_KEY, "3.20"], [GATEWAY_KEY, "184.75"]]);
let creditCalls = [];
const gatewayFetch = async (url, init = {}) => {
  const key = String(init.headers?.authorization || "").slice("Bearer ".length);
  if (String(url).endsWith("/credits")) {
    creditCalls.push({ url: String(url), credential: key === KIMI_KEY ? "VERCEL_KIMI_API_KEY" : key === GATEWAY_KEY ? "VERCEL_AI_GATEWAY_API_KEY" : "unknown" });
    if (!balances.has(key)) return Response.json({ error: { message: "unauthorized", type: "authentication_error" } }, { status: 401 });
    return Response.json({ balance: balances.get(key), total_used: "1204.10" });
  }
  throw new Error(`unexpected url ${url}`);
};

// 1. Task generation's distinct credentials are the dedicated Kimi key and the
//    shared gateway key; each is checked once.
const models = taskGenerationInferenceModels();
assert.deepEqual(models, ["moonshotai/kimi-k3.1-pro", INFERENCE_MODELS.instantText, INFERENCE_MODELS.structured]);
assert.deepEqual(credits.gatewayCredentialsForModels(models).map((item) => item.credential), ["VERCEL_KIMI_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"]);
check("task generation credentials resolved per distinct key");

// 2. Balance + low-balance warning, bearer auth per key, no key material out.
credits.resetGatewayCreditCache();
let status = await credits.gatewayCreditStatus({ models, fetchImpl: gatewayFetch, maxWaitMs: 1000 });
assert.deepEqual(creditCalls.map((call) => call.url), ["https://gateway.invalid/v1/credits", "https://gateway.invalid/v1/credits"]);
assert.deepEqual(creditCalls.map((call) => call.credential).sort(), ["VERCEL_AI_GATEWAY_API_KEY", "VERCEL_KIMI_API_KEY"]);
assert.equal(status.status, "low");
assert.equal(status.lowBalance, true);
assert.equal(status.balanceUsd, 3.2);
assert.equal(status.lowBalanceThresholdUsd, 25);
assert.equal(status.credentials.find((item) => item.credential === "VERCEL_KIMI_API_KEY").status, "low");
assert.equal(status.credentials.find((item) => item.credential === "VERCEL_AI_GATEWAY_API_KEY").status, "ok");
assert.match(status.warning, /VERCEL_KIMI_API_KEY: \$3\.20 is below the \$25\.00 warning threshold/);
noKeys(status);
check("balance and lowBalance warning reported per key without key material");

// 3. Cached: a second read inside the TTL makes no request.
creditCalls = [];
status = await credits.gatewayCreditStatus({ models, fetchImpl: gatewayFetch });
assert.equal(creditCalls.length, 0);
assert.equal(status.status, "low");
check("balance cached inside TTL");

// 4. Threshold is configurable.
status = await credits.gatewayCreditStatus({ models, fetchImpl: gatewayFetch, env: { ...process.env, TASKNODE_GATEWAY_CREDIT_LOW_BALANCE_USD: "2" } });
assert.equal(status.status, "ok");
assert.equal(status.lowBalance, false);
assert.equal(status.warning, "");
check("low-balance threshold configurable via TASKNODE_GATEWAY_CREDIT_LOW_BALANCE_USD");

// 5. Never blocks: a hanging credits endpoint on a cold cache returns
//    "unknown" within the wait budget.
credits.resetGatewayCreditCache();
const startedAt = Date.now();
status = await credits.gatewayCreditStatus({ models, maxWaitMs: 50, fetchImpl: () => new Promise(() => {}) });
assert.ok(Date.now() - startedAt < 1000);
assert.equal(status.status, "unknown");
assert.equal(status.lowBalance, false);
assert.match(status.warning, /unavailable/);
check("cold cache with hanging endpoint answers within the wait budget");

// 6. Exhausted and unreadable balances.
credits.resetGatewayCreditCache();
balances.set(KIMI_KEY, "0.00");
status = await credits.gatewayCreditStatus({ models, fetchImpl: gatewayFetch, maxWaitMs: 1000 });
assert.equal(status.status, "exhausted");
assert.match(status.warning, /exhausted for VERCEL_KIMI_API_KEY/);
credits.resetGatewayCreditCache();
balances.delete(GATEWAY_KEY);
status = await credits.gatewayCreditStatus({ models, fetchImpl: gatewayFetch, maxWaitMs: 1000 });
assert.equal(status.credentials.find((item) => item.credential === "VERCEL_AI_GATEWAY_API_KEY").error, "gateway_credits_http_401");
noKeys(status);
balances.set(GATEWAY_KEY, "184.75");
balances.set(KIMI_KEY, "3.20");
check("exhausted balance and unreadable key reported, still no key material");

// 7. /api/readiness exposes the field. readiness() uses global fetch.
credits.resetGatewayCreditCache();
const realFetch = globalThis.fetch;
globalThis.fetch = gatewayFetch;
let ready;
try { ready = await readiness(); } finally { globalThis.fetch = realFetch; }
assert.equal(ready.llm.aiGatewayConfigured, true);
assert.equal(ready.llm.gatewayCredits.lowBalance, true);
assert.equal(ready.llm.gatewayCredits.balanceUsd, 3.2);
assert.equal(ready.llm.warnings.length, 1);
noKeys(ready);
check("/api/readiness llm.gatewayCredits + llm.warnings");

// 8. Transport: gateway insufficient-credit errors become inference_http_402.
const env = { VERCEL_AI_GATEWAY_API_KEY: "fixture", VERCEL_AI_GATEWAY_BASE_URL: "https://gateway.invalid/v1" };
const body = { model: INFERENCE_MODELS.structured, messages: [{ role: "user", content: "hi" }] };
for (const [label, response] of [
  ["http_402", () => Response.json({ error: { type: "insufficient_funds", message: "private detail" } }, { status: 402 })],
  ["body_error_200", () => Response.json({ error: { type: "insufficient_funds", message: "private detail" } }, { status: 200 })],
  ["budget_402", () => Response.json({ error: { type: "quota_for_entity_exceeded", message: "private detail" } }, { status: 402 })],
]) {
  await assert.rejects(inferenceChatCompletion({ env, body, fetchImpl: async () => response() }), (error) => {
    assert.equal(error.code, "inference_http_402", label);
    assert.equal(error.message.includes("private detail"), false);
    assert.equal(credits.isInferenceCreditError(error), true);
    return true;
  });
}
check("transport maps 402 / insufficient_funds / quota_for_entity_exceeded to inference_http_402");

// 9. Classification survives the wrappers task generation puts around it.
const wrapped = await assessTaskIntent({ need: "x" }, { complete: async () => { throw Object.assign(new Error("inference_http_402"), { code: "inference_http_402", status: 402 }); } }).catch((error) => error);
assert.equal(wrapped.code, "network_task_intent_assessment_failed");
assert.equal(credits.isInferenceCreditError(wrapped), true);
assert.equal(credits.isInferenceCreditError({ code: "inference_http_429", status: 429 }), false);
assert.equal(credits.isInferenceCreditError(new Error("taskgen_provider_timeout")), false);
check("credit errors recognised through assessment/taskgen wrappers; 429 and timeouts are not");

// 10. User-facing request state never shows the raw code.
const publicRow = publicTaskRequest({
  request_id: "req_fixture", account_id: "acct_fixture", status: "failed", last_error: "inference_http_402",
  metadata_json: { workerError: "inference_http_402", lastProviderFailure: { code: "inference_http_402", status: 402 }, workerRetry: { error: "inference_http_402" } },
});
assert.equal(publicRow.lastError, "task generation is temporarily unavailable");
assert.equal(publicRow.lastErrorCode, "task_generation_temporarily_unavailable");
assert.equal(publicRow.metadata.workerError, "task generation is temporarily unavailable");
assert.equal(publicRow.metadata.workerRetry.error, "task generation is temporarily unavailable");
assert.equal(publicRow.metadata.lastProviderFailure.code, "task_generation_temporarily_unavailable");
assert.equal(JSON.stringify(publicRow).includes("inference_http_402"), false);
const otherRow = publicTaskRequest({ request_id: "req_other", status: "failed", last_error: "taskgen_provider_timeout", metadata_json: {} });
assert.equal(otherRow.lastError, "taskgen_provider_timeout");
assert.equal("lastErrorCode" in otherRow, false);
check("public task request maps inference_http_402 to 'task generation is temporarily unavailable'");

// 11. Breaker: closed while credits are 0, recovers when they return,
//     probes once per re-check when the balance is unreadable, backs off.
credits.resetGatewayCreditCache();
credits.resetTaskGenerationCreditOutage();
const breakerEnv = { ...process.env, TASKNODE_TASKGEN_CREDIT_RECHECK_MS: "60000" };
let clock = 1_000_000;
const now = () => clock;
assert.equal((await credits.taskGenerationCreditGate({ env: breakerEnv, models, fetchImpl: gatewayFetch, now })).open, true);
credits.noteTaskGenerationCreditOutage({ code: "inference_http_402" }, { now: clock });
balances.set(KIMI_KEY, "0");
let gate = await credits.taskGenerationCreditGate({ env: breakerEnv, models, fetchImpl: gatewayFetch, now });
assert.deepEqual([gate.open, gate.reason], [false, "credit_recheck_pending"]);
creditCalls = [];
clock += 60_000;
gate = await credits.taskGenerationCreditGate({ env: breakerEnv, models, fetchImpl: gatewayFetch, now });
assert.deepEqual([gate.open, gate.reason, creditCalls.length], [false, "gateway_credits_exhausted", 2]);
balances.set(KIMI_KEY, "50.00");
clock += 30_000;
assert.equal((await credits.taskGenerationCreditGate({ env: breakerEnv, models, fetchImpl: gatewayFetch, now })).open, false, "no re-check before the interval");
clock += 30_000;
gate = await credits.taskGenerationCreditGate({ env: breakerEnv, models, fetchImpl: gatewayFetch, now });
assert.deepEqual([gate.open, gate.recovered, gate.credits.balanceUsd], [true, true, 50]);
credits.noteTaskGenerationCreditOutage({ code: "inference_http_402" }, { now: clock });
assert.equal(credits.taskGenerationCreditRecheckMs(credits.taskGenerationCreditOutageState().trips, breakerEnv), 120_000, "second consecutive trip doubles the re-check interval");
clock += 120_000;
gate = await credits.taskGenerationCreditGate({ env: breakerEnv, models, fetchImpl: async () => { throw new Error("down"); }, now });
assert.deepEqual([gate.open, gate.probe], [true, true]);
credits.noteTaskGenerationInferenceSuccess();
assert.equal(credits.taskGenerationCreditOutageState().active, false);
check("credit breaker: closed at $0, recovers when credits return, bounded probes with backoff");

// 12. Usage meter captures tokens and gateway cost for attribution.
const meter = createInferenceUsageMeter();
await meter.run(() => inferenceChatCompletion({ env, body, fetchImpl: async () => Response.json({
  id: "gen_fixture_1", model: INFERENCE_MODELS.structured,
  choices: [{ message: { content: "ok", provider_metadata: { gateway: { cost: "0.012345" } } }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } },
}) }));
assert.equal(meter.completions.length, 1);
assert.deepEqual(
  { provider: meter.completions[0].provider, model: meter.completions[0].model, inputTokens: meter.completions[0].inputTokens, outputTokens: meter.completions[0].outputTokens, cachedInputTokens: meter.completions[0].cachedInputTokens, providerCostUsd: meter.completions[0].providerCostUsd, responseId: meter.completions[0].responseId },
  { provider: "vercel", model: INFERENCE_MODELS.structured, inputTokens: 1200, outputTokens: 300, cachedInputTokens: 200, providerCostUsd: 0.012345, responseId: "gen_fixture_1" },
);
check("inference usage meter records provider/model/tokens/cost");

console.log(JSON.stringify({ sampleReadinessLlm: ready.llm }, null, 2));
console.log(JSON.stringify({ ok: true, checks }, null, 2));
