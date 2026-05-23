import assert from "node:assert/strict";
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
delete process.env.DATABASE_URL;
delete process.env.TASKNODE_DATABASE_ENABLED;

try {
  const { authDevStart, chatSend } = await import("../server/product-contracts.js");
  const {
    buildChatContextStatus,
    buildMemoryContextStatus,
    memoryContextIsEmpty,
  } = await import("../server/chat-context-status.js");
  const { loadChatExecutionContext } = await import("../server/chat-context-load.js");

  assert.equal(memoryContextIsEmpty(null), true);
  assert.equal(memoryContextIsEmpty({ deepMemories: [], memories: [] }), true);
  assert.equal(
    buildMemoryContextStatus({ context: { deepMemories: [{ id: "1" }], memories: [] }, state: "included" }).included,
    true
  );

  const blockedStatus = buildChatContextStatus({
    memoryStatus: buildMemoryContextStatus({ state: "timeout" }),
    jobsRetrieval: { skipped: true, reason: "disabled" },
  });
  assert.equal(blockedStatus.memory.state, "timeout");
  assert.equal(blockedStatus.jobsRetrieval.state, "skipped");

  const devAuth = authDevStart({ email: "chat-context-status@tasknode.local" }, "POST");
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

  console.log("chat-context-status-smoke passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
