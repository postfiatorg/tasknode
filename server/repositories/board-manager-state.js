import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function publicFollowup(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id || "",
    accountId: row.account_id || "",
    projectId: row.project_id || "",
    hiveContextEntryId: row.hive_context_entry_id || "",
    responseHiveContextEntryId: row.response_hive_context_entry_id || "",
    conversationId: row.conversation_id || "",
    boardMessageId: row.board_message_id || "",
    chatMessageId: row.chat_message_id || "",
    status: row.status || "",
    blockerType: row.blocker_type || "",
    blockerSummary: row.blocker_summary || "",
    expectedResponse: row.expected_response || "",
    sourcePacketDigest: row.source_packet_digest || "",
    metadata: safeObject(row.metadata_json),
    lastSentAt: toIso(row.last_sent_at),
    answeredAt: toIso(row.answered_at),
    resolvedAt: toIso(row.resolved_at),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listOpenBoardManagerFollowups({ limit = 20 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT *
      FROM board_manager_followups
      WHERE status = 'open'
        AND expires_at > now()
      ORDER BY last_sent_at DESC, id DESC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)]
  );
  return result.rows.map(publicFollowup);
}

export async function findOpenBoardManagerFollowup({
  accountId = "",
  projectId = "",
  hiveContextEntryId = "",
} = {}) {
  if (!useDatabase()) return null;
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedProjectId = safeText(projectId, 180);
  const normalizedHiveContextEntryId = safeText(hiveContextEntryId, 180);
  if (!normalizedAccountId && !normalizedProjectId && !normalizedHiveContextEntryId) return null;
  const result = await query(
    `
      SELECT *
      FROM board_manager_followups
      WHERE status = 'open'
        AND expires_at > now()
        AND ($1::text = '' OR account_id = $1)
        AND (
          $2::text = ''
          OR project_id = $2
          OR project_id = ''
        )
        AND (
          $3::text = ''
          OR hive_context_entry_id = $3
        )
      ORDER BY
        CASE WHEN $2::text <> '' AND project_id = $2 THEN 0 ELSE 1 END,
        last_sent_at DESC,
        id DESC
      LIMIT 1
    `,
    [normalizedAccountId, normalizedProjectId, normalizedHiveContextEntryId]
  );
  return publicFollowup(result.rows[0]);
}

export async function createBoardManagerFollowup({
  runId = "",
  accountId = "",
  projectId = "",
  hiveContextEntryId = "",
  conversationId = "",
  boardMessageId = "",
  chatMessageId = "",
  blockerType = "",
  blockerSummary = "",
  expectedResponse = "",
  sourcePacketDigest = "",
  metadata = {},
  expiresInDays = 7,
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return { ok: false, skipped: true, reason: "account_required" };
  const expiresDays = Math.min(Math.max(Number(expiresInDays) || 7, 1), 30);
  const result = await query(
    `
      INSERT INTO board_manager_followups (
        id,
        run_id,
        account_id,
        project_id,
        hive_context_entry_id,
        conversation_id,
        board_message_id,
        chat_message_id,
        status,
        blocker_type,
        blocker_summary,
        expected_response,
        source_packet_digest,
        metadata_json,
        last_sent_at,
        expires_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'open',
        $9, $10, $11, $12, $13::jsonb, now(), now() + ($14::text || ' days')::interval
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
    [
      `bmfollow_${randomUUID()}`,
      safeText(runId, 180),
      normalizedAccountId,
      safeText(projectId, 180),
      safeText(hiveContextEntryId, 180),
      safeText(conversationId, 180),
      safeText(boardMessageId, 180),
      safeText(chatMessageId, 180),
      safeText(blockerType || "user_followup", 120),
      safeText(blockerSummary, 1200),
      safeText(expectedResponse, 1200),
      safeText(sourcePacketDigest, 120),
      jsonValue(metadata),
      String(expiresDays),
    ]
  );
  if (!result.rows[0]) {
    const existing = await findOpenBoardManagerFollowup({
      accountId: normalizedAccountId,
      projectId,
      hiveContextEntryId,
    });
    return { ok: true, followup: existing, idempotent: true };
  }
  return { ok: true, followup: publicFollowup(result.rows[0]) };
}

export async function markBoardManagerFollowupsAnsweredForHiveEntry({
  accountId = "",
  hiveContextEntryId = "",
  conversationId = "",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return { ok: false, updated: 0, reason: "account_required" };
  const result = await query(
    `
      UPDATE board_manager_followups
      SET status = 'answered',
          response_hive_context_entry_id = $2,
          metadata_json = metadata_json || $4::jsonb,
          answered_at = now(),
          updated_at = now()
      WHERE account_id = $1
        AND status = 'open'
        AND expires_at > now()
        AND ($3::text = '' OR conversation_id = '' OR conversation_id = $3)
      RETURNING *
    `,
    [
      normalizedAccountId,
      safeText(hiveContextEntryId, 180),
      safeText(conversationId, 180),
      jsonValue({ answered_by_hive_context_entry_id: safeText(hiveContextEntryId, 180) }),
    ]
  );
  return {
    ok: true,
    updated: result.rowCount || 0,
    followups: result.rows.map(publicFollowup),
  };
}

export async function expireOpenBoardManagerFollowups() {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE board_manager_followups
      SET status = 'expired',
          updated_at = now()
      WHERE status = 'open'
        AND expires_at <= now()
      RETURNING id
    `
  );
  return { ok: true, expired: result.rowCount || 0 };
}
