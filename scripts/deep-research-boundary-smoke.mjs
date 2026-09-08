import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

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

console.log("deep research boundary smoke ok: authenticated access and signed private gateway contract verified");
