import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { query, transaction, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { insertLedgerEntry } from "../server/repositories/chat-billing.js";
import { handleDeepResearchRoute } from "../server/deep-research-routes.js";
import { getResearchJob, reserveResearchJob } from "../server/repositories/research-gateway.js";
import { refreshResearchJob, submitResearchJob } from "../server/research-gateway.js";
import { attachDeepResearchGatewayJob, updateDeepResearchJob } from "../server/repositories/deep-research.js";

const owner = `agent_smoke_${randomUUID()}`, other = `${owner}_other`;
const originalFetch = globalThis.fetch;
const saved = new Map();
let creates = 0, sequence = 1, terminal = false, failure = false;
const cost = .123456789;
const progress = () => ({ sequence, stage: terminal ? failure ? "failed" : "completed" : "extracting", step: 2, step_limit: 25,
  documents_total: 214, documents_completed: terminal ? 214 : 100, elapsed_seconds: sequence === 1 ? 20 : 901,
  cost_usd: terminal ? cost : .07, updated_at: "2026-10-29T00:00:00Z" });
async function route(path, { method = "GET", payload, account = owner } = {}) {
  let status, body;
  await handleDeepResearchRoute({ req: { method }, res: {}, session: account ? { accountId: account } : null,
    url: new URL(path, "http://localhost"), readJson: async () => payload, json: (_res, code, value) => { status = code; body = value; } });
  return { status, body };
}
const post = (question, requestId, fields = {}) => route("/api/deep-research/jobs", { method: "POST",
  payload: { question, conversationId: `${owner}_conversation`, requestId, ...fields } });
try {
  await migrateDatabase();
  process.env.GA_RESEARCH_URL = "https://research.example.test";
  process.env.GA_RESEARCH_HMAC_SECRET = "offline-fixture-secret";
  delete process.env.CHAT_RESEARCH_PROVIDER;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    assert.equal(new URL(url).hostname, "research.example.test", "no real provider calls");
    if (path === "/v1/research/preview") {
      const payload = JSON.parse(options.body);
      return Response.json({ route_token: "fixture-route", mode: "agent", reason: "Explore many sources", default_max_cost_usd: 3,
        min_cost_usd: .05, max_cost_usd: 10, expires_at: new Date(Date.now() + 900000).toISOString(),
        question_sha256: createHash("sha256").update(payload.question).digest("hex"), preview_cost_usd: 0 });
    }
    if (options.method === "POST") {
      const payload = JSON.parse(options.body);
      if (payload.route_token === "expired") return Response.json({ detail: "route_preview_invalid" }, { status: 409 });
      assert.equal(payload.resolved_mode, undefined, "private projection is not sent to the upstream API");
      if (!saved.has(payload.request_id)) { saved.set(payload.request_id, payload); creates++; }
      else assert.deepEqual(saved.get(payload.request_id), payload);
      return Response.json({ job_id: payload.request_id, status: "queued" });
    }
    const id = path.split("/")[3];
    assert.ok(saved.has(id));
    const state = { job_id: id, status: terminal ? failure ? "failed" : "completed" : "running", mode: "agent",
      progress: progress(), usage: { total_cost_usd: terminal ? cost : .07 } };
    return Response.json(path.endsWith("/result") ? { ...state, markdown: "# Answer\n\n| Date | Value |\n|---|---:|\n| 2025 | 3 |\n| 2026 | 4 |",
      quality: { tih: { round_status: "completed" } }, agent: { partial: true, coverage: { read: 214, total: 214 } },
      tables: [{ name: "Series", columns: [{ name: "year" }, { name: "value", unit: "%" }], rows: [{ year: 2025, value: 3 }, { year: 2026, value: 4 }], source_ids: ["F1"] }] } : state);
  };
  await transaction(client => insertLedgerEntry(client, { accountId: owner, kind: "account_credit", amountUsd: 20,
    source: "isolated_agent_fixture", uniqueKey: owner }));
  assert.equal((await route("/api/deep-research/preview", { method: "POST", payload: { question: "Read this week's earnings" }, account: null })).status, 401);
  const preview = await route("/api/deep-research/preview", { method: "POST", payload: { question: "Read this week's earnings" }, account: other });
  assert.equal(preview.status, 200); assert.equal(preview.body.preview.preview_cost_usd, 0);
  assert.equal(preview.body.preview.availableCreditUsd, 0);
  assert.equal((await query("SELECT count(*)::int n FROM research_gateway_jobs WHERE account_id=$1", [other])).rows[0].n, 0);
  const created = await post("Read this week's earnings", "agent", { mode: "agent", routeToken: preview.body.preview.route_token });
  assert.equal(created.status, 202); assert.equal(created.body.job.maxCostUsd, 3); assert.equal(created.body.job.mode, "agent");
  const id = created.body.job.id, gateway = created.body.job.gatewayJobId;
  assert.equal(saved.get(gateway).max_cost_usd, 3); assert.equal(saved.get(gateway).mode, "agent");
  sequence = 2;
  const running = await route(`/api/deep-research/jobs/${id}`);
  assert.equal(running.body.job.progress.elapsed_seconds, 901); assert.equal(running.body.assistant.metadata.deepResearch.progress.documents_total, 214);
  assert.equal(running.body.assistant.metadata.deepResearch.usage.total_cost_usd, .07);
  assert.equal((await query("SELECT count(*)::int n FROM billing_ledger_entries WHERE account_id=$1 AND kind='chat_debit'", [owner])).rows[0].n, 0);
  const stale = { job_id: gateway, status: "running", mode: "agent", progress: { ...progress(), sequence: 1, elapsed_seconds: 20 } };
  const persisted = await refreshResearchJob(await getResearchJob(owner, gateway), async () => stale);
  assert.equal(persisted.progress_json.sequence, 2);
  assert.equal((await route(`/api/deep-research/jobs/${id}`, { account: other })).status, 404);
  assert.equal((await post("Read this week's earnings", "agent", { mode: "fast", maxCostUsd: 3 })).status, 409);
  terminal = true; // A restart may publish terminal status at the last progress sequence.
  const result = await route(`/api/deep-research/jobs/${id}`);
  assert.equal(result.body.job.status, "completed");
  assert.equal(result.body.job.progress.stage, "completed");
  assert.equal(result.body.job.progress.cost_usd, cost);
  assert.equal(result.body.assistant.metadata.deepResearch.tables[0].rows.length, 2);
  assert.equal(result.body.assistant.metadata.deepResearch.partial, true);
  assert.equal(result.body.assistant.metadata.deepResearch.improvementRound, "done");
  assert.deepEqual((await route(`/api/deep-research/jobs/${id}`)).body, result.body);
  const unchanged = await updateDeepResearchJob({ accountId: owner, jobId: id, status: "running", progress: stale.progress });
  assert.deepEqual({ ok: true, ...unchanged }, result.body, "a late status response cannot erase a terminal chat report");
  for (const attached of await Promise.all(Array.from({ length: 3 }, () => attachDeepResearchGatewayJob({ accountId: owner, jobId: id, gatewayJobId: gateway })))) {
    assert.deepEqual({ ok: true, ...attached }, result.body, "late duplicate attaches cannot regress the completed report");
  }
  await assert.rejects(attachDeepResearchGatewayJob({ accountId: owner, jobId: id, gatewayJobId: "different-job" }), error => error.status === 409);
  assert.equal((await refreshResearchJob(persisted, async () => stale)).status, "completed", "terminal gateway wins stale worker poll");
  const replay = await post("Read this week's earnings", "agent", { mode: "agent", routeToken: "fresh-preview" });
  assert.equal(replay.body.job.id, id); assert.equal(replay.body.researchOptions, undefined); assert.equal(creates, 1);
  const debits = (await query("SELECT amount_usd::text FROM billing_ledger_entries WHERE account_id=$1 AND kind='chat_debit'", [owner])).rows;
  assert.deepEqual(debits, [{ amount_usd: "0.123457" }]);
  const expired = await post("Another research question", "expired", { mode: "agent", routeToken: "expired", maxCostUsd: 3 });
  assert.equal(expired.status, 409); assert.equal(expired.body.error, "route_preview_invalid"); assert.equal(creates, 1);
  const rejected = (await query("SELECT status,cost_usd::text,billed_at FROM research_gateway_jobs WHERE account_id=$1 AND request_key=$2", [owner, `chat:${expired.body.job.id}`])).rows[0];
  assert.equal(rejected.status, "failed"); assert.equal(Number(rejected.cost_usd), 0); assert.ok(rejected.billed_at);
  failure = true; sequence = 4;
  const failed = await post("Interrupted research", "failed", { mode: "agent", maxCostUsd: 3 });
  const failureResult = await route(`/api/deep-research/jobs/${failed.body.job.id}`);
  assert.equal(failureResult.body.job.status, "failed");
  assert.equal(failureResult.body.assistant.metadata.deepResearch.usage.billed_cost_usd, .123457);
  await route(`/api/deep-research/jobs/${failed.body.job.id}`);
  assert.equal((await query("SELECT count(*)::int n FROM billing_ledger_entries WHERE account_id=$1 AND kind='chat_debit'", [owner])).rows[0].n, 2);
  await assert.rejects(reserveResearchJob({ accountId: owner, question: "Limit", maxCostUsd: 10.000001, requestKey: "too-high" }));
  assert.equal((await post("Precise cap", "precision", { mode: "agent", maxCostUsd: 1.1234567 })).status, 400, "never round an explicit cap upward");
  failure = false;
  const defaultApi = await submitResearchJob({ accountId: owner }, { question: "Default API agent question" }, "api-default");
  assert.equal(defaultApi.request_json.mode, "agent"); assert.equal(defaultApi.request_json.max_cost_usd, 3);
  const createCount = creates;
  assert.equal((await submitResearchJob({ accountId: owner }, { question: "Default API agent question" }, "api-default")).id, defaultApi.id);
  assert.equal(creates, createCount);
  const maximum = await reserveResearchJob({ accountId: owner, question: "Limit", maxCostUsd: 10, requestKey: "maximum", mode: "agent" });
  assert.equal(maximum.request_json.max_cost_usd, 10);
  const unfunded = await route("/api/deep-research/jobs", { method: "POST", account: other,
    payload: { question: "No balance", requestId: "unfunded", conversationId: `${other}_conversation`, mode: "agent", maxCostUsd: 3 } });
  assert.equal(unfunded.status, 402);
  assert.equal((await query("SELECT count(*)::int n FROM research_gateway_jobs WHERE account_id=$1", [other])).rows[0].n, 0);
  await transaction(client => insertLedgerEntry(client, { accountId: other, kind: "account_credit", amountUsd: 2.123456,
    source: "isolated_agent_fixture", uniqueKey: other }));
  assert.equal((await route("/api/deep-research/jobs", { method: "POST", account: other,
    payload: { question: "No balance", requestId: "unfunded", conversationId: `${other}_conversation`, mode: "agent", maxCostUsd: 3 } })).body.job.status,
  "failed", "a terminal failed request replay never creates a paid job");
  const reservation = await reserveResearchJob({ accountId: other, question: "Pending work", maxCostUsd: 1, requestKey: "pending", mode: "fast" });
  const reservedPreview = await route("/api/deep-research/preview", { method: "POST", account: other, payload: { question: "Low balance agent" } });
  assert.equal(reservedPreview.body.preview.availableCreditUsd, 1.123456, "preview excludes pending reservations");
  const low = await route("/api/deep-research/jobs", { method: "POST", account: other,
    payload: { question: "Low balance agent", requestId: "low", conversationId: `${other}_conversation`, mode: "agent" } });
  assert.equal(low.status, 202); assert.equal(low.body.job.maxCostUsd, 1.123456);
  assert.ok(reservation.id);
  await route(`/api/deep-research/jobs/${low.body.job.id}`, { account: other });
  console.log("research-agent-postgres-smoke ok: free preview, agent default3/max10, durable 15min progress, terminal races, no intermediate debit, ceil6 once, expired preview release, incurred failure cost, replay and owner isolation");
} finally {
  globalThis.fetch = originalFetch;
  for (const table of ["deep_research_jobs", "chat_messages", "chat_conversations", "research_gateway_jobs", "billing_ledger_entries", "billing_accounts"]) {
    await query(`DELETE FROM ${table} WHERE account_id=ANY($1::text[])`, [[owner, other]]);
  }
  await closePool();
}
