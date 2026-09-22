import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TASKNODE_STORE_PATH = join(mkdtempSync(join(tmpdir(), "decisions-boundary-")), "store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";
const { decisionsAvailable, startCorbanuDecision, fetchCorbanuDecision } = await import("../server/corbanu-decisions.js");
const { createDecisionRouteHandler } = await import("../server/decision-routes.js");
const { decisionProjection } = await import("../server/repositories/decisions.js");
const env = { CORBANU_DEEP_RESEARCH_BASE_URL: "https://corbanu.test/", CORBANU_TASKNODE_INTEGRATION_SECRET: "fixture-secret" };
assert.equal(decisionsAvailable({ accountId: "acct-fixture", env }), true);
assert.equal(decisionsAvailable({ accountId: "", env }), false);
let captured;
await startCorbanuDecision({ accountId: "acct-fixture", requestId: "fixture-request", input: "Should we launch the pilot?", env,
  fetchImpl: async (url, options) => { captured = { url, options }; return Response.json({ id: "remote", status: "queued" }, { status: 202 }); } });
assert.equal(captured.url, "https://corbanu.test/internal/v1/decisions");
assert.deepEqual(JSON.parse(captured.options.body), { input: "Should we launch the pilot?", mode: "budget", format: "markdown" });
assert.equal(captured.options.headers.Authorization, undefined);
const canonical = [captured.options.headers["X-Corbanu-Timestamp"], "fixture-request", "POST", "/internal/v1/decisions",
  createHash("sha256").update(captured.options.body).digest("hex"), "acct-fixture"].join("\n");
assert.equal(captured.options.headers["X-Corbanu-Signature"], createHmac("sha256", "fixture-secret").update(canonical).digest("hex"));
const pdf = await fetchCorbanuDecision({ accountId: "acct-fixture", gatewayJobId: "remote", artifact: "pdf", env,
  fetchImpl: async () => new Response("%PDF-fixture", { headers: { "Content-Type": "application/pdf" } }) });
assert.equal(pdf.body.toString(), "%PDF-fixture");

const records = new Map(); let starts = 0, loseResponse = true;
const project = row => ({ record: row, job: decisionProjection(row).job,
  assistant: { id: "assistant-fixture", role: "assistant", body: decisionProjection(row).body, metadata: decisionProjection(row).metadata } });
const handler = createDecisionRouteHandler({
  decisionsAvailable: () => true,
  createDecisionJob: async body => {
    const prior = records.get(body.requestId);
    if (prior) { assert.equal(body.input, prior.original); return project(prior); }
    const row = { id: "local", account_id: body.accountId, conversation_id: body.conversationId, request_id: body.requestId,
      original: body.input, input: body.input + "\n\nSaved context snapshot", status: "starting", stage: "starting" };
    records.set(body.requestId, row); return project(row);
  },
  getDecisionJob: async ({ accountId, jobId }) => {
    const row = [...records.values()].find(r => r.id === jobId && r.account_id === accountId); return row ? project(row) : null;
  },
  updateDecisionJob: async ({ accountId, jobId, remote, markdown }) => {
    const row = [...records.values()].find(r => r.id === jobId && r.account_id === accountId);
    Object.assign(row, { gateway_job_id: remote.id, status: remote.status, stage: remote.stage, progress_json: remote, report_markdown: markdown || "", error: remote.error || "" });
    return project(row);
  },
  startCorbanuDecision: async body => {
    starts++; assert.equal(body.requestId, "request"); assert.ok(body.input.endsWith("Saved context snapshot"));
    if (loseResponse) { loseResponse = false; throw Object.assign(new Error("lost response"), { status: 504 }); }
    return { body: { id: "remote", status: "running", stage: "researching", completed_calls: 2 } };
  },
  fetchCorbanuDecision: async ({ accountId, artifact }) => {
    assert.equal(accountId, "acct-a");
    if (artifact === "result") return { body: { markdown: "# User Proposed Decision\n\nCompare the pilot options." } };
    if (artifact === "packet") return { body: { mode: "budget", votes: ["A", "A", "B"] } };
    return { body: { id: "remote", status: "completed", stage: "completed", selected: "A", vote_counts: { A: 2, B: 1, C: 0, D: 0, E: 0 }, completed_calls: 10 } };
  },
});
async function call(method, path, body, accountId = "acct-a") {
  let response;
  const res = { setHeader() {}, writeHead(status) { response = { status }; }, end(value) { response.body = value; } };
  const handled = await handler({ req: { method }, res, url: new URL(path, "https://tasknode.test"), session: { accountId }, readJson: async () => body,
    json: (_res, status, payload) => { response = { status, body: payload }; } });
  assert.equal(handled, true); return response;
}
const request = { input: "Compare a staged launch with a public release.", conversationId: "chat-fixture", requestId: "request", includeContext: true };
assert.equal((await call("POST", "/api/decisions/jobs", request, "")).status, 401);
assert.equal((await call("POST", "/api/decisions/jobs", { ...request, mode: "standard" })).status, 400);
const pending = await call("POST", "/api/decisions/jobs", request);
assert.equal(pending.status, 202); assert.equal(pending.body.job.status, "starting"); assert.equal(pending.body.record, undefined);
const resumed = await call("GET", "/api/decisions/jobs/local");
assert.equal(resumed.body.job.status, "running"); assert.equal(starts, 2);
assert.equal((await call("GET", "/api/decisions/jobs/local", null, "acct-b")).status, 404);
assert.equal((await call("GET", "/api/decisions/jobs/local/packet", null, "acct-b")).status, 404);
assert.equal((await call("GET", "/api/decisions/jobs/local/cancel")).status, 404);
const finished = await call("GET", "/api/decisions/jobs/local");
assert.equal(finished.body.job.status, "completed");
assert.equal(finished.body.assistant.metadata.decision.selected, "A");
assert.ok(finished.body.assistant.body.includes("Compare the pilot options"));
await call("GET", "/api/decisions/jobs/local"); assert.equal(starts, 2);
assert.equal((await call("GET", "/api/decisions/jobs/local/packet")).status, 200);
console.log("Decisions boundary smoke passed: signed budget request, PDF, owner isolation, lost-response recovery, report persistence, and no restart after completion.");
