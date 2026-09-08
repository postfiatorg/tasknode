import assert from "node:assert/strict";
import { DOCS_ASSISTANT_LIMITS, generateDocsAssistantResponse } from "../server/docs-odv.js";
import { inferenceChatCompletion } from "../server/inference.js";
import { matchCollaborationPath, handleCollaborationRoute } from "../server/collaboration-routes.js";

const env = { VERCEL_AI_GATEWAY_API_KEY: "fixture", AMBIENT_API_KEY: "fixture-backup" };
const longAnswer = "Detailed analysis with actionable next steps.\n".repeat(3000) + "END_OF_COMPLETE_ANSWER";
const complete = () => new Response(JSON.stringify({ model: "zai/glm-5.3", choices: [{ finish_reason: "stop", message: { content: longAnswer } }] }));
const truncated = () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "incomplete answer must not be delivered" } }] }));
const denied = { ok: false, status: 403, error: "docs_access_required" };
const input = (prompt) => ({ accountId: "fixture", documentId: "00000000-0000-4000-8000-000000000000", channelHash: "a".repeat(32), prompt, documentContent: "A research plan with milestones, dependencies, and unanswered questions." });
const dependencies = (fetchImpl, logs = []) => ({ authorize: async () => ({ ok: true }), reportFailure: event => logs.push(event), infer: options => inferenceChatCompletion({ ...options, env, fetchImpl }) });
assert.equal(DOCS_ASSISTANT_LIMITS.completionTokens, 32768);
assert.equal(DOCS_ASSISTANT_LIMITS.retryCompletionTokens, 65536);
assert.ok(DOCS_ASSISTANT_LIMITS.providerTimeoutMs >= 300000);
assert.ok(DOCS_ASSISTANT_LIMITS.totalTimeoutMs > DOCS_ASSISTANT_LIMITS.providerTimeoutMs);

for (const prompt of ["@coach thoughts on this", "Could you review this thoroughly @COACH?", "@ODV explain the trade-offs and next steps"]) {
  const budgets = [];
  let firstSignal;
  const result = await generateDocsAssistantResponse(input(prompt), dependencies(async (_url, options) => {
    const request = JSON.parse(options.body);
    budgets.push(request.max_tokens);
    firstSignal ||= options.signal;
    assert.equal(request.model, "zai/glm-5.3");
    assert.ok(request.messages[1].content.includes(prompt));
    return budgets.length === 1 ? truncated() : complete();
  }));
  assert.equal(result.ok, true);
  assert.equal(result.response, longAnswer);
  assert.deepEqual(budgets, [32768, 65536]);
  assert.ok(firstSignal instanceof AbortSignal);
}

let deniedCalls = 0;
assert.equal(await generateDocsAssistantResponse(input("@coach review this"), { authorize: async () => denied, infer: async () => { deniedCalls += 1; } }), denied);
assert.equal(deniedCalls, 0);
let attempts = 0;
const logs = [];
const exhausted = await generateDocsAssistantResponse(input("@coach explain"), dependencies(async () => { attempts += 1; return truncated(); }, logs));
assert.equal(attempts, 2);
assert.equal(exhausted.ok, false);
assert.equal(exhausted.error, "docs_assistant_response_limit");
assert.ok(exhausted.message.includes("split"));
assert.equal(logs.length, 1);
assert.equal(logs[0].completionTokens, 65536);

const fallbackCalls = [];
const fallback = await generateDocsAssistantResponse(input("@coach review"), dependencies(async url => {
  fallbackCalls.push(new URL(url).host);
  return fallbackCalls.length === 1 ? new Response(JSON.stringify({ error: { message: "private upstream data" } }), { status: 503 }) : complete();
}));
assert.equal(fallback.provider, "ambient");
assert.equal(fallback.response, longAnswer);
assert.equal(fallbackCalls.length, 2);
for (const [code, expected] of [["inference_timeout", "docs_assistant_timeout"], ["inference_http_429", "docs_assistant_busy"], ["inference_http_400", "docs_assistant_unavailable"]]) {
  let calls = 0;
  const events = [];
  const result = await generateDocsAssistantResponse(input("@ODV review"), { authorize: async () => ({ ok: true }), reportFailure: value => events.push(value), infer: async () => { calls += 1; throw Object.assign(new Error("private prompt and credential details"), { code }); } });
  assert.equal(calls, 1);
  assert.equal(result.error, expected);
  assert.ok(result.message);
  assert.ok(!JSON.stringify({ result, events }).includes("private prompt"));
}

const id = input("").documentId;
for (const action of ["assistant", "odv", "share", "tasks"]) {
  const path = `/api/docs/documents/${id}/${action}`;
  assert.deepEqual(matchCollaborationPath(path, `/api/docs/documents/:uuid/${action}`), [path, id]);
  let response;
  await handleCollaborationRoute({ req: { method: "OPTIONS" }, res: {}, session: { accountId: "fixture" }, url: new URL("http://localhost" + path), readJson: async () => { throw new Error("wrong methods must not read input"); }, json: (_res, status, body) => { response = { status, body }; } });
  assert.equal(response.status, 405);
}
for (const value of ["x".repeat(36), "-".repeat(36), id + "/extra", ""]) assert.equal(matchCollaborationPath(`/api/docs/documents/${value}/assistant`, "/api/docs/documents/:uuid/assistant"), null);
console.log("Docs assistants: large complete responses, both personas, token-limit recovery, bounded retries, backup, safe failures, and route validation passed.");
