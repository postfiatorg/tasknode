const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

export function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

export function jsonValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

export function preview(value = "") {
  return safeText(value, 180).replace(/\s+/g, " ");
}

export function filenameForJob(jobId = "") {
  const date = new Date().toISOString().slice(0, 10);
  return `context-rewrite-${date}-${safeText(jobId, 30) || "artifact"}.md`;
}

export function staleRunningMinutes() {
  const parsed = Number(process.env.CONTEXT_REWRITE_RUNNING_STALE_MINUTES || 60);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : 60, 30), 24 * 60);
}

export function staleRunningMs() {
  return staleRunningMinutes() * 60 * 1000;
}

export function retryBudgetLimit(estimateCostUsd = 0) {
  const configured = Number(process.env.CONTEXT_REWRITE_MAX_COST_USD || 0);
  if (Number.isFinite(configured) && configured > 0) return numeric(configured);
  return numeric(estimateCostUsd);
}

export function ageMs(value, nowMs = Date.now()) {
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

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function eventStatusForStage({ stage = "", status = "running" } = {}) {
  if (status === "completed" || stage === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "running";
}

export function buildContextRewriteProgress({
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

export function publicMessage(row = null) {
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

export function publicJob(row = null, { includeMarkdown = true, includeInternal = false } = {}) {
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

export function pendingAssistantBody(stage = "queued", progress = {}) {
  const message = progressMessage(progress);
  if (message) return message;
  if (stage === "queued") return "Context Rewrite is queued. This can take a while; check back in this tab.";
  if (stage === "completed") return "Context Rewrite is ready as a Markdown artifact.";
  if (stage === "cancelled") return "Context Rewrite cancelled.";
  return "Context Rewrite is running. This can take a while; check back in this tab.";
}

export function pendingMetadata({
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
