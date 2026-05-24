import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { appendAssistantMessage } from "../server/repositories/chat-assistant-messages.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function hasArg(name) {
  return process.argv.includes(name);
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

async function resolveConversation({ accountId, createdAt, metadata = {} }) {
  const metadataConversationId = safeText(metadata.conversation_id || metadata.conversationId, 180);
  if (metadataConversationId) return { conversationId: metadataConversationId, source: "metadata" };

  const result = await query(
    `
      SELECT source_conversation_id
      FROM hive_context_entries
      WHERE account_id = $1
        AND source_conversation_id <> ''
        AND created_at <= $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [accountId, createdAt]
  );
  const conversationId = safeText(result.rows[0]?.source_conversation_id, 180);
  return conversationId
    ? { conversationId, source: "latest_hive_context_before_message" }
    : { conversationId: "", source: "not_found" };
}

async function repairUndeliveredMessages({ apply = false, limit = 25 } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      SELECT m.id, m.run_id, m.account_id, m.message_text, m.metadata_json, m.created_at,
             r.trigger, r.manager_id
      FROM board_manager_user_messages m
      LEFT JOIN board_manager_runs r ON r.id = m.run_id
      WHERE m.status <> 'archived'
        AND COALESCE(m.metadata_json->>'chat_message_id', '') = ''
        AND lower(COALESCE(r.trigger, '')) NOT LIKE '%smoke%'
        AND lower(COALESCE(r.manager_id, '')) NOT LIKE '%smoke%'
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 25, 1), 200)]
  );

  const repaired = [];
  const skipped = [];
  for (const row of result.rows) {
    const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
    const target = await resolveConversation({
      accountId: row.account_id,
      createdAt: row.created_at,
      metadata,
    });
    if (!target.conversationId) {
      skipped.push({ id: row.id, runId: row.run_id, reason: "source_conversation_not_found" });
      continue;
    }

    const chatMessageId = `msg_${row.id}_assistant`.slice(0, 180);
    if (apply) {
      const existing = await query("SELECT id FROM chat_messages WHERE id = $1", [chatMessageId]);
      if (!existing.rows[0]) {
        await appendAssistantMessage({
          accountId: row.account_id,
          conversationId: target.conversationId,
          mode: "Hive",
          provider: "tasknode",
          model: "board_manager",
          responseId: row.run_id,
          assistantMessage: row.message_text,
          assistantMessageId: chatMessageId,
          assistantMetadata: {
            kind: "hive_manager_response",
            boardManagerRunId: row.run_id,
            boardManagerMessageId: row.id,
            repairedDelivery: true,
          },
        });
      }
      await query(
        `
          UPDATE board_manager_user_messages
          SET metadata_json = metadata_json || $2::jsonb
          WHERE id = $1
        `,
        [
          row.id,
          JSON.stringify({
            conversation_id: target.conversationId,
            chat_message_id: chatMessageId,
            delivery_repaired_at: new Date().toISOString(),
            delivery_repair_source: target.source,
          }),
        ]
      );
    }
    repaired.push({
      id: row.id,
      runId: row.run_id,
      accountId: row.account_id,
      conversationId: target.conversationId,
      chatMessageId,
      applied: apply,
    });
  }

  return { ok: true, apply, candidateCount: result.rows.length, repaired, skipped };
}

try {
  const apply = hasArg("--apply");
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 25;
  const output = await repairUndeliveredMessages({ apply, limit });
  console.log(JSON.stringify(output, null, 2));
} finally {
  await closePool();
}
