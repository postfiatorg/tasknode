import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import { processMemoryQueueOnce } from "../server/chat-memory-worker.js";
import {
  enqueueChatMemoryJob,
  enqueueMissingDeepMemoryJobs,
} from "../server/repositories/chat-memory.js";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for memory backfill.");
}
if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const title = argValue("title", "whatwork");
const accountId = argValue("account", "");
const limit = Math.min(Math.max(Number(argValue("limit", "25")) || 25, 1), 250);
const processNow = process.argv.includes("--process");

await migrateDatabase();

const params = [limit];
let whereSql = "WHERE conversation.status = 'active'";
if (title) {
  params.push(title);
  whereSql += ` AND conversation.title = $${params.length}`;
}
if (accountId) {
  params.push(accountId);
  whereSql += ` AND conversation.account_id = $${params.length}`;
}

const rows = await query(
  `
    SELECT
      conversation.id AS conversation_id,
      conversation.account_id,
      conversation.title,
      user_message.id AS user_message_id,
      assistant_message.id AS assistant_message_id
    FROM chat_conversations AS conversation
    JOIN chat_messages AS user_message
      ON user_message.conversation_id = conversation.id
      AND user_message.role = 'user'
    JOIN LATERAL (
      SELECT *
      FROM chat_messages AS candidate
      WHERE candidate.conversation_id = user_message.conversation_id
        AND candidate.role = 'assistant'
        AND candidate.message_order > user_message.message_order
      ORDER BY candidate.message_order ASC
      LIMIT 1
    ) AS assistant_message ON true
    ${whereSql}
    ORDER BY user_message.message_order ASC
    LIMIT $1
  `,
  params
);

let queued = 0;
const accounts = new Set();
for (const row of rows.rows) {
  accounts.add(row.account_id);
  const result = await enqueueChatMemoryJob({
    accountId: row.account_id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
  });
  if (result.queued) queued += 1;
}

let deepQueued = 0;
for (const rowAccountId of accounts) {
  const result = await enqueueMissingDeepMemoryJobs({ accountId: rowAccountId });
  deepQueued += result.queued || 0;
}

let processed = null;
if (processNow) {
  processed = await processMemoryQueueOnce({ limit });
}

console.log(JSON.stringify({
  ok: true,
  title,
  accountId: accountId || null,
  matchedPairs: rows.rows.length,
  queued,
  deepQueued,
  processed,
}, null, 2));

await closePool();
