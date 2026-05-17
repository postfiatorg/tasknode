import { randomUUID } from "node:crypto";
import { databaseEnabled, databaseStatus, query, transaction } from "../db/pool.js";

const maxListLimit = 200;
const maxClaimLimit = 10;
const failedAttemptLimit = Number(process.env.TASKNODE_MEMORY_MAX_ATTEMPTS || 5);
export const deepMemoryBlockSize = 36;
const maxContextDeepLimit = 10;
const maxContextTurnLimit = 72;

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function safeAccountId(accountId = "") {
  return safeText(accountId, 160);
}

function safeConversationId(conversationId = "") {
  return safeText(conversationId || "dev", 180) || "dev";
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function jsonValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function publicEntry(row) {
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

export function chatMemoryStatus() {
  return databaseStatus();
}

export async function enqueueChatMemoryJob({
  accountId = "",
  conversationId = "",
  userMessageId = "",
  assistantMessageId = "",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  if (!accountId || !conversationId || !userMessageId || !assistantMessageId) {
    return { ok: false, skipped: true, reason: "missing_message_identity" };
  }

  const result = await query(
    `
      INSERT INTO chat_memory_jobs (
        id,
        account_id,
        conversation_id,
        user_message_id,
        assistant_message_id
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (assistant_message_id) DO NOTHING
      RETURNING id
    `,
    [
      `memjob_${randomUUID()}`,
      safeAccountId(accountId),
      safeConversationId(conversationId),
      safeText(userMessageId, 180),
      safeText(assistantMessageId, 180),
    ]
  );

  return {
    ok: true,
    queued: Boolean(result.rows[0]),
    jobId: result.rows[0]?.id || null,
  };
}

export async function claimChatMemoryJobs({ limit = 3 } = {}) {
  if (!useDatabase()) return [];
  const normalizedLimit = Math.min(Math.max(Number(limit) || 3, 1), maxClaimLimit);

  return transaction(async (client) => {
    await client.query(
      `
        UPDATE chat_memory_jobs
        SET status = 'pending',
            next_attempt_at = now(),
            locked_at = NULL,
            updated_at = now()
        WHERE status = 'processing'
          AND locked_at < now() - interval '5 minutes'
      `
    );

    const result = await client.query(
      `
        WITH picked AS (
          SELECT id
          FROM chat_memory_jobs
          WHERE status = 'pending'
            AND next_attempt_at <= now()
          ORDER BY created_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE chat_memory_jobs AS job
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            locked_at = now(),
            updated_at = now()
        FROM picked
        WHERE job.id = picked.id
        RETURNING job.*
      `,
      [normalizedLimit]
    );
    return result.rows;
  });
}

export async function chatMemoryJobSource(job) {
  if (!useDatabase() || !job?.id) return null;
  const result = await query(
    `
      SELECT
        job.*,
        conversation.title AS conversation_title,
        user_message.body AS user_body,
        assistant_message.body AS assistant_body
      FROM chat_memory_jobs AS job
      JOIN chat_messages AS user_message
        ON user_message.id = job.user_message_id
      JOIN chat_messages AS assistant_message
        ON assistant_message.id = job.assistant_message_id
      LEFT JOIN chat_conversations AS conversation
        ON conversation.id = job.conversation_id
      WHERE job.id = $1
      LIMIT 1
    `,
    [job.id]
  );
  return result.rows[0] || null;
}

export async function completeChatMemoryJob({ job, summary }) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const id = `mem_${randomUUID()}`;
  const conversationTitle = safeText(summary.conversationTitle || job.conversation_title || "New chat", 120);

  return transaction(async (client) => {
    const inserted = await client.query(
      `
        INSERT INTO chat_memory_entries (
          id,
          account_id,
          conversation_id,
          conversation_title,
          user_message_id,
          assistant_message_id,
          user_request_summary,
          system_response_summary,
          memory_text,
          source_user_excerpt,
          source_assistant_excerpt,
          kind,
          deep_memory_block_index,
          provider,
          model,
          prompt_version,
          usage_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16, $17
        )
        ON CONFLICT (assistant_message_id) DO UPDATE SET
          conversation_title = EXCLUDED.conversation_title,
          user_request_summary = EXCLUDED.user_request_summary,
          system_response_summary = EXCLUDED.system_response_summary,
          memory_text = EXCLUDED.memory_text,
          source_user_excerpt = EXCLUDED.source_user_excerpt,
          source_assistant_excerpt = EXCLUDED.source_assistant_excerpt,
          kind = EXCLUDED.kind,
          deep_memory_block_index = EXCLUDED.deep_memory_block_index,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          prompt_version = EXCLUDED.prompt_version,
          usage_json = EXCLUDED.usage_json
        RETURNING *
      `,
      [
        id,
        safeAccountId(job.account_id),
        safeConversationId(job.conversation_id),
        conversationTitle,
        safeText(job.user_message_id, 180),
        safeText(job.assistant_message_id, 180),
        safeText(summary.userRequestSummary, 1200),
        safeText(summary.systemResponseSummary, 1200),
        safeText(summary.memoryText, 1800),
        safeText(summary.sourceUserExcerpt, 500),
        safeText(summary.sourceAssistantExcerpt, 500),
        "turn_memory",
        null,
        safeText(summary.provider, 80),
        safeText(summary.model, 160),
        safeText(summary.promptVersion, 80),
        jsonValue(summary.usage),
      ]
    );

    await client.query(
      `
        UPDATE chat_memory_jobs
        SET status = 'completed',
            locked_at = NULL,
            last_error = '',
            updated_at = now()
        WHERE id = $1
      `,
      [job.id]
    );

    const deepMemoryJob = await maybeEnqueueDeepMemoryJobForAccount(client, {
      accountId: job.account_id,
    });

    return { ok: true, entry: publicEntry(inserted.rows[0]), deepMemoryJob };
  });
}

async function maybeEnqueueDeepMemoryJobForAccount(client, { accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return { queued: false, reason: "missing_account" };

  const countResult = await client.query(
    `
      SELECT count(*)::integer AS count
      FROM chat_memory_entries
      WHERE account_id = $1
        AND kind = 'turn_memory'
    `,
    [normalizedAccountId]
  );
  const count = Number(countResult.rows[0]?.count || 0);
  if (count < deepMemoryBlockSize || count % deepMemoryBlockSize !== 0) {
    return { queued: false, count };
  }

  const blockIndex = count / deepMemoryBlockSize;
  const inserted = await client.query(
    `
      INSERT INTO chat_deep_memory_jobs (
        id,
        account_id,
        block_index
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (account_id, block_index) DO NOTHING
      RETURNING *
    `,
    [`deepmemjob_${randomUUID()}`, normalizedAccountId, blockIndex]
  );

  return {
    queued: Boolean(inserted.rows[0]),
    blockIndex,
    jobId: inserted.rows[0]?.id || null,
  };
}

export async function enqueueMissingDeepMemoryJobs({ accountId = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return { ok: false, skipped: true, reason: "missing_account" };

  const countResult = await query(
    `
      SELECT count(*)::integer AS count
      FROM chat_memory_entries
      WHERE account_id = $1
        AND kind = 'turn_memory'
    `,
    [normalizedAccountId]
  );
  const count = Number(countResult.rows[0]?.count || 0);
  const blockCount = Math.floor(count / deepMemoryBlockSize);
  let queued = 0;

  for (let blockIndex = 1; blockIndex <= blockCount; blockIndex += 1) {
    const result = await query(
      `
        INSERT INTO chat_deep_memory_jobs (
          id,
          account_id,
          block_index
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (account_id, block_index) DO NOTHING
        RETURNING id
      `,
      [`deepmemjob_${randomUUID()}`, normalizedAccountId, blockIndex]
    );
    if (result.rows[0]) queued += 1;
  }

  return { ok: true, count, blockCount, queued };
}

export async function claimDeepMemoryJobs({ limit = 1 } = {}) {
  if (!useDatabase()) return [];
  const normalizedLimit = Math.min(Math.max(Number(limit) || 1, 1), maxClaimLimit);

  return transaction(async (client) => {
    await client.query(
      `
        UPDATE chat_deep_memory_jobs
        SET status = 'pending',
            next_attempt_at = now(),
            locked_at = NULL,
            updated_at = now()
        WHERE status = 'processing'
          AND locked_at < now() - interval '5 minutes'
      `
    );

    const result = await client.query(
      `
        WITH picked AS (
          SELECT id
          FROM chat_deep_memory_jobs
          WHERE status = 'pending'
            AND next_attempt_at <= now()
          ORDER BY created_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE chat_deep_memory_jobs AS job
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            locked_at = now(),
            updated_at = now()
        FROM picked
        WHERE job.id = picked.id
        RETURNING job.*
      `,
      [normalizedLimit]
    );
    return result.rows;
  });
}

export async function deepMemoryJobSource(job) {
  if (!useDatabase() || !job?.id) return null;
  const startOrdinal = (Number(job.block_index || 1) - 1) * deepMemoryBlockSize;
  const result = await query(
    `
      WITH ordered AS (
        SELECT
          *,
          row_number() OVER (ORDER BY created_at ASC, id ASC) AS ordinal
        FROM chat_memory_entries
        WHERE account_id = $1
          AND kind = 'turn_memory'
      )
      SELECT *
      FROM ordered
      WHERE ordinal > $2
        AND ordinal <= $3
      ORDER BY ordinal ASC
    `,
    [safeAccountId(job.account_id), startOrdinal, startOrdinal + deepMemoryBlockSize]
  );

  return {
    ...job,
    entries: result.rows.map(publicEntry),
  };
}

export async function completeDeepMemoryJob({ job, summary }) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const blockIndex = Math.max(1, Number(job.block_index || 1));
  const syntheticId = safeText(job.id, 120);

  return transaction(async (client) => {
    const inserted = await client.query(
      `
        INSERT INTO chat_memory_entries (
          id,
          account_id,
          conversation_id,
          conversation_title,
          user_message_id,
          assistant_message_id,
          user_request_summary,
          system_response_summary,
          memory_text,
          source_user_excerpt,
          source_assistant_excerpt,
          kind,
          deep_memory_block_index,
          provider,
          model,
          prompt_version,
          usage_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16, $17
        )
        ON CONFLICT (assistant_message_id) DO UPDATE SET
          conversation_title = EXCLUDED.conversation_title,
          user_request_summary = EXCLUDED.user_request_summary,
          system_response_summary = EXCLUDED.system_response_summary,
          memory_text = EXCLUDED.memory_text,
          source_user_excerpt = EXCLUDED.source_user_excerpt,
          source_assistant_excerpt = EXCLUDED.source_assistant_excerpt,
          kind = EXCLUDED.kind,
          deep_memory_block_index = EXCLUDED.deep_memory_block_index,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          prompt_version = EXCLUDED.prompt_version,
          usage_json = EXCLUDED.usage_json
        RETURNING *
      `,
      [
        `deepmem_${randomUUID()}`,
        safeAccountId(job.account_id),
        `deep_memory_block_${blockIndex}`,
        `Deep memory #${blockIndex}`,
        `${syntheticId}_source`,
        `${syntheticId}_summary`,
        safeText(summary.userRequestSummary, 1800),
        safeText(summary.systemResponseSummary, 1800),
        safeText(summary.memoryText, 1800),
        safeText(summary.sourceUserExcerpt, 500),
        safeText(summary.sourceAssistantExcerpt, 500),
        "deep_memory",
        blockIndex,
        safeText(summary.provider, 80),
        safeText(summary.model, 160),
        safeText(summary.promptVersion, 80),
        jsonValue(summary.usage),
      ]
    );

    await client.query(
      `
        UPDATE chat_deep_memory_jobs
        SET status = 'completed',
            locked_at = NULL,
            last_error = '',
            updated_at = now()
        WHERE id = $1
      `,
      [job.id]
    );

    return { ok: true, entry: publicEntry(inserted.rows[0]) };
  });
}

export async function failChatMemoryJob(job, error) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const attemptCount = Number(job.attempt_count || 0);
  const finalFailure = attemptCount >= failedAttemptLimit;
  const backoffSeconds = Math.min(900, Math.max(30, 30 * attemptCount * attemptCount));

  await query(
    `
      UPDATE chat_memory_jobs
      SET status = $2,
          next_attempt_at = CASE
            WHEN $2 = 'failed' THEN next_attempt_at
            ELSE now() + ($3::text || ' seconds')::interval
          END,
          locked_at = NULL,
          last_error = $4,
          updated_at = now()
      WHERE id = $1
    `,
    [
      job.id,
      finalFailure ? "failed" : "pending",
      String(backoffSeconds),
      safeText(error?.message || error || "memory_job_failed", 1000),
    ]
  );
  return { ok: true, retry: !finalFailure };
}

export async function failDeepMemoryJob(job, error) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const attemptCount = Number(job.attempt_count || 0);
  const finalFailure = attemptCount >= failedAttemptLimit;
  const backoffSeconds = Math.min(900, Math.max(30, 30 * attemptCount * attemptCount));

  await query(
    `
      UPDATE chat_deep_memory_jobs
      SET status = $2,
          next_attempt_at = CASE
            WHEN $2 = 'failed' THEN next_attempt_at
            ELSE now() + ($3::text || ' seconds')::interval
          END,
          locked_at = NULL,
          last_error = $4,
          updated_at = now()
      WHERE id = $1
    `,
    [
      job.id,
      finalFailure ? "failed" : "pending",
      String(backoffSeconds),
      safeText(error?.message || error || "deep_memory_job_failed", 1000),
    ]
  );
  return { ok: true, retry: !finalFailure };
}

export async function listChatMemory({ accountId = "", q = "", limit = 100 } = {}) {
  if (!useDatabase()) return { entries: [], durable: false, storePath: "runtime" };
  const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), maxListLimit);
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedQuery = safeText(q, 120);
  const params = [normalizedAccountId, normalizedLimit];
  let searchSql = "";

  if (normalizedQuery) {
    params.push(`%${normalizedQuery}%`);
    searchSql = `
      AND (
        conversation_title ILIKE $3
        OR user_request_summary ILIKE $3
        OR system_response_summary ILIKE $3
        OR memory_text ILIKE $3
      )
    `;
  }

  const result = await query(
    `
      SELECT *
      FROM chat_memory_entries
      WHERE account_id = $1
      ${searchSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    params
  );

  return {
    entries: result.rows.map(publicEntry),
    durable: true,
    storePath: "postgres",
  };
}

export async function getChatMemoryContext({
  accountId = "",
  deepLimit = 3,
  turnLimit = 36,
} = {}) {
  if (!useDatabase()) {
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

  const normalizedDeepLimit = Math.min(
    Math.max(Number(deepLimit) || 3, 0),
    maxContextDeepLimit
  );
  const normalizedTurnLimit = Math.min(
    Math.max(Number(turnLimit) || 36, 0),
    maxContextTurnLimit
  );
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
              AND kind = 'turn_memory'
            ORDER BY created_at DESC, id DESC
            LIMIT $2
          `,
          [normalizedAccountId, normalizedTurnLimit]
        )
      : { rows: [] },
  ]);

  return {
    deepMemories: deepResult.rows.map(publicEntry),
    memories: turnResult.rows.map(publicEntry),
    durable: true,
    storePath: "postgres",
  };
}
