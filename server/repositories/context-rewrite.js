import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, databaseStatus, query, transaction } from "../db/pool.js";
import { getContextDocument } from "./context.js";

const modeName = "Context Rewrite";
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const runningStatuses = new Set(["queued", "running"]);

function useDatabase() {
  return databaseEnabled();
}

export function contextRewriteStatus() {
  return databaseStatus();
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function contextRewriteStateError(row = null, jobId = "") {
  const status = safeText(row?.status || "", 80);
  const stage = safeText(row?.current_stage || "", 80);
  const error = new Error(status === "cancelled" ? "context_rewrite_cancelled" : "context_rewrite_job_not_running");
  error.contextRewriteTerminal = terminalStatuses.has(status) || status !== "running";
  error.contextRewriteStatus = status;
  error.contextRewriteStage = stage;
  error.contextRewriteJobId = safeText(row?.id || jobId, 180);
  return error;
}

function contextRewriteLockError(row = null, expected = "") {
  const error = new Error("context_rewrite_job_lock_lost");
  error.contextRewriteTerminal = true;
  error.contextRewriteStatus = safeText(row?.status || "", 80);
  error.contextRewriteStage = safeText(row?.current_stage || "", 80);
  error.contextRewriteJobId = safeText(row?.id || "", 180);
  error.expectedLockedBy = safeText(expected, 120);
  return error;
}

function expectedLockedBy(job = {}) {
  return safeText(job?.lockedBy || job?.locked_by || "", 120);
}

function currentAttemptId(job = {}) {
  return safeText(job?.currentAttemptId || job?.current_attempt_id || "", 180);
}

function assertRunningRow(row = null, { jobId = "", lockedBy = "" } = {}) {
  if (!row || row.status !== "running") {
    throw contextRewriteStateError(row, jobId);
  }
  if (lockedBy && safeText(row.locked_by, 120) !== lockedBy) {
    throw contextRewriteLockError(row, lockedBy);
  }
}

export function isContextRewriteTerminalError(error = null) {
  return Boolean(error?.contextRewriteTerminal);
}

function safeAccountId(accountId = "") {
  return safeText(accountId, 160);
}

function safeConversationId(conversationId = "") {
  return safeText(conversationId || "dev", 180) || "dev";
}

function safeConversationAccountId(accountId = "") {
  return String(accountId || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function assertConversationIdAccountBoundary({ accountId = "", conversationId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  if (!normalizedConversationId.startsWith("account_")) return;
  const accountPrefix = safeConversationAccountId(normalizedAccountId)
    ? `account_${safeConversationAccountId(normalizedAccountId)}_`
    : "";
  if (!accountPrefix || !normalizedConversationId.startsWith(accountPrefix)) {
    const error = new Error("chat_conversation_not_found");
    error.status = 404;
    throw error;
  }
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function jsonValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function preview(value = "") {
  return safeText(value, 180).replace(/\s+/g, " ");
}

function filenameForJob(jobId = "") {
  const date = new Date().toISOString().slice(0, 10);
  return `context-rewrite-${date}-${safeText(jobId, 30) || "artifact"}.md`;
}

function staleRunningMinutes() {
  const parsed = Number(process.env.CONTEXT_REWRITE_RUNNING_STALE_MINUTES || 60);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : 60, 30), 24 * 60);
}

function staleRunningMs() {
  return staleRunningMinutes() * 60 * 1000;
}

function retryBudgetLimit(estimateCostUsd = 0) {
  const configured = Number(process.env.CONTEXT_REWRITE_MAX_COST_USD || 0);
  if (Number.isFinite(configured) && configured > 0) return numeric(configured);
  return numeric(estimateCostUsd);
}

function isObjectWithKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function ageMs(value, nowMs = Date.now()) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : 0;
}

function addMs(value, ms = 0) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed + ms).toISOString() : null;
}

function statusMessageForJob({ row = {}, progress = {}, stalled = false } = {}) {
  const status = row.status || "";
  const stage = row.current_stage || status || "running";
  if (status === "completed") return "Context Rewrite ready.";
  if (status === "failed") return row.error || "Context Rewrite failed before producing a Markdown artifact.";
  if (status === "cancelled") return "Context Rewrite cancelled.";
  if (stalled) return "Stalled; recovery will retry shortly.";
  if (Number(row.retry_count || 0) > 0 && status === "running") {
    return `Worker interrupted, retrying from ${String(stage).replaceAll("_", " ")}.`;
  }
  if (stage === "final_rewrite" || stage === "polish_rewrite") return "Provider call still running.";
  return progressMessage(progress, "Context Rewrite is running. This can take a while; check back in this tab.");
}

const progressSteps = [
  {
    key: "queued",
    label: "Queued",
    detail: "Waiting for the Context Rewrite worker.",
  },
  {
    key: "source_packet",
    label: "Assemble sources",
    detail: "Context, memory, chat, task history, network profile, and Jobs retrieval.",
  },
  {
    key: "scoring",
    label: "Score current document",
    detail: "GLM and DeepSeek scorer calls run concurrently.",
  },
  {
    key: "research",
    label: "Run web research",
    detail: "Two mini web-search calls run concurrently with only selected domain questions.",
  },
  {
    key: "final_rewrite",
    label: "Draft Markdown artifact",
    detail: "Final rewrite uses the source packet, aggregate score, research, and Jobs retrieval.",
  },
  {
    key: "polish_rewrite",
    label: "Polish Markdown artifact",
    detail: "GLM 5.2 xhigh pass improves readability, persuasion, flow, formatting, and actionability.",
  },
  {
    key: "completed",
    label: "Artifact ready",
    detail: "Markdown is available for copy and download.",
  },
];

