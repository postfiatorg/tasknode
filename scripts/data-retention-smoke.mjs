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
  const backlog = { auth_sessions: 2500 };
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT id") && sql.includes("FROM chat_conversations")) {
        return { rows: [{ id: "deleted-chat-a" }, { id: "deleted-chat-b" }], rowCount: 2 };
      }
      if (sql.includes("DELETE FROM telegram_bot_events")) throw new Error("canceling statement due to statement timeout");
      const table = sql.match(/^DELETE FROM (\w+) WHERE ctid/)?.[1];
      if (table && backlog[table]) {
        const deleted = Math.min(backlog[table], 1000);
        backlog[table] -= deleted;
        return { rows: [], rowCount: deleted };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const result = await runDataRetention({ now, databaseReady: true, transactionImpl: (work) => work(client), queryImpl: client.query });
  assert.equal(result.enabled, true);
  assert.equal(result.database.conversations, 1);
  assert.deepEqual(calls[0].params, ["2026-07-16T12:00:00.000Z", 1000]);
  const conversationDeletes = calls.filter((entry) => Array.isArray(entry.params[0]) && entry.params[0][0] === "deleted-chat-a");
  assert.deepEqual(conversationDeletes.map((entry) => entry.params[0]), Array(6).fill(["deleted-chat-a", "deleted-chat-b"]));
  assert.match(conversationDeletes.at(-1).sql, /DELETE FROM chat_conversations/);
  assert.equal(result.database.authSessionsExpired, 2500, "large backlogs drain in bounded batches");
  assert.equal(calls.filter((entry) => entry.sql.startsWith("DELETE FROM auth_sessions")).length, 3);
  assert.match(result.errors.telegramEventsExpired, /statement timeout/);
  for (const table of ["auth_challenges", "user_observability_events", "api_rate_limit_buckets", "account_deletion_audit", "hive_board_secretary_memos"]) {
    assert.equal(calls.some((entry) => entry.sql.startsWith(`DELETE FROM ${table}`)), true, `${table} still purged after another table failed`);
  }
  assert.equal(calls.some((entry) => entry.sql.includes("UPDATE ")), false, "retention must delete expired content, not relabel it");

  console.log("data retention smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
