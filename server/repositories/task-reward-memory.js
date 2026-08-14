import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { enqueueMissingDeepMemoryJobs } from "./chat-memory.js";
import {
  canonicalRewardedTaskProjectionSql,
} from "./task-projection-integrity.js";
import { recordUserObservabilityEvent } from "./user-observability.js";

const failedAttemptLimit = Math.max(1, Number(process.env.TASKNODE_MEMORY_MAX_ATTEMPTS || 5));
const maxClaimLimit = 10;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function toIso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function boundedValue(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return safeText(value, 5000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => boundedValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 48)
        .map(([key, item]) => [safeText(key, 120), boundedValue(item, depth + 1)])
    );
  }
  return safeText(value, 1000);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function eventPacket(event = {}) {
  const payload = safeObject(event.payload_json || event.payload || event.offchainPayload);
  return {
    type: safeText(event.event_type || event.schema || event.eventType, 120),
    occurred_at: toIso(event.occurred_at || event.observed_at || event.occurredAt || event.observedAt),
    payload: boundedValue(payload),
  };
}

export function buildRewardedTaskMemoryPacket({ projection = {}, events = [] } = {}) {
  const metadata = safeObject(projection.metadata_json || projection.metadata);
  const generatedTask = safeObject(metadata.generatedTask || metadata.generated_task);
  const sourceJson = {
    schema: "pf.memory.rewarded_task_source.v1",
    account_id: safeText(projection.account_id || projection.accountId, 180),
    task: {
      task_id: safeText(projection.task_id || projection.taskId, 180),
      title: safeText(projection.title || generatedTask.title, 300),
      description: safeText(projection.description || generatedTask.description, 8000),
      task_kind: safeText(projection.task_kind || projection.taskKind || generatedTask.task_kind, 120),
      submission_type: safeText(projection.submission_type || projection.submissionType, 120),
      submission_requirement: safeText(
        projection.submission_requirement_text || projection.submissionRequirementText,
        3000
      ),
      verification_policy: boundedValue(
        projection.verification_policy_json || projection.verificationPolicy || {}
      ),
      reward_offer_pft: numeric(projection.reward_offer_pft ?? projection.rewardOffer),
      reward_actual_pft: numeric(projection.reward_actual_pft ?? projection.rewardActual),
      rewarded_at: toIso(
        projection.last_event_at || projection.updated_at || projection.lastEventAt || projection.updatedAt
      ),
    },
    events: safeArray(events).slice(-16).map(eventPacket),
  };
  return {
    sourceJson,
    sourceText: JSON.stringify(sourceJson),
    sourcePacketDigest: digest(sourceJson),
  };
}

function positiveRewardProjection(projection = {}) {
  const accountId = safeText(projection.account_id || projection.accountId, 180);
  const taskId = safeText(projection.task_id || projection.taskId, 180);
  const rewardActual = numeric(projection.reward_actual_pft ?? projection.rewardActual);
  const status = safeText(projection.status, 80).toLowerCase();
  const eventCount = Number(projection.event_count ?? projection.eventCount ?? 0);
  const lastEventTxHash = safeText(
    projection.last_event_tx_hash || projection.lastEventTxHash,
    180
  );
  const lastEventCid = safeText(projection.last_event_cid || projection.lastEventCid, 240);
  return Boolean(
    accountId &&
    taskId &&
    rewardActual > 0 &&
    ["rewarded", "paid", "completed"].includes(status) &&
    eventCount > 0 &&
    lastEventTxHash &&
    lastEventCid
  );
}

