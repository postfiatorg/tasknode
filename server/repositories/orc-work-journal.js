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

export async function recordAgentWorkJournal({
  agentOrigin = null,
  taskAction = "",
  status = "recorded",
  outcomeStatus = "",
  blocker = "",
  accountId = "",
  sourceTaskId = "",
  requestId = "",
  conversationId = "",
  hiveContextEntryId = "",
  chatMessageId = "",
  cid = "",
  txHash = "",
  messageCharacterCount = 0,
  metadata = {},
  idempotencyKey = "",
} = {}) {
  if (!agentOrigin?.agent) return { ok: false, skipped: true, reason: "not_agent_action" };
  if (!databaseEnabled()) return { ok: true, skipped: true, reason: "database_disabled" };

  const operatorHandle = safeText(
    agentOrigin.agentHandle || agentOrigin.walletAddress || agentOrigin.accountId || accountId,
    120
  );
  const normalizedTaskAction = safeText(taskAction || "agent_action", 80) || "agent_action";
  const effectiveIdempotencyKey = safeText(idempotencyKey, 240) || `${normalizedTaskAction}:${safeText([
    accountId,
    sourceTaskId,
    requestId,
    conversationId,
    agentOrigin.walletAddress,
    txHash,
    cid,
    messageCharacterCount,
  ].join(":") || sha256(JSON.stringify(metadata)), 180)}`;

  const inserted = await query(
    `
      INSERT INTO orc_work_journal (
        id,
        interaction_id,
        source_task_id,
        followup_request_id,
        task_action,
        event_cid,
        tx_hash,
        operator_handle,
        blocker,
        status,
        outcome_status,
        terminal,
        metadata_json,
        idempotency_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12::jsonb, $13)
      ON CONFLICT (idempotency_key)
      WHERE idempotency_key <> ''
      DO UPDATE SET
        updated_at = now()
      RETURNING id, created_at, updated_at
    `,
    [
      `orcwj_${randomUUID()}`,
      safeText(conversationId, 180),
      safeText(sourceTaskId, 180),
      safeText(requestId, 180),
      normalizedTaskAction,
      safeText(cid, 240),
      safeText(txHash, 180),
      operatorHandle,
      safeText(blocker, 240),
      safeText(status || "recorded", 80) || "recorded",
      safeText(outcomeStatus, 120),
      jsonValue({
        kind: normalizedTaskAction,
        accountId: safeText(accountId, 180),
        sourceTaskId: safeText(sourceTaskId, 180),
        requestId: safeText(requestId, 180),
        conversationId: safeText(conversationId, 180),
        hiveContextEntryId: safeText(hiveContextEntryId, 180),
        chatMessageId: safeText(chatMessageId, 180),
        cid: safeText(cid, 240),
        txHash: safeText(txHash, 180),
        messageCharacterCount: Math.max(0, Number(messageCharacterCount || 0)),
        agentOrigin,
        ...metadata,
      }),
      effectiveIdempotencyKey,
    ]
  );

  return {
    ok: true,
    id: inserted.rows[0]?.id || "",
    idempotencyKey: effectiveIdempotencyKey,
  };
}

export async function recordAgentHiveChatWorkJournal(options = {}) {
  return recordAgentWorkJournal({
    ...options,
    taskAction: "hive_chat",
    outcomeStatus: "sent",
    idempotencyKey: `agent_hive_chat:${safeText(
      options.hiveContextEntryId ||
        options.chatMessageId ||
        sha256([
          options.accountId,
          options.conversationId,
          options.agentOrigin?.walletAddress,
          options.messageCharacterCount,
        ].join(":")),
      180
    )}`,
    metadata: {
      ...(options.metadata || {}),
      kind: "agent_hive_chat",
    },
  });
}
