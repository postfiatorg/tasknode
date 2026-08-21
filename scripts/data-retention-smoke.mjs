import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknode-retention-smoke-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";

try {
  const { retentionSchedule, runDataRetention } = await import("../server/data-retention.js");
  assert.deepEqual(retentionSchedule({}), {
    deletedChatDays: 30,
    transientJobDays: 30,
    telegramEventDays: 30,
    observabilityDays: 90,
    collaborationAuditDays: 365,
    financialRecordDays: 2555,
    expiredRateLimitDays: 2,
  });
  assert.equal(retentionSchedule({ TASKNODE_RETENTION_DELETED_CHAT_DAYS: "0" }).deletedChatDays, 1);
  assert.equal(retentionSchedule({ TASKNODE_RETENTION_FINANCIAL_RECORD_DAYS: "99999" }).financialRecordDays, 3650);

  const calls = [];
  const now = Date.parse("2026-08-15T12:00:00Z");
  const result = await runDataRetention({
    now,
    databaseReady: true,
    transactionImpl: async (work) => work({
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT id") && sql.includes("FROM chat_conversations")) {
          return { rows: [{ id: "deleted-chat-a" }, { id: "deleted-chat-b" }], rowCount: 2 };
        }
        return { rows: [], rowCount: 1 };
      },
    }),
  });
  assert.equal(result.enabled, true);
  assert.equal(result.database.conversations, 1);
  assert.deepEqual(calls[0].params, ["2026-07-16T12:00:00.000Z", 1000]);
  const conversationDeletes = calls.filter((entry) => Array.isArray(entry.params[0]) && entry.params[0][0] === "deleted-chat-a");
  assert.deepEqual(conversationDeletes.map((entry) => entry.params[0]), Array(6).fill(["deleted-chat-a", "deleted-chat-b"]));
  assert.match(conversationDeletes.at(-1).sql, /DELETE FROM chat_conversations/);
  assert.equal(calls.some((entry) => entry.sql.includes("DELETE FROM auth_sessions")), true);
  assert.equal(calls.some((entry) => entry.sql.includes("DELETE FROM auth_challenges")), true);
  assert.equal(calls.some((entry) => entry.sql.includes("DELETE FROM user_observability_events")), true);
  assert.equal(calls.some((entry) => entry.sql.includes("DELETE FROM account_deletion_audit")), true);
  assert.equal(calls.some((entry) => entry.sql.includes("UPDATE ")), false, "retention must delete expired content, not relabel it");

  console.log("data retention smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