export async function enqueueRewardedTaskMemory({ projection = {}, events = [] } = {}) {
  if (!databaseEnabled()) return { queued: false, reason: "database_not_configured" };
  if (!positiveRewardProjection(projection)) {
    return { queued: false, reason: "not_positive_reward_projection" };
  }
  const packet = buildRewardedTaskMemoryPacket({ projection, events });
  const taskId = packet.sourceJson.task.task_id;
  const accountId = packet.sourceJson.account_id;
  const result = await query(
    `
      INSERT INTO task_reward_memory_jobs (
        id, task_id, account_id, source_packet_digest, source_packet_json, source_packet_text
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (task_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        source_packet_digest = EXCLUDED.source_packet_digest,
        source_packet_json = EXCLUDED.source_packet_json,
        source_packet_text = EXCLUDED.source_packet_text,
        status = CASE
          WHEN task_reward_memory_jobs.status = 'completed' THEN task_reward_memory_jobs.status
          ELSE 'pending'
        END,
        next_attempt_at = CASE
          WHEN task_reward_memory_jobs.status = 'completed' THEN task_reward_memory_jobs.next_attempt_at
          ELSE now()
        END,
        locked_at = CASE
          WHEN task_reward_memory_jobs.status = 'completed' THEN task_reward_memory_jobs.locked_at
          ELSE NULL
        END,
        last_error = CASE
          WHEN task_reward_memory_jobs.status = 'completed' THEN task_reward_memory_jobs.last_error
          ELSE ''
        END,
        updated_at = now()
      RETURNING id, status, memory_entry_id
    `,
    [
      `taskrewardmemjob_${randomUUID()}`,
      taskId,
      accountId,
      packet.sourcePacketDigest,
      JSON.stringify(packet.sourceJson),
      packet.sourceText,
    ]
  );
  const row = result.rows[0] || {};
  const queued = row.status !== "completed";
  await recordUserObservabilityEvent({
    eventType: "user.memory.rewarded_task_queued",
    accountId,
    taskId,
    sourceSurface: "memory",
    sourceRoute: "server/repositories/task-reward-memory.js::enqueueRewardedTaskMemory",
    resultStatus: queued ? "queued" : "already_completed",
    metadata: { jobId: row.id || "", sourcePacketDigest: packet.sourcePacketDigest },
  }).catch(() => {});
  return {
    queued,
    reason: queued ? "rewarded_task_memory_queued" : "rewarded_task_memory_completed",
    jobId: row.id || null,
    memoryEntryId: row.memory_entry_id || null,
  };
}

async function rewardedTaskSource(taskId = "") {
  const result = await query(
    `
      SELECT p.*,
             COALESCE((
               SELECT jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at ASC, e.id ASC)
               FROM task_events e
               WHERE e.task_id = p.task_id
             ), '[]'::jsonb) AS memory_events
      FROM task_projections p
      WHERE p.task_id = $1
        AND lower(p.status) IN ('rewarded', 'paid', 'completed')
        AND ${canonicalRewardedTaskProjectionSql("p")}
      LIMIT 1
    `,
    [safeText(taskId, 180)]
  );
  return result.rows[0] || null;
}

export async function enqueueRewardedTaskMemoryForTask({ taskId = "" } = {}) {
  if (!databaseEnabled()) return { queued: false, reason: "database_not_configured" };
  const source = await rewardedTaskSource(taskId);
  if (!source) return { queued: false, reason: "rewarded_task_projection_missing" };
  return enqueueRewardedTaskMemory({ projection: source, events: source.memory_events });
}

export async function enqueueMissingRewardedTaskMemoryJobs({ limit = 3 } = {}) {
  if (!databaseEnabled()) return { ok: true, skipped: true, reason: "database_not_configured" };
  const normalizedLimit = Math.min(Math.max(Number(limit) || 3, 1), 25);
  const result = await query(
    `
      SELECT p.task_id
      FROM task_projections p
      LEFT JOIN task_reward_memory_jobs job ON job.task_id = p.task_id
      WHERE lower(p.status) IN ('rewarded', 'paid', 'completed')
        AND ${canonicalRewardedTaskProjectionSql("p")}
        AND job.task_id IS NULL
      ORDER BY p.updated_at ASC, p.task_id ASC
      LIMIT $1
    `,
    [normalizedLimit]
  );
  const results = [];
  for (const row of result.rows) {
    results.push(await enqueueRewardedTaskMemoryForTask({ taskId: row.task_id }).catch((error) => ({
      queued: false,
      reason: "rewarded_task_memory_enqueue_failed",
      error: safeText(error?.message || error, 1000),
    })));
  }
  return {
    ok: true,
    scanned: result.rows.length,
    queuedCount: results.filter((item) => item.queued).length,
    failedCount: results.filter((item) => item.reason === "rewarded_task_memory_enqueue_failed").length,
    results,
  };
}

