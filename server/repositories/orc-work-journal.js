import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export async function recordAgentHiveChatWorkJournal({
  agentOrigin = null,
  accountId = "",
  conversationId = "",
  hiveContextEntryId = "",
  chatMessageId = "",
  messageCharacterCount = 0,
} = {}) {
  if (!agentOrigin?.agent) return { ok: false, skipped: true, reason: "not_agent_action" };
  if (!databaseEnabled()) return { ok: true, skipped: true, reason: "database_disabled" };

  const operatorHandle = safeText(
    agentOrigin.agentHandle || agentOrigin.walletAddress || agentOrigin.accountId || accountId,
    120
  );
  const idempotencyKey = `agent_hive_chat:${safeText(hiveContextEntryId || chatMessageId || sha256([
    accountId,
    conversationId,
    agentOrigin.walletAddress,
    messageCharacterCount,
  ].join(":")), 180)}`;

  const inserted = await query(
    `
      INSERT INTO orc_work_journal (
        id,
        interaction_id,
        task_action,
        operator_handle,
        status,
        outcome_status,
        terminal,
        metadata_json,
        idempotency_key
      )
      VALUES ($1, $2, 'hive_chat', $3, 'recorded', 'sent', true, $4::jsonb, $5)
      ON CONFLICT (idempotency_key)
      WHERE idempotency_key <> ''
      DO UPDATE SET
        updated_at = now()
      RETURNING id, created_at, updated_at
    `,
    [
      `orcwj_${randomUUID()}`,
      safeText(conversationId, 180),
      operatorHandle,
      jsonValue({
        kind: "agent_hive_chat",
        accountId: safeText(accountId, 180),
        conversationId: safeText(conversationId, 180),
        hiveContextEntryId: safeText(hiveContextEntryId, 180),
        chatMessageId: safeText(chatMessageId, 180),
        messageCharacterCount: Math.max(0, Number(messageCharacterCount || 0)),
        agentOrigin,
      }),
      idempotencyKey,
    ]
  );

  return {
    ok: true,
    id: inserted.rows[0]?.id || "",
    idempotencyKey,
  };
}
