import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required; test uses an isolated temporary schema");
const originalUrl = process.env.DATABASE_URL;
const schema = `decisions_fixture_${Date.now()}`;
const admin = new pg.Pool({ connectionString: originalUrl });
await admin.query(`CREATE SCHEMA ${schema}`);
const url = new URL(originalUrl); url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
process.env.TASKNODE_DATABASE_ENABLED = "true";
const directory = await mkdtemp(join(tmpdir(), "decisions-pg-"));
process.env.TASKNODE_STORE_PATH = join(directory, "store.json");
const { query, closePool } = await import("../server/db/pool.js");
const { createDecisionJob, getDecisionJob, updateDecisionJob } = await import("../server/repositories/decisions.js");
try {
  await query(await readFile(new URL("../server/db/migrations/001_chat_billing.sql", import.meta.url), "utf8"));
  await query(await readFile(new URL("../server/db/migrations/141_decision_jobs.sql", import.meta.url), "utf8"));
  await query(await readFile(new URL("../server/db/migrations/142_decision_context_snapshot.sql", import.meta.url), "utf8"));
  await query(await readFile(new URL("../server/db/migrations/147_decision_mode.sql", import.meta.url), "utf8"));
  let context = "Original saved context";
  let memory = "The user lives in Montreal and is learning French to participate in the local community.";
  let loads = 0;
  const opts = {
    loadContext: async () => ({ id: "fixture-context", revision: 7, body: context }),
    loadMemories: async ({ accountId, deepLimit, turnLimit }) => {
      assert.ok(["fixture-a", "fixture-b"].includes(accountId));
      assert.equal(deepLimit, 3); assert.equal(turnLimit, 36); loads++;
      return { deepMemories: [{ id: "fixture-deep", kind: "deep_memory", createdAt: "2026-09-01", memoryText: memory, userRequestSummary: "Lives in Montreal.", systemResponseSummary: "An earlier suggestion, not a user commitment." }],
        memories: [{ id: "fixture-recent", kind: "turn_memory", createdAt: "2026-09-18", memoryText: "Latest correction: evening classes are already paid for." }] };
    },
  };
  const request = { accountId: "fixture-a", conversationId: "fixture-chat", input: "Which launch approach best fits our constraints?", requestId: "fixture-request", includeContext: true };
  const results = await Promise.all([createDecisionJob(request, opts), createDecisionJob(request, opts)]);
  assert.equal(results[0].job.id, results[1].job.id);
  assert.equal(Number((await query("SELECT count(*) FROM chat_messages")).rows[0].count), 2);
  assert.equal(loads, 1);
  assert.ok(results[0].record.input.includes(memory));
  assert.ok(results[0].record.input.includes("evening classes are already paid for"));
  assert.equal(results[0].assistant.metadata.decision.contextSnapshot.document.revision, 7);
  assert.deepEqual(results[0].record.context_snapshot_json.memoryIds, ["fixture-deep", "fixture-recent"]);
  context = "A newer context that must not replace the snapshot";
  memory = "New memory must not replace the snapshot";
  const retry = await createDecisionJob(request, opts);
  assert.ok(retry.record.input.includes("Original saved context"));
  assert.ok(!retry.record.input.includes(context));
  assert.ok(!retry.record.input.includes(memory));
  assert.equal(loads, 1);
  await assert.rejects(createDecisionJob({ ...request, input: "Changed question" }, opts), { status: 409 });
  assert.equal(await getDecisionJob({ accountId: "fixture-b", jobId: retry.job.id }), null);
  await assert.rejects(createDecisionJob({ ...request, accountId: "fixture-b" }, opts), { status: 404 });
  const without = await createDecisionJob({ ...request, conversationId: "no-context", requestId: "without", includeContext: false }, { loadContext: () => { throw new Error("must not load context"); }, loadMemories: () => { throw new Error("must not load memory"); } });
  assert.equal(without.record.input, request.input);
  assert.equal(without.assistant.metadata.decision.contextIncluded, false);
  await assert.rejects(createDecisionJob({ ...request, requestId: "oversized" }, { ...opts, loadContext: async () => ({ body: "x".repeat(60_000) }) }), { status: 400 });
  await assert.rejects(createDecisionJob({ ...request, requestId: "memory-unavailable" }, { ...opts, loadMemories: async () => { throw new Error("memory unavailable"); } }), { message: "memory unavailable" });
  assert.equal(Number((await query("SELECT count(*) FROM decision_jobs WHERE request_id IN ('oversized','memory-unavailable')")).rows[0].count), 0);
  const memoryOnly = await createDecisionJob({ ...request, conversationId: "memory-only", requestId: "memory-only" }, { ...opts, loadContext: async () => null });
  assert.equal(memoryOnly.record.context_included, true);
  assert.equal(memoryOnly.record.context_snapshot_json.document, null);
  assert.equal(memoryOnly.record.context_snapshot_json.recentMemoryCount, 1);
  const completed = await updateDecisionJob({ accountId: request.accountId, jobId: retry.job.id, remote: { id: "remote-fixture", status: "completed", stage: "completed", selected: "B", vote_counts: { A: 0, B: 3, C: 0, D: 0, E: 0 }, completed_calls: 10 }, markdown: "# Decision report\n\nChoose option B." });
  assert.equal(completed.assistant.body, "# Decision report\n\nChoose option B.");
  assert.equal(completed.assistant.metadata.decision.selected, "B");
  assert.deepEqual(completed.assistant.metadata.decision.contextSnapshot.memoryIds, ["fixture-deep", "fixture-recent"]);
  const stale = await updateDecisionJob({ accountId: request.accountId, jobId: retry.job.id, remote: { id: "remote-fixture", status: "running", stage: "voting" } });
  assert.equal(stale.job.status, "completed");
  assert.equal(stale.assistant.body, completed.assistant.body);
  assert.equal(retry.record.mode, "budget");
  const premium = await createDecisionJob({ ...request, conversationId: "premium-chat", requestId: "premium", mode: "premium" }, opts);
  assert.equal(premium.record.mode, "premium");
  assert.equal(premium.assistant.metadata.decision.mode, "premium");
  assert.equal(premium.assistant.metadata.decision.totalCalls, 15);
  await assert.rejects(createDecisionJob({ ...request, conversationId: "premium-chat", requestId: "premium" }, opts), { status: 409 });
  await assert.rejects(query("UPDATE decision_jobs SET mode='deluxe' WHERE request_id='premium'"));
  console.log("Decisions PostgreSQL smoke passed: concurrent idempotency, context snapshot, account ownership, rollback, saved report, stale-poll protection, and persisted budget/premium mode.");
} finally {
  await closePool(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true });
}