export async function claimRewardedTaskMemoryJobs({ limit = 2 } = {}) {
  if (!databaseEnabled()) return [];
  const normalizedLimit = Math.min(Math.max(Number(limit) || 2, 1), maxClaimLimit);
  return transaction(async (client) => {
    await client.query(
      `
        UPDATE task_reward_memory_jobs
        SET status = 'pending', locked_at = NULL, next_attempt_at = now(), updated_at = now()
        WHERE status = 'processing'
          AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
      `
    );
    const result = await client.query(
      `
        WITH picked AS (
          SELECT id
          FROM task_reward_memory_jobs
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY created_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE task_reward_memory_jobs job
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

function memorySummaryText(value = "", max = 1800) {
  return safeText(value, max);
}

export async function completeRewardedTaskMemoryJob({ job = {}, summary = {} } = {}) {
  if (!databaseEnabled() || !job.id) return { ok: false };
  const task = safeObject(job.source_packet_json?.task);
  const taskId = safeText(job.task_id, 180);
  const entryId = `taskrewardmem_${randomUUID()}`;
  const result = await transaction(async (client) => {
    const inserted = await client.query(
      `
        INSERT INTO chat_memory_entries (
          id, account_id, conversation_id, conversation_title,
          user_message_id, assistant_message_id,
          user_request_summary, system_response_summary, memory_text,
          source_user_excerpt, source_assistant_excerpt,
          kind, deep_memory_block_index, provider, model, prompt_version, usage_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          'rewarded_task_memory', NULL, $12, $13, $14, $15::jsonb
        )
        ON CONFLICT (assistant_message_id) DO UPDATE SET
          conversation_title = EXCLUDED.conversation_title,
          user_request_summary = EXCLUDED.user_request_summary,
          system_response_summary = EXCLUDED.system_response_summary,
          memory_text = EXCLUDED.memory_text,
          source_user_excerpt = EXCLUDED.source_user_excerpt,
          source_assistant_excerpt = EXCLUDED.source_assistant_excerpt,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          prompt_version = EXCLUDED.prompt_version,
          usage_json = EXCLUDED.usage_json
        RETURNING id
      `,
      [
        entryId,
        safeText(job.account_id, 180),
        `rewarded_task_${taskId}`,
        safeText(`Rewarded Task: ${task.title || taskId}`, 120),
        `rewarded_task_${taskId}_source`,
        `rewarded_task_${taskId}_summary`,
        memorySummaryText(summary.userRequestSummary, 1800),
        memorySummaryText(summary.systemResponseSummary, 1800),
        memorySummaryText(summary.memoryText, 1800),
        safeText(task.description || task.title, 500),
        safeText(`Rewarded ${numeric(task.reward_actual_pft)} PFT`, 500),
        safeText(summary.provider, 80),
        safeText(summary.model, 160),
        safeText(summary.promptVersion, 80),
        JSON.stringify(safeObject(summary.usage)),
      ]
    );
    await client.query(
      `
        UPDATE task_reward_memory_jobs
        SET status = 'completed', memory_entry_id = $2, locked_at = NULL,
            last_error = '', updated_at = now()
        WHERE id = $1
      `,
      [job.id, inserted.rows[0].id]
    );
    return { ok: true, entryId: inserted.rows[0].id };
  });
  const deepMemoryJob = await enqueueMissingDeepMemoryJobs({ accountId: job.account_id }).catch(() => null);
  await recordUserObservabilityEvent({
    eventType: "user.memory.rewarded_task_completed",
    accountId: safeText(job.account_id, 180),
    taskId,
    sourceSurface: "memory",
    sourceRoute: "server/repositories/task-reward-memory.js::completeRewardedTaskMemoryJob",
    resultStatus: "completed",
    metadata: {
      jobId: job.id,
      entryId: result.entryId,
      provider: safeText(summary.provider, 80),
      model: safeText(summary.model, 160),
      promptVersion: safeText(summary.promptVersion, 80),
      deepMemoryQueued: deepMemoryJob?.queued === true,
    },
    metrics: {
      inputTokens: Number(summary.usage?.inputTokens || 0),
      outputTokens: Number(summary.usage?.outputTokens || 0),
      totalTokens: Number(summary.usage?.totalTokens || 0),
    },
  }).catch(() => {});
  return { ...result, deepMemoryJob };
}

export async function failRewardedTaskMemoryJob(job = {}, error = null) {
  if (!databaseEnabled() || !job.id) return { ok: false };
  const attemptCount = Number(job.attempt_count || 0);
  const finalFailure = attemptCount >= failedAttemptLimit;
  const backoffSeconds = Math.min(900, Math.max(30, 30 * attemptCount * attemptCount));
  await query(
    `
      UPDATE task_reward_memory_jobs
      SET status = $2,
          next_attempt_at = CASE WHEN $2 = 'failed' THEN next_attempt_at
            ELSE now() + ($3::text || ' seconds')::interval END,
          locked_at = NULL,
          last_error = $4,
          updated_at = now()
      WHERE id = $1
    `,
    [
      job.id,
      finalFailure ? "failed" : "pending",
      String(backoffSeconds),
      safeText(error?.message || error || "rewarded_task_memory_failed", 1000),
    ]
  );
  return { ok: true, retry: !finalFailure };
}
