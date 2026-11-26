import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { chatResearchAccess, fetchChatResearch } from "../server/chat-research-provider.js";
import { chatResearchImprovement, defaultChatResearchBudget } from "../shared/chat-research.js";

import {
  deepResearchAvailable,
  startCorbanuDeepResearch,
} from "../server/corbanu-deep-research.js";

const secret = "tasknode-deep-research-test-secret-with-enough-entropy";
const accountId = "acct_operator";
const env = {
  CORBANU_DEEP_RESEARCH_BASE_URL: "https://plan.example.test/",
  CORBANU_TASKNODE_INTEGRATION_SECRET: secret,
};

assert.equal(deepResearchAvailable({ accountId, env }), true);
assert.equal(deepResearchAvailable({ accountId: "acct_any_authenticated_user", env }), true);
assert.equal(deepResearchAvailable({
  accountId: "acct_outside_legacy_canary",
  env: { ...env, TASKNODE_DEEP_RESEARCH_ACCOUNT_IDS: "acct_legacy_canary" },
}), true);
assert.equal(deepResearchAvailable({ accountId: "", env }), false);
assert.equal(deepResearchAvailable({
  accountId,
  env: { ...env, CORBANU_TASKNODE_INTEGRATION_SECRET: "" },
}), false);

let captured;
const result = await startCorbanuDeepResearch({
  accountId,
  requestId: "deepresearch_request_123",
  question: "Compare the evidence from primary sources.",
  title: "Primary-source comparison",
  env,
  fetchImpl: async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ id: "gateway_job_123", status: "QUEUED" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  },
});

assert.equal(result.status, 202);
assert.equal(result.body.id, "gateway_job_123");
assert.equal(captured.url, "https://plan.example.test/internal/v1/deep-research");
assert.equal(captured.options.method, "POST");
assert.equal(captured.options.headers.Authorization, undefined);
assert.equal(captured.options.headers["X-Corbanu-Subject"], accountId);
assert.equal(captured.options.headers["X-Corbanu-Request-Id"], "deepresearch_request_123");

const rawBody = captured.options.body;
assert.deepEqual(JSON.parse(rawBody), {
  question: "Compare the evidence from primary sources.",
  title: "Primary-source comparison",
});
const timestamp = captured.options.headers["X-Corbanu-Timestamp"];
const bodyHash = createHash("sha256").update(rawBody).digest("hex");
const canonical = [
  timestamp,
  "deepresearch_request_123",
  "POST",
  "/internal/v1/deep-research",
  bodyHash,
  accountId,
].join("\n");
const expectedSignature = createHmac("sha256", secret).update(canonical).digest("hex");
assert.equal(captured.options.headers["X-Corbanu-Signature"], expectedSignature);

const configured = { ...env, GA_RESEARCH_URL: "https://research.example.test", GA_RESEARCH_HMAC_SECRET: secret };
for (const accountId of ["acct_validator", "acct_new_nonvalidator"]) {
  assert.deepEqual(await chatResearchAccess({ accountId, env: configured }), { provider: "goodalexander", available: true, atCost: true });
  assert.equal((await chatResearchAccess({ accountId, env: { ...configured, CHAT_RESEARCH_PROVIDER: "corbanu" } })).provider, "corbanu");
  assert.equal((await chatResearchAccess({ accountId, env: { ...configured, GA_RESEARCH_URL: "" } })).available, false, "missing GA config cannot silently route to Corbanu");
}
assert.equal((await chatResearchAccess({ accountId: "", env: configured })).available, false);
for (const [balance, budget] of [[20, 1.5], [1.5, 1.5], [1.234567, 1.234567], [.5, .5], [.499999, 1.5], [undefined, 1.5]]) {
  assert.equal(defaultChatResearchBudget(balance), budget);
}
for (const [round_status, label] of [["completed", "done"], ["skipped_unaffordable", "skipped"], ["interrupted", "interrupted"], ["running", "running"], ["not_started", null], ["unrecognized", null], [undefined, null]]) {
  assert.equal(chatResearchImprovement({ round_status }), label);
}
assert.equal(chatResearchImprovement(null), null);
// Stored provider remains authoritative when the default changes during a job.
let legacyReads = 0;
const legacy = await fetchChatResearch({ accountId, job: { provider: "corbanu", gatewayJobId: "old-job" } }, {
  getGa: () => { throw Error("legacy job sent to GA"); },
  fetchCorbanu: async () => { legacyReads++; return { body: { status: "completed" } }; },
  resultCorbanu: async () => { legacyReads++; return { body: { result: { markdown: "Existing legacy report" } } }; },
});
assert.equal(legacy.result.markdown, "Existing legacy report"); assert.equal(legacyReads, 2);

console.log("deep research boundary smoke ok: all-account GA default, explicit rollback, durable legacy reads, balance-aware 1.50 default, typed round status and signed gateway contract");
