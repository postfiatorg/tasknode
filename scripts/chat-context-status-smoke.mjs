import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-chat-context-status-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_ENV = "development";
process.env.NODE_ENV = "development";
process.env.TASKNODE_DEV_AUTH_ENABLED = "true";
process.env.OPENAI_API_KEY = "chat-context-status-smoke-key";
process.env.OPENROUTER_API_KEY = "chat-context-status-smoke-key";
process.env.TASKNODE_CHAT_MEMORY_CONTEXT_TIMEOUT_MS = "1";
process.env.TASKNODE_CHAT_TASK_CONTEXT_TIMEOUT_MS = "1";
process.env.TASKNODE_CHAT_CONTEXT_DOCUMENT_TIMEOUT_MS = "1";
process.env.TASKNODE_JOBS_RETRIEVAL_ENABLED = "false";
const postgresDatabaseUrl = process.env.DATABASE_URL || process.env.TASKNODE_DATABASE_URL || "";
delete process.env.DATABASE_URL;
delete process.env.TASKNODE_DATABASE_ENABLED;

try {
  const {
    buildChatContextStatus,
    buildJobsRetrievalStatus,
    buildMemoryContextStatus,
    memoryContextIsEmpty,
  } = await import("../server/chat-context-status.js");
  const { authDevStart, chatSend } = await import("../server/product-contracts.js");
  const { loadChatExecutionContext } = await import("../server/chat-context-load.js");

  assert.equal(memoryContextIsEmpty(null), true);
  assert.equal(memoryContextIsEmpty({ deepMemories: [], memories: [] }), true);
  assert.equal(
    buildMemoryContextStatus({ context: { deepMemories: [{ id: "1" }], memories: [] }, state: "included" }).included,
    true
  );

  const jobsTimeoutStatus = buildJobsRetrievalStatus({
    ok: false,
    skipped: true,
    reason: "jobs_retrieval_timeout",
    chunks: [],
  });
  assert.equal(jobsTimeoutStatus.state, "timeout");
  assert.equal(jobsTimeoutStatus.reason, "jobs_retrieval_timeout");

  const blockedStatus = buildChatContextStatus({
    memoryStatus: buildMemoryContextStatus({ state: "timeout" }),
    jobsRetrieval: { skipped: true, reason: "disabled" },
  });
  assert.equal(blockedStatus.memory.state, "timeout");
  assert.equal(blockedStatus.jobsRetrieval.state, "skipped");

  const devAuth = await authDevStart({ email: "chat-context-status@tasknode.local" }, "POST");
  assert.equal(devAuth.status, 200);
  const accountId = devAuth.body.session.accountId;

  const loaded = await loadChatExecutionContext(accountId);
  assert.ok(loaded.contextStatus);
  assert.equal(typeof loaded.contextStatus.contextDocument.state, "string");
  assert.equal(typeof loaded.contextStatus.memory.state, "string");
  assert.equal(typeof loaded.contextStatus.tasks.state, "string");

  const dryRun = await chatSend(
    {
      accountId,
      message: "Context status dry run.",
      mode: "Frontier Instant",
      conversationId: `account_${accountId}_context_status_smoke`,
      dryRun: true,
    },
    "POST"
  );
  assert.equal(dryRun.status, 200);
  assert.equal(dryRun.body.dryRun, true);
  assert.ok(dryRun.body.contextStatus);
  assert.equal(typeof dryRun.body.contextStatus.memory.state, "string");
  assert.equal(typeof dryRun.body.contextStatus.tasks.state, "string");
  assert.equal(typeof dryRun.body.contextStatus.contextDocument.state, "string");

  console.log("chat-context-status-smoke unit checks passed");

  if (!postgresDatabaseUrl) {
    console.log("chat-context-status-smoke skipped Postgres persistence (DATABASE_URL unset)");
  } else {
    process.env.DATABASE_URL = postgresDatabaseUrl;
    process.env.TASKNODE_DATABASE_ENABLED = "true";
    const { migrateDatabase } = await import("../server/db/migrate.js");
    const { query, closePool } = await import("../server/db/pool.js");
    const { appendChatTurn } = await import("../server/repositories/chat-billing.js");

    await migrateDatabase();

    const suffix = randomUUID().slice(0, 8);
    const pgAccountId = `acct_ctx_status_${suffix}`;
    const conversationId = `account_${pgAccountId}_default`;
    const responseId = `resp_ctx_status_${suffix}`;
    const persistedContextStatus = buildChatContextStatus({
      memoryStatus: buildMemoryContextStatus({ state: "empty" }),
      jobsRetrieval: { skipped: true, reason: "smoke" },
    });

    await appendChatTurn({
      accountId: pgAccountId,
      conversationId,
      mode: "Frontier Instant",
      provider: "openai",
      model: "chat-latest",
      responseId,
      userMessage: "Persist contextStatus metadata.",
      assistantMessage: "Persisted.",
      runMetadata: { contextStatus: persistedContextStatus },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 0,
      },
    });

    const row = await query(
      `
        SELECT metadata_json
        FROM chat_model_runs
        WHERE account_id = $1
          AND response_id = $2
        ORDER BY started_at DESC
        LIMIT 1
      `,
      [pgAccountId, responseId]
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].metadata_json?.contextStatus?.memory?.state, "empty");
    assert.equal(row.rows[0].metadata_json?.contextStatus?.jobsRetrieval?.state, "skipped");
    await closePool();
    console.log("chat-context-status-smoke Postgres persistence passed");
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("chat-context-status-smoke passed");