const progressStepIndex = new Map(progressSteps.map((step, index) => [step.key, index]));

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function eventStatusForStage({ stage = "", status = "running" } = {}) {
  if (status === "completed" || stage === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "running";
}

function buildContextRewriteProgress({
  existingProgress = {},
  stage = "queued",
  status = "running",
  message = "",
  details = {},
} = {}) {
  const normalizedStage = safeText(stage || "queued", 80) || "queued";
  const normalizedStatus = safeText(status || "running", 80) || "running";
  const normalizedDetails = jsonValue(details);
  const stageIndex = progressStepIndex.has(normalizedStage)
    ? progressStepIndex.get(normalizedStage)
    : progressStepIndex.get("queued");
  const now = new Date().toISOString();
  const event = {
    at: now,
    stage: normalizedStage,
    status: eventStatusForStage({ stage: normalizedStage, status: normalizedStatus }),
    message: safeText(message || normalizedDetails.message || "", 240),
  };
  const existingEvents = safeArray(existingProgress.events).filter((item) => item && typeof item === "object");
  const lastEvent = existingEvents[existingEvents.length - 1] || {};
  const events = (
    lastEvent.stage === event.stage &&
    lastEvent.status === event.status &&
    lastEvent.message === event.message
      ? existingEvents
      : [...existingEvents, event]
  ).slice(-24);

  const firstEventFor = (key) => events.find((item) => item.stage === key)?.at || null;
  const trace = progressSteps.map((step, index) => {
    let stepStatus = "queued";
    if (normalizedStatus === "failed" && step.key === normalizedStage) {
      stepStatus = "failed";
    } else if (normalizedStatus === "cancelled" && (step.key === normalizedStage || index === stageIndex)) {
      stepStatus = "cancelled";
    } else if (normalizedStatus === "completed" || normalizedStage === "completed" || index < stageIndex) {
      stepStatus = "completed";
    } else if (index === stageIndex) {
      stepStatus = "running";
    }
    return {
      key: step.key,
      label: step.label,
      status: stepStatus,
      detail: step.detail,
      at: firstEventFor(step.key),
    };
  });

  const extras = { ...normalizedDetails };
  delete extras.stage;
  delete extras.status;
  delete extras.message;
  delete extras.trace;
  delete extras.events;

  return {
    schema: "context_rewrite.progress.v1",
    stage: normalizedStage,
    status: normalizedStatus,
    message: event.message || "Context Rewrite is running.",
    updatedAt: now,
    ...extras,
    trace,
    events,
  };
}

function progressMessage(progress = {}, fallback = "") {
  return safeText(progress.message || fallback || "", 400);
}

function publicMessage(row = null) {
  if (!row) return null;
  const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  const message = {
    id: row.id,
    role: row.role,
    body: row.body,
    createdAt: toIso(row.created_at),
    mode: row.mode || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    responseId: row.response_id || undefined,
  };
  if (Object.keys(metadata).length > 0) message.metadata = metadata;
  return message;
}

function publicJob(row = null, { includeMarkdown = true, includeInternal = false } = {}) {
  if (!row) return null;
  const progress = jsonValue(row.progress_json);
  const finalMetadata = jsonValue(row.final_metadata_json);
  const finalMarkdown = String(row.final_markdown || "");
  const nowMs = Date.now();
  const lastProgressAt = progress.updatedAt || toIso(row.updated_at) || toIso(row.locked_at) || toIso(row.started_at) || toIso(row.created_at);
  const lastLeaseAt = toIso(row.locked_at) || lastProgressAt;
  const staleAfterMs = staleRunningMs();
  const staleAfter = row.status === "running" ? addMs(lastLeaseAt, staleAfterMs) : null;
  const elapsedSinceProgressMs = lastProgressAt ? ageMs(lastProgressAt, nowMs) : 0;
  const stalled = row.status === "running" && lastLeaseAt ? ageMs(lastLeaseAt, nowMs) > staleAfterMs : false;
  const attempt = safeText(row.current_attempt_id || "", 180) || (Number(row.retry_count || 0) + 1);
  const maxCostUsd = numeric(row.max_cost_usd || row.estimate_cost_usd || 0);
  const actualCostUsd = numeric(row.actual_cost_usd);
  const job = {
    id: row.id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    instructionMessageId: row.instruction_message_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    currentStage: row.current_stage,
    estimateCostUsd: numeric(row.estimate_cost_usd),
    actualCostUsd,
    maxCostUsd,
    finalArtifactId: row.final_artifact_id || "",
    progress,
    error: row.status === "failed" ? row.error || "context_rewrite_failed" : "",
    lastProgressAt,
    elapsedSinceProgressMs,
    staleAfter,
    staleAfterMs,
    retryCount: Number(row.retry_count || 0),
    attempt,
    stalled,
    statusMessage: statusMessageForJob({ row, progress, stalled }),
    createdAt: toIso(row.created_at),
    queuedAt: toIso(row.queued_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    cancelledAt: toIso(row.cancelled_at),
    warning:
      "Context Rewrite runs multiple model calls and web research. The final charge may be higher than a normal chat call.",
  };
  if (row.status === "completed" && includeMarkdown) {
    job.artifact = {
      id: row.final_artifact_id || "",
      filename: finalMetadata.filename || filenameForJob(row.id),
      markdown: finalMarkdown,
      metadata: {
        title: finalMetadata.title || "Context Rewrite",
        summary: finalMetadata.summary || "",
        jobsPrinciples: finalMetadata.jobsPrinciples || finalMetadata.jobs_principles || [],
      },
    };
  }
  if (includeInternal) {
    job.aggregateScore = jsonValue(row.aggregate_score_json);
    job.jobsRetrieval = jsonValue(row.jobs_retrieval_json);
    job.finalMetadata = finalMetadata;
    job.baseContextRevision = Number(row.base_context_revision || 0);
    job.baseBodySha256 = row.base_body_sha256 || "";
    job.sourcePacketDigest = row.source_packet_digest || "";
    job.sourcePacket = jsonValue(row.source_packet_json);
    job.sourceSnapshotAt = toIso(row.source_snapshot_at);
    job.draftMarkdown = row.draft_markdown || "";
    job.draftMetadata = jsonValue(row.draft_metadata_json);
    job.currentAttemptId = row.current_attempt_id || "";
    job.instructionText = row.instruction_text || "";
    job.lockedAt = toIso(row.locked_at);
    job.lockedBy = row.locked_by || "";
  }
  return job;
}

function pendingAssistantBody(stage = "queued", progress = {}) {
  const message = progressMessage(progress);
  if (message) return message;
  if (stage === "queued") return "Context Rewrite is queued. This can take a while; check back in this tab.";
  if (stage === "completed") return "Context Rewrite is ready as a Markdown artifact.";
  if (stage === "cancelled") return "Context Rewrite cancelled.";
  return "Context Rewrite is running. This can take a while; check back in this tab.";
}

function pendingMetadata({
  jobId,
  status = "queued",
  stage = "queued",
  estimateCostUsd = 0,
  actualCostUsd = 0,
  progress = {},
} = {}) {
  const normalizedProgress = Object.keys(jsonValue(progress)).length
    ? jsonValue(progress)
    : buildContextRewriteProgress({ stage, status, message: pendingAssistantBody(stage) });
  return {
    kind: "context_rewrite",
    contextRewrite: {
      jobId,
      status,
      stage,
      estimateCostUsd,
      actualCostUsd,
      progress: normalizedProgress,
      trace: safeArray(normalizedProgress.trace),
      warning:
        "Context Rewrite runs multiple model calls and web research. The charge may be higher than other tool calls.",
    },
    thinking: {
      state: terminalStatuses.has(status) ? "stopped" : "running",
    },
  };
}

async function updateContextRewriteAssistantProgress(row = null, progress = {}) {
  if (!row?.assistant_message_id || !row?.account_id) return null;
  const result = await query(
    `
      UPDATE chat_messages
      SET body = $3,
          metadata_json = $4
      WHERE id = $1
        AND account_id = $2
      RETURNING *
    `,
    [
      row.assistant_message_id,
      row.account_id,
      pendingAssistantBody(row.current_stage || "running", progress),
      pendingMetadata({
        jobId: row.id,
        status: row.status || "running",
        stage: row.current_stage || "running",
        estimateCostUsd: numeric(row.estimate_cost_usd),
        actualCostUsd: numeric(row.actual_cost_usd),
        progress,
      }),
    ]
  );
  return publicMessage(result.rows[0]);
}

export async function createContextRewriteJob({
  accountId = "",
  conversationId = "dev",
  instructionText = "",
  estimateCostUsd = 0,
} = {}) {
  if (!useDatabase()) {
    const error = new Error("context_rewrite_database_required");
    error.status = 409;
    throw error;
  }
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  const instruction = safeText(instructionText, 12000);
  if (!normalizedAccountId) {
    const error = new Error("context_rewrite_login_required");
    error.status = 401;
    throw error;
  }
  if (!instruction) {
    const error = new Error("context_rewrite_instruction_required");
    error.status = 400;
    throw error;
  }
  assertConversationIdAccountBoundary({ accountId: normalizedAccountId, conversationId: normalizedConversationId });

  const context = await getContextDocument({ accountId: normalizedAccountId });
  const contextBodySha = sha256(context?.body || "");
  const jobId = `ctxrw_${randomUUID()}`;
  const userMessageId = `msg_${randomUUID()}_context_rewrite_user`;
  const assistantMessageId = `msg_${randomUUID()}_context_rewrite_assistant`;
  const now = new Date();
  const maxCostUsd = retryBudgetLimit(estimateCostUsd);
  const queuedProgress = buildContextRewriteProgress({
    stage: "queued",
    status: "queued",
    message: "Context Rewrite queued. The worker will assemble sources, score, research, and write the artifact.",
  });

  return transaction(async (client) => {
    const existing = await client.query(
      "SELECT id, account_id FROM chat_conversations WHERE id = $1 FOR UPDATE",
      [normalizedConversationId]
    );
    const owner = existing.rows[0]?.account_id || "";
    if (existing.rows[0] && owner !== normalizedAccountId) {
      const error = new Error("chat_conversation_not_found");
      error.status = 404;
      throw error;
    }

    await client.query(
      `
        INSERT INTO chat_conversations (
          id,
          account_id,
          title,
          status,
          mode,
          created_at,
          updated_at,
          last_message_at,
          last_message_preview,
          message_count
        )
        VALUES ($1, $2, $3, 'active', $4, $5, $5, $5, $6, 2)
        ON CONFLICT (id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          status = 'active',
          title = CASE
            WHEN chat_conversations.title IS NULL
              OR chat_conversations.title = ''
              OR chat_conversations.title = 'New chat'
            THEN EXCLUDED.title
            ELSE chat_conversations.title
          END,
          mode = COALESCE(chat_conversations.mode, EXCLUDED.mode),
          updated_at = EXCLUDED.updated_at,
          last_message_at = EXCLUDED.last_message_at,
          last_message_preview = EXCLUDED.last_message_preview,
          message_count = chat_conversations.message_count + 2,
          deleted_at = NULL
      `,
      [
        normalizedConversationId,
        normalizedAccountId,
        preview(instruction) || "Context Rewrite",
        modeName,
        now,
        "Context Rewrite queued.",
      ]
    );

    const userInsert = await client.query(
      `
        INSERT INTO chat_messages (
          id,
          conversation_id,
          account_id,
          role,
          body,
          mode,
          created_at,
          metadata_json
        )
        VALUES ($1, $2, $3, 'user', $4, $5, $6, $7)
        RETURNING *
      `,
      [
        userMessageId,
        normalizedConversationId,
        normalizedAccountId,
        instruction,
        modeName,
        now,
        {
          kind: "context_rewrite_instruction",
          contextRewrite: { jobId, status: "queued" },
        },
      ]
    );

    const assistantInsert = await client.query(
      `
        INSERT INTO chat_messages (
          id,
          conversation_id,
          account_id,
          role,
          body,
          mode,
          created_at,
          metadata_json
        )
        VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7)
        RETURNING *
      `,
      [
        assistantMessageId,
        normalizedConversationId,
        normalizedAccountId,
        pendingAssistantBody("queued", queuedProgress),
        modeName,
        now,
        pendingMetadata({ jobId, status: "queued", stage: "queued", estimateCostUsd, progress: queuedProgress }),
      ]
    );

    const jobInsert = await client.query(
      `
        INSERT INTO context_rewrite_jobs (
          id,
          account_id,
          conversation_id,
          instruction_message_id,
          assistant_message_id,
          instruction_text,
          base_context_revision,
          base_body_sha256,
          status,
          current_stage,
          estimate_cost_usd,
          max_cost_usd,
          progress_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 'queued', $9, $10, $11)
        RETURNING *
      `,
      [
        jobId,
        normalizedAccountId,
        normalizedConversationId,
        userMessageId,
        assistantMessageId,
        instruction,
        Number(context?.revision || 0),
        contextBodySha,
        numeric(estimateCostUsd),
        maxCostUsd,
        queuedProgress,
      ]
    );

    return {
      job: publicJob(jobInsert.rows[0], { includeMarkdown: false }),
      user: publicMessage(userInsert.rows[0]),
      assistant: publicMessage(assistantInsert.rows[0]),
    };
  });
}

export async function getContextRewriteJob({ accountId = "", jobId = "", includeInternal = false } = {}) {
  if (!useDatabase()) return null;
  const result = await query(
    `
      SELECT *
      FROM context_rewrite_jobs
      WHERE id = $1
        AND account_id = $2
      LIMIT 1
    `,
    [safeText(jobId, 180), safeAccountId(accountId)]
  );
  return publicJob(result.rows[0], { includeInternal });
}

export async function getContextRewriteAssistantMessage({ accountId = "", messageId = "" } = {}) {
  if (!useDatabase()) return null;
  const result = await query(
    `
      SELECT *
      FROM chat_messages
      WHERE id = $1
        AND account_id = $2
      LIMIT 1
    `,
    [safeText(messageId, 180), safeAccountId(accountId)]
  );
  return publicMessage(result.rows[0]);
}

export async function getContextRewriteArtifact({ accountId = "", jobId = "" } = {}) {
  if (!useDatabase()) return null;
  const result = await query(
    `
      SELECT *
      FROM context_rewrite_artifacts
      WHERE job_id = $1
        AND account_id = $2
        AND artifact_type = 'final_markdown'
      ORDER BY is_current DESC, created_at DESC, id DESC
      LIMIT 1
    `,
    [safeText(jobId, 180), safeAccountId(accountId)]
  );
  const row = result.rows[0];
  if (!row) return null;
  const metadata = jsonValue(row.metadata_json);
  return {
    id: row.id,
    jobId: row.job_id,
    artifactType: row.artifact_type,
    filename: metadata.filename || filenameForJob(row.job_id),
    markdown: row.markdown || "",
    metadata,
    createdAt: toIso(row.created_at),
  };
}

export async function claimContextRewriteJobs({ limit = 1, workerId = "" } = {}) {
  if (!useDatabase()) return [];
  const normalizedLimit = Math.min(Math.max(Number(limit) || 1, 1), 10);
  const staleMinutes = staleRunningMinutes();
  const locker = safeText(workerId || `ctxrw_worker_${process.pid}`, 120);
  const result = await transaction(async (client) => {
    const rows = await client.query(
      `
        SELECT *
        FROM context_rewrite_jobs
        WHERE status = 'queued'
           OR (
             status = 'running'
             AND (locked_at IS NULL OR locked_at < now() - ($2 * interval '1 minute'))
           )
        ORDER BY
          CASE WHEN status = 'queued' THEN 0 ELSE 1 END,
          COALESCE(queued_at, locked_at, created_at) ASC,
          id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [normalizedLimit, staleMinutes]
    );
    if (rows.rows.length === 0) return [];
    const claimed = [];
    for (const row of rows.rows) {
      const retrying = row.status === "running";
      const nextStage = retrying ? row.current_stage || "source_packet" : "source_packet";
      const attemptId = `ctxrw_attempt_${randomUUID()}`;
      const claimedProgress = buildContextRewriteProgress({
        existingProgress: jsonValue(row.progress_json),
        stage: nextStage,
        status: "running",
        message: retrying
          ? `Worker interrupted, retrying from ${String(nextStage).replaceAll("_", " ")}.`
          : "Assembling context, memory, tasks, chat, profile, and Jobs retrieval.",
        details: {
          retryCount: Number(row.retry_count || 0) + (retrying ? 1 : 0),
          attemptId,
        },
      });
      const updated = await client.query(
        `
          UPDATE context_rewrite_jobs
          SET
            status = 'running',
            current_stage = $2,
            locked_at = now(),
            locked_by = $3,
            current_attempt_id = $4,
            started_at = COALESCE(started_at, now()),
            retry_count = CASE WHEN status = 'running' THEN retry_count + 1 ELSE retry_count END,
            updated_at = now(),
            progress_json = $5
          WHERE id = $1
            AND (
              status = 'queued'
              OR (
                status = 'running'
                AND (locked_at IS NULL OR locked_at < now() - ($6 * interval '1 minute'))
              )
            )
          RETURNING *
        `,
        [row.id, nextStage, locker, attemptId, claimedProgress, staleMinutes]
      );
      if (updated.rows[0]) claimed.push(publicJob(updated.rows[0], { includeInternal: true }));
    }
    return claimed;
  });
  return result;
}

export async function updateContextRewriteStage({
  job = null,
  jobId = "",
  stage = "",
  progress = {},
  sourcePacket = null,
  sourcePacketDigest = "",
  baseContextRevision = null,
  baseBodySha256 = "",
  jobsRetrieval = null,
  aggregateScore = null,
  addCostUsd = 0,
} = {}) {
  if (!useDatabase()) return null;
  const targetJobId = safeText(job?.id || jobId, 180);
  const lockedBy = expectedLockedBy(job);
  const existing = await query(
    "SELECT * FROM context_rewrite_jobs WHERE id = $1 LIMIT 1",
    [targetJobId]
  );
  assertRunningRow(existing.rows[0], { jobId: targetJobId, lockedBy });
  const nextProgress = buildContextRewriteProgress({
    existingProgress: jsonValue(existing.rows[0]?.progress_json),
    stage,
    status: "running",
    message: progress?.message || "",
    details: progress,
  });
  const sets = [
    "current_stage = $2",
    "progress_json = $3",
    "actual_cost_usd = actual_cost_usd + $4",
    "locked_at = now()",
    "updated_at = now()",
  ];
  const params = [targetJobId, safeText(stage, 80), nextProgress, numeric(addCostUsd)];
  if (sourcePacketDigest) {
    params.push(safeText(sourcePacketDigest, 100));
    sets.push(`source_packet_digest = $${params.length}`);
  }
  if (sourcePacket) {
    params.push(jsonValue(sourcePacket));
    sets.push(`source_packet_json = $${params.length}`);
    sets.push("source_snapshot_at = COALESCE(source_snapshot_at, now())");
  }
  if (baseContextRevision !== null && baseContextRevision !== undefined) {
    params.push(Number(baseContextRevision || 0));
    sets.push(`base_context_revision = $${params.length}`);
  }
  if (baseBodySha256) {
    params.push(safeText(baseBodySha256, 100));
    sets.push(`base_body_sha256 = $${params.length}`);
  }
  if (jobsRetrieval) {
    params.push(jsonValue(jobsRetrieval));
    sets.push(`jobs_retrieval_json = $${params.length}`);
  }
  if (aggregateScore) {
    params.push(jsonValue(aggregateScore));
    sets.push(`aggregate_score_json = $${params.length}`);
  }
  let lockGuard = "";
  if (lockedBy) {
    params.push(lockedBy);
    lockGuard = `AND locked_by = $${params.length}`;
  }
  const result = await query(
    `
      UPDATE context_rewrite_jobs
      SET ${sets.join(", ")}
      WHERE id = $1
        AND status = 'running'
        ${lockGuard}
      RETURNING *
    `,
    params
  );
  if (!result.rows[0]) {
    const refreshed = await query("SELECT * FROM context_rewrite_jobs WHERE id = $1 LIMIT 1", [targetJobId]);
    assertRunningRow(refreshed.rows[0], { jobId: targetJobId, lockedBy });
    throw new Error("context_rewrite_stage_update_lost");
  }
  await updateContextRewriteAssistantProgress(result.rows[0], nextProgress);
  return publicJob(result.rows[0], { includeInternal: true });
}

export async function addContextRewriteActualCost({ jobId = "", costUsd = 0 } = {}) {
  if (!useDatabase() || !(Number(costUsd) > 0)) return null;
  const result = await query(
    `
      UPDATE context_rewrite_jobs
      SET actual_cost_usd = actual_cost_usd + $2,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [safeText(jobId, 180), numeric(costUsd)]
  );
  return publicJob(result.rows[0], { includeInternal: true });
}

export async function assertContextRewriteBudgetAvailable({ job = {}, stage = "" } = {}) {
  if (!useDatabase()) return true;
  const result = await query(
    `
      SELECT id, actual_cost_usd, max_cost_usd, estimate_cost_usd, status
      FROM context_rewrite_jobs
      WHERE id = $1
      LIMIT 1
    `,
    [safeText(job.id, 180)]
  );
  const row = result.rows[0];
  if (!row || terminalStatuses.has(row.status)) return true;
  const maxCostUsd = numeric(row.max_cost_usd || row.estimate_cost_usd || 0);
  if (!(maxCostUsd > 0)) return true;
  const actualCostUsd = numeric(row.actual_cost_usd);
  if (actualCostUsd < maxCostUsd) return true;
  const error = new Error("context_rewrite_retry_budget_exhausted");
  error.contextRewriteStage = safeText(stage, 80);
  error.actualCostUsd = actualCostUsd;
  error.maxCostUsd = maxCostUsd;
  throw error;
}

export async function createContextRewriteProviderCall({
  job = {},
  stage = "",
  callIndex = 0,
  provider = "ambient",
  model = "",
  requestDigest = "",
  timeoutMs = 0,
  metadata = {},
} = {}) {
  if (!useDatabase()) return null;
  const attemptId = currentAttemptId(job) || `ctxrw_attempt_${randomUUID()}`;
  const timeoutAt = Number(timeoutMs || 0) > 0 ? new Date(Date.now() + Number(timeoutMs)) : null;
  const result = await query(
    `
      INSERT INTO context_rewrite_provider_calls (
        id,
        job_id,
        account_id,
        attempt_id,
        stage,
        call_index,
        provider,
        model,
        status,
        request_digest,
        timeout_at,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10, $11)
      ON CONFLICT (job_id, attempt_id, stage, call_index)
      DO UPDATE SET
        status = CASE
          WHEN context_rewrite_provider_calls.status IN ('completed', 'running')
          THEN context_rewrite_provider_calls.status
          ELSE 'running'
        END,
        heartbeat_at = CASE
          WHEN context_rewrite_provider_calls.status = 'completed'
          THEN context_rewrite_provider_calls.heartbeat_at
          ELSE now()
        END,
        timeout_at = COALESCE(context_rewrite_provider_calls.timeout_at, EXCLUDED.timeout_at),
        updated_at = now()
      RETURNING *
    `,
    [
      `ctxrw_call_${randomUUID()}`,
      job.id,
      job.accountId,
      attemptId,
      safeText(stage, 120),
      Number(callIndex || 0),
      safeText(provider, 80),
      safeText(model, 180),
      safeText(requestDigest, 100),
      timeoutAt,
      jsonValue(metadata),
    ]
  );
  return result.rows[0] || null;
}

export async function heartbeatContextRewriteProviderCall({ job = {}, providerCallId = "" } = {}) {
  if (!useDatabase()) return null;
  const lockedBy = expectedLockedBy(job);
  return transaction(async (client) => {
    const callUpdate = await client.query(
      `
        UPDATE context_rewrite_provider_calls
        SET heartbeat_at = now(),
            updated_at = now()
        WHERE id = $1
          AND status = 'running'
        RETURNING *
      `,
      [safeText(providerCallId, 180)]
    );
    const params = [safeText(job.id, 180)];
    let lockGuard = "";
    if (lockedBy) {
      params.push(lockedBy);
      lockGuard = `AND locked_by = $${params.length}`;
    }
    await client.query(
      `
        UPDATE context_rewrite_jobs
        SET locked_at = now(),
            updated_at = now()
        WHERE id = $1
          AND status = 'running'
          ${lockGuard}
      `,
      params
    );
    return callUpdate.rows[0] || null;
  });
}

export async function finishContextRewriteProviderCall({
  providerCallId = "",
  status = "completed",
  result = {},
  usage = {},
  costUsd = 0,
  error = "",
} = {}) {
  if (!useDatabase() || !providerCallId) return null;
  const finalStatus = safeText(status || "completed", 80);
  const outputText = safeText(result?.text || "", 4000);
  const update = await query(
    `
      UPDATE context_rewrite_provider_calls
      SET status = $2,
          response_id = $3,
          usage_json = $4,
          cost_usd = $5,
          result_json = $6,
          annotations_json = $7::jsonb,
          raw_text_excerpt = $8,
          error = $9,
          completed_at = CASE WHEN $2 <> 'running' THEN now() ELSE completed_at END,
          heartbeat_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      safeText(providerCallId, 180),
      finalStatus,
      result?.responseId || null,
      jsonValue(usage),
      numeric(costUsd),
      jsonValue(result?.parsed || {}),
      JSON.stringify(Array.isArray(result?.annotations) ? result.annotations : []),
      outputText,
      safeText(error, 1000) || null,
    ]
  );
  return update.rows[0] || null;
}

export async function markTimedOutContextRewriteProviderCalls() {
  if (!useDatabase()) return { marked: 0 };
  const result = await query(
    `
      UPDATE context_rewrite_provider_calls
      SET status = CASE
            WHEN timeout_at IS NOT NULL AND timeout_at < now() THEN 'timed_out'
            ELSE 'orphaned'
          END,
          error = COALESCE(error, 'context_rewrite_provider_call_orphaned'),
          completed_at = now(),
          updated_at = now()
      WHERE status = 'running'
        AND (
          (timeout_at IS NOT NULL AND timeout_at < now())
          OR heartbeat_at < now() - ($1 * interval '1 millisecond')
        )
      RETURNING id
    `,
    [staleRunningMs()]
  );
  return { marked: result.rowCount || 0 };
}

export async function listCompletedContextRewriteScoreRuns({ jobId = "" } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT *
      FROM context_rewrite_score_runs
      WHERE job_id = $1
        AND status = 'completed'
      ORDER BY completed_at ASC, created_at ASC, id ASC
    `,
    [safeText(jobId, 180)]
  );
  return result.rows;
}

export async function listCompletedContextRewriteSearchResults({ jobId = "" } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT *
      FROM context_rewrite_search_results
      WHERE job_id = $1
        AND status = 'completed'
      ORDER BY query_index ASC, completed_at ASC, created_at ASC, id ASC
    `,
    [safeText(jobId, 180)]
  );
  return result.rows;
}

export async function getCompletedContextRewriteProviderCall({ jobId = "", stage = "", callIndex = 0 } = {}) {
  if (!useDatabase()) return null;
  const result = await query(
    `
      SELECT *
      FROM context_rewrite_provider_calls
      WHERE job_id = $1
        AND stage = $2
        AND call_index = $3
        AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    `,
    [safeText(jobId, 180), safeText(stage, 120), Number(callIndex || 0)]
  );
  return result.rows[0] || null;
}

export async function contextRewriteWatchdogSnapshot({ limit = 20 } = {}) {
  if (!useDatabase()) {
    return {
      ok: true,
      enabled: false,
      counts: {},
      staleCount: 0,
      runningProviderCallCount: 0,
      timedOutProviderCallCount: 0,
      staleJobs: [],
    };
  }
  const staleMs = staleRunningMs();
  const [jobCounts, staleJobs, providerCounts] = await Promise.all([
    query(
      `
        SELECT status, count(*)::int AS count
        FROM context_rewrite_jobs
        GROUP BY status
      `
    ),
    query(
      `
        SELECT id, account_id, conversation_id, current_stage, retry_count, locked_at, locked_by, updated_at, error
        FROM context_rewrite_jobs
        WHERE status = 'running'
          AND (
            locked_at IS NULL
            OR locked_at < now() - ($1 * interval '1 millisecond')
          )
        ORDER BY COALESCE(locked_at, updated_at, started_at, created_at) ASC
        LIMIT $2
      `,
      [staleMs, Math.min(Math.max(Number(limit) || 20, 1), 100)]
    ),
    query(
      `
        SELECT status, count(*)::int AS count
        FROM context_rewrite_provider_calls
        GROUP BY status
      `
    ).catch(() => ({ rows: [] })),
  ]);
  const counts = {};
  for (const row of jobCounts.rows) counts[row.status || "unknown"] = Number(row.count || 0);
  const providerCallCounts = {};
  for (const row of providerCounts.rows) providerCallCounts[row.status || "unknown"] = Number(row.count || 0);
  return {
    ok: true,
    enabled: true,
    staleAfterMs: staleMs,
    counts,
    providerCallCounts,
    staleCount: staleJobs.rows.length,
    runningProviderCallCount: Number(providerCallCounts.running || 0),
    timedOutProviderCallCount: Number(providerCallCounts.timed_out || 0),
    staleJobs: staleJobs.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      currentStage: row.current_stage,
      retryCount: Number(row.retry_count || 0),
      lockedAt: toIso(row.locked_at),
      lockedBy: row.locked_by || "",
      updatedAt: toIso(row.updated_at),
      elapsedSinceLockMs: ageMs(row.locked_at || row.updated_at),
      error: row.error || "",
    })),
  };
}

export async function saveContextRewriteDraftCheckpoint({
  job = {},
  markdown = "",
  metadata = {},
} = {}) {
  if (!useDatabase()) return null;
  const lockedBy = expectedLockedBy(job);
  const params = [
    safeText(job.id, 180),
    String(markdown || "").trim(),
    jsonValue(metadata),
  ];
  let lockGuard = "";
  if (lockedBy) {
    params.push(lockedBy);
    lockGuard = `AND locked_by = $${params.length}`;
  }
  const result = await query(
    `
      UPDATE context_rewrite_jobs
      SET draft_markdown = $2,
          draft_metadata_json = $3,
          locked_at = now(),
          updated_at = now()
      WHERE id = $1
        AND status = 'running'
        ${lockGuard}
      RETURNING *
    `,
    params
  );
  if (!result.rows[0]) {
    const refreshed = await query("SELECT * FROM context_rewrite_jobs WHERE id = $1 LIMIT 1", [safeText(job.id, 180)]);
    assertRunningRow(refreshed.rows[0], { jobId: job.id, lockedBy });
  }
  return publicJob(result.rows[0], { includeInternal: true });
}

export async function recordContextRewriteScoreRun({
  job = {},
  modelFamily = "",
  runIndex = 0,
  attemptId = "",
  providerCallId = "",
  provider = "",
  model = "",
  responseId = "",
  promptDigest = "",
  parsedScore = {},
  rawText = "",
  usage = {},
  costUsd = 0,
  status = "completed",
  error = "",
} = {}) {
  if (!useDatabase()) return null;
  const result = await query(
    `
      INSERT INTO context_rewrite_score_runs (
        id,
        job_id,
        account_id,
        provider,
        model,
        model_family,
        run_index,
        status,
        prompt_digest,
        attempt_id,
        provider_call_id,
        parsed_score_json,
        raw_text_excerpt,
        usage_json,
        cost_usd,
        response_id,
        error,
        completed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
      RETURNING *
    `,
    [
      `ctxrw_score_${randomUUID()}`,
      job.id,
      job.accountId,
      safeText(provider, 80),
      safeText(model, 180),
      safeText(modelFamily, 80),
      Number(runIndex || 0),
      safeText(status, 80),
      safeText(promptDigest, 100),
      safeText(attemptId || currentAttemptId(job), 180),
      safeText(providerCallId, 180),
      jsonValue(parsedScore),
      safeText(rawText, 4000),
      jsonValue(usage),
      numeric(costUsd),
      responseId || null,
      safeText(error, 1000) || null,
    ]
  );
  return result.rows[0];
}

export async function recordContextRewriteSearchResult({
  job = {},
  queryIndex = 0,
  queryText = "",
  attemptId = "",
  providerCallId = "",
  provider = "",
  model = "",
  responseId = "",
  resultJson = {},
  usage = {},
  costUsd = 0,
  status = "completed",
  error = "",
} = {}) {
  if (!useDatabase()) return null;
  const result = await query(
    `
      INSERT INTO context_rewrite_search_results (
        id,
        job_id,
        account_id,
        query_index,
        query_text,
        status,
        attempt_id,
        provider_call_id,
        provider,
        model,
        response_id,
        result_json,
        usage_json,
        cost_usd,
        error,
        completed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
      RETURNING *
    `,
    [
      `ctxrw_search_${randomUUID()}`,
      job.id,
      job.accountId,
      Number(queryIndex || 0),
      safeText(queryText, 400),
      safeText(status, 80),
      safeText(attemptId || currentAttemptId(job), 180),
      safeText(providerCallId, 180),
      safeText(provider, 80),
      safeText(model, 180),
      responseId || null,
      jsonValue(resultJson),
      jsonValue(usage),
      numeric(costUsd),
      safeText(error, 1000) || null,
    ]
  );
  return result.rows[0];
}

export async function completeContextRewriteJob({
  job = {},
  markdown = "",
  metadata = {},
  aggregateScore = {},
  sourcePacketDigest = "",
  addCostUsd = 0,
} = {}) {
  if (!useDatabase()) return null;
  const artifactId = `ctxrw_art_${randomUUID()}`;
  const finalMarkdown = String(markdown || "").trim();
  if (!finalMarkdown) throw new Error("context_rewrite_final_markdown_empty");
  const filename = filenameForJob(job.id);
  const lockedBy = expectedLockedBy(job);
  return transaction(async (client) => {
    const existing = await client.query(
      "SELECT * FROM context_rewrite_jobs WHERE id = $1 FOR UPDATE",
      [safeText(job.id, 180)]
    );
    const row = existing.rows[0];
    assertRunningRow(row, { jobId: job.id, lockedBy });
    const accountId = row.account_id;
    const assistantMessageId = row.assistant_message_id;
    const actualCostUsd = numeric(Number(row.actual_cost_usd || 0) + Number(addCostUsd || 0));
    const finalMetadata = {
      ...jsonValue(metadata),
      filename,
      title: metadata.title || "Context Rewrite",
      completedAt: new Date().toISOString(),
    };
    const completeProgress = buildContextRewriteProgress({
      existingProgress: jsonValue(row.progress_json),
      stage: "completed",
      status: "completed",
      message: "Context Rewrite complete. Markdown is ready to copy or download.",
      details: {
        artifactId,
        actualCostUsd,
      },
    });
    await client.query(
      `
        UPDATE context_rewrite_artifacts
        SET is_current = false
        WHERE job_id = $1
          AND artifact_type = 'final_markdown'
      `,
      [job.id]
    );

    await client.query(
      `
        INSERT INTO context_rewrite_artifacts (
          id,
          job_id,
          account_id,
          artifact_type,
          source_packet_digest,
          markdown,
          metadata_json,
          is_current
        )
        VALUES ($1, $2, $3, 'final_markdown', $4, $5, $6, true)
      `,
      [
        artifactId,
        job.id,
        accountId,
        safeText(sourcePacketDigest || row.source_packet_digest || job.sourcePacketDigest || "", 100),
        finalMarkdown,
        finalMetadata,
      ]
    );

    const jobUpdate = await client.query(
      `
        UPDATE context_rewrite_jobs
        SET
          status = 'completed',
          current_stage = 'completed',
          actual_cost_usd = actual_cost_usd + $4,
          aggregate_score_json = $5,
          final_artifact_id = $2,
          final_markdown = $3,
          final_metadata_json = $6,
          progress_json = $7,
          completed_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now()
        WHERE id = $1
          AND status = 'running'
        RETURNING *
      `,
      [
        job.id,
        artifactId,
        finalMarkdown,
        numeric(addCostUsd),
        jsonValue(aggregateScore),
        finalMetadata,
        completeProgress,
      ]
    );
    if (!jobUpdate.rows[0]) {
      throw contextRewriteStateError(row, job.id);
    }

    const assistantUpdate = await client.query(
      `
        UPDATE chat_messages
        SET
          body = $3,
          provider = $4,
          model = $5,
          response_id = $6,
          metadata_json = $7
        WHERE id = $1
          AND account_id = $2
        RETURNING *
      `,
      [
        assistantMessageId,
        accountId,
        "Context Rewrite is ready as a Markdown artifact.",
        finalMetadata.provider || null,
        finalMetadata.model || null,
        finalMetadata.responseId || null,
        {
          kind: "context_rewrite",
          contextRewrite: {
            jobId: job.id,
            status: "completed",
            stage: "completed",
            artifactId,
            filename,
            markdown: finalMarkdown,
            title: finalMetadata.title || "Context Rewrite",
            summary: finalMetadata.summary || "",
            actualCostUsd,
            progress: completeProgress,
            trace: safeArray(completeProgress.trace),
          },
          thinking: {
            state: "finished",
          },
        },
      ]
    );

    return {
      job: publicJob(jobUpdate.rows[0], { includeInternal: true }),
      assistant: publicMessage(assistantUpdate.rows[0]),
      artifact: {
        id: artifactId,
        filename,
        markdown: finalMarkdown,
        metadata: finalMetadata,
      },
    };
  });
}

export async function failContextRewriteJob({ job = {}, error = null, stage = "" } = {}) {
  if (!useDatabase()) return null;
  const message = safeText(error?.message || error || "context_rewrite_failed", 1000);
  const failedStage = stage || job.currentStage || "failed";
  const lockedBy = expectedLockedBy(job);
  return transaction(async (client) => {
    const existing = await client.query(
      "SELECT * FROM context_rewrite_jobs WHERE id = $1 FOR UPDATE",
      [safeText(job.id, 180)]
    );
    const row = existing.rows[0];
    if (!row) return null;
    if (terminalStatuses.has(row.status) || row.status !== "running") {
      return {
        skipped: true,
        job: publicJob(row, { includeInternal: true }),
        assistant: null,
      };
    }
    if (lockedBy && safeText(row.locked_by, 120) !== lockedBy) {
      return {
        skipped: true,
        job: publicJob(row, { includeInternal: true }),
        assistant: null,
      };
    }
    const failedProgress = buildContextRewriteProgress({
      existingProgress: jsonValue(row.progress_json),
      stage: failedStage,
      status: "failed",
      message,
      details: { error: message },
    });
    const jobUpdate = await client.query(
      `
        UPDATE context_rewrite_jobs
        SET
          status = 'failed',
          current_stage = $2,
          error = $3,
          progress_json = $4,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now()
        WHERE id = $1
          AND status = 'running'
        RETURNING *
      `,
      [
        job.id,
        safeText(failedStage, 80),
        message,
        failedProgress,
      ]
    );
    const assistantUpdate = await client.query(
      `
        UPDATE chat_messages
        SET body = $3,
            metadata_json = $4
        WHERE id = $1
          AND account_id = $2
        RETURNING *
      `,
      [
        row.assistant_message_id,
        row.account_id,
        "Context Rewrite failed before producing a Markdown artifact.",
        {
          kind: "context_rewrite",
          contextRewrite: {
            jobId: job.id,
            status: "failed",
            stage: failedStage,
            error: message,
            progress: failedProgress,
            trace: safeArray(failedProgress.trace),
          },
          thinking: {
            state: "stopped",
          },
        },
      ]
    );
    return {
      job: publicJob(jobUpdate.rows[0], { includeInternal: true }),
      assistant: publicMessage(assistantUpdate.rows[0]),
    };
  });
}

export async function cancelContextRewriteJob({ accountId = "", jobId = "" } = {}) {
  if (!useDatabase()) return null;
  return transaction(async (client) => {
    const existing = await client.query(
      `
        SELECT *
        FROM context_rewrite_jobs
        WHERE id = $1
          AND account_id = $2
        FOR UPDATE
      `,
      [safeText(jobId, 180), safeAccountId(accountId)]
    );
    const row = existing.rows[0];
    if (!row) return null;
    if (terminalStatuses.has(row.status)) return publicJob(row, { includeInternal: true });
    const cancelledProgress = buildContextRewriteProgress({
      existingProgress: jsonValue(row.progress_json),
      stage: row.current_stage || "cancelled",
      status: "cancelled",
      message: "Context Rewrite cancelled.",
    });
    const result = await client.query(
      `
        UPDATE context_rewrite_jobs
        SET status = 'cancelled',
            current_stage = 'cancelled',
            cancelled_at = now(),
            locked_at = NULL,
            locked_by = NULL,
            progress_json = $3,
            updated_at = now()
        WHERE id = $1
          AND account_id = $2
          AND status NOT IN ('completed', 'failed', 'cancelled')
        RETURNING *
      `,
      [row.id, safeAccountId(accountId), cancelledProgress]
    );
    if (!result.rows[0]) return publicJob(row, { includeInternal: true });
    await client.query(
      `
        UPDATE chat_messages
        SET body = $3,
            metadata_json = $4
        WHERE id = $1
          AND account_id = $2
      `,
      [
        row.assistant_message_id,
        row.account_id,
        pendingAssistantBody("cancelled", cancelledProgress),
        pendingMetadata({
          jobId: row.id,
          status: "cancelled",
          stage: "cancelled",
          estimateCostUsd: numeric(row.estimate_cost_usd),
          actualCostUsd: numeric(row.actual_cost_usd),
          progress: cancelledProgress,
        }),
      ]
    );
    return publicJob(result.rows[0], { includeInternal: true });
  });
}
