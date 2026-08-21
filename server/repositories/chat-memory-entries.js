import { databaseEnabled, query, transaction } from "../db/pool.js";

const maxContextDeepLimit = 10;
const maxContextTurnLimit = 72;

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function safeAccountId(accountId = "") {
  return safeText(accountId, 160);
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

export function publicChatMemoryEntry(row) {
  return {
    id: row.id,
    accountId: row.account_id || "",
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title || "New chat",
    userRequestSummary: row.user_request_summary || "",
    systemResponseSummary: row.system_response_summary || "",
    memoryText: row.memory_text || "",
    sourceUserExcerpt: row.source_user_excerpt || "",
    sourceAssistantExcerpt: row.source_assistant_excerpt || "",
    kind: row.kind || "turn_memory",
    deepMemoryBlockIndex: row.deep_memory_block_index || null,
    provider: row.provider || "",
    model: row.model || "",
    promptVersion: row.prompt_version || "",
    createdAt: toIso(row.created_at),
  };
}

export async function getChatMemoryEntryCounts({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!databaseEnabled() || !normalizedAccountId) {
    return {
      deepMemoryTotal: 0,
      turnMemoryTotal: 0,
      rewardedTaskMemoryTotal: 0,
      total: 0,
    };
  }

  const result = await query(
    `
      SELECT
        COUNT(*) FILTER (WHERE kind = 'deep_memory')::integer AS deep_memory_total,
        COUNT(*) FILTER (WHERE kind IN ('turn_memory', 'rewarded_task_memory'))::integer AS turn_memory_total,
        COUNT(*) FILTER (WHERE kind = 'rewarded_task_memory')::integer AS rewarded_task_memory_total,
        COUNT(*)::integer AS total
      FROM chat_memory_entries
      WHERE account_id = $1
    `,
    [normalizedAccountId]
  );
  const row = result.rows[0] || {};
  return {
    deepMemoryTotal: Number(row.deep_memory_total || 0),
    turnMemoryTotal: Number(row.turn_memory_total || 0),
    rewardedTaskMemoryTotal: Number(row.rewarded_task_memory_total || 0),
    total: Number(row.total || 0),
  };
}

export async function deleteChatMemoryEntry({ accountId = "", entryId = "" } = {}) {
  if (!databaseEnabled()) return { ok: false, status: 503, error: "database_not_configured" };
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedEntryId = safeText(entryId, 180);
  if (!normalizedAccountId || !normalizedEntryId) {
    return { ok: false, status: 400, error: "memory_delete_missing_entry", message: "Choose a memory to delete." };
  }

  const result = await query(
    `
      DELETE FROM chat_memory_entries
      WHERE account_id = $1
        AND id = $2
      RETURNING id, kind
    `,
    [normalizedAccountId, normalizedEntryId]
  );

  if (!result.rows[0]) {
    return { ok: false, status: 404, error: "memory_not_found", message: "Memory was already deleted or does not exist." };
  }

  return {
    ok: true,
    action: "delete_entry",
    deleted: 1,
    entry: {
      id: result.rows[0].id,
      kind: result.rows[0].kind || "turn_memory",
    },
    message: "Memory deleted.",
  };
}

export async function clearChatMemoryEntriesByKind({ accountId = "", kind = "" } = {}) {
  if (!databaseEnabled()) return { ok: false, status: 503, error: "database_not_configured" };
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedKind = safeText(kind, 40);
  if (!["turn_memory", "deep_memory"].includes(normalizedKind)) {
    return { ok: false, status: 400, error: "memory_clear_invalid_kind", message: "Choose a valid memory group to clear." };
  }
  if (!normalizedAccountId) {
    return { ok: false, status: 400, error: "memory_clear_missing_account", message: "Sign in before clearing memory." };
  }

  const result = await transaction(async (client) => {
    const deletedEntries = await client.query(
      `
        DELETE FROM chat_memory_entries
        WHERE account_id = $1
          AND (
            kind = $2
            OR ($2 = 'turn_memory' AND kind = 'rewarded_task_memory')
          )
      `,
      [normalizedAccountId, normalizedKind]
    );
    let deletedJobs = { rowCount: 0 };
    if (normalizedKind === "deep_memory") {
      deletedJobs = await client.query(
        `
          DELETE FROM chat_deep_memory_jobs
          WHERE account_id = $1
        `,
        [normalizedAccountId]
      );
    }
    return { entries: deletedEntries.rowCount, jobs: deletedJobs.rowCount };
  });

  return {
    ok: true,
    action: normalizedKind === "deep_memory" ? "clear_deep_memory" : "clear_turn_memory",
    deleted: result.entries,
    deletedJobs: result.jobs,
    message: normalizedKind === "deep_memory" ? "Deep Memory cleared." : "Recent Memory cleared.",
  };
}

export async function getChatMemoryContext({
  accountId = "",
  deepLimit = 3,
  turnLimit = 36,
} = {}) {
  if (!databaseEnabled()) {
    return {
      deepMemories: [],
      memories: [],
      durable: false,
      storePath: "runtime",
    };
  }

  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) {
    return {
      deepMemories: [],
      memories: [],
      durable: true,
      storePath: "postgres",
    };
  }

  const normalizedDeepLimit = Math.min(Math.max(Number(deepLimit) || 3, 0), maxContextDeepLimit);
  const normalizedTurnLimit = Math.min(Math.max(Number(turnLimit) || 36, 0), maxContextTurnLimit);
  const [deepResult, turnResult] = await Promise.all([
    normalizedDeepLimit > 0
      ? query(
          `
            SELECT *
            FROM chat_memory_entries
            WHERE account_id = $1
              AND kind = 'deep_memory'
            ORDER BY created_at DESC, id DESC
            LIMIT $2
          `,
          [normalizedAccountId, normalizedDeepLimit]
        )
      : { rows: [] },
    normalizedTurnLimit > 0
      ? query(
          `
            SELECT *
            FROM chat_memory_entries
            WHERE account_id = $1
              AND kind IN ('turn_memory', 'rewarded_task_memory')
            ORDER BY created_at DESC, id DESC
            LIMIT $2
          `,
          [normalizedAccountId, normalizedTurnLimit]
        )
      : { rows: [] },
  ]);

  return {
    deepMemories: deepResult.rows.map(publicChatMemoryEntry),
    memories: turnResult.rows.map(publicChatMemoryEntry),
    durable: true,
    storePath: "postgres",
  };
}
