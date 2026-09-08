import { databaseEnabled, query } from "../db/pool.js";
import { randomUUID } from "node:crypto";
import { taskRequestConflict, taskRequestIntentDigest } from "../task-request-command.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function normalizeRequestStatus(status = "") {
  const normalized = safeText(status, 80).toLowerCase();
  if (normalized === "pftl_request_published") return "published";
  if ([
    "signing",
    "published",
    "queued",
    "generating",
    "proposed",
    "failed",
    "cancelled",
  ].includes(normalized)) {
    return normalized;
  }
  return "published";
}

function statusLabel(status = "", { operatorAuditOnly = false } = {}) {
  if (operatorAuditOnly) return "Closed";
  return {
    signing: "Signing",
    published: "Queued for generation",
    queued: "Queued",
    generating: "Generating task",
    proposed: "Task proposed",
    failed: "Needs attention",
    cancelled: "Cancelled",
  }[normalizeRequestStatus(status)] || "Published to PFT";
}

function relativeAge(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function requestAgeMs(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function isOperatorAuditOnlyTaskRequest(row = {}) {
  const metadata = safeObject(row.metadata || row.metadata_json);
  const repair = safeObject(metadata.operator_repair || metadata.operatorRepair);
  return repair.action === "fail_network_task_generation_chain" ||
    repair.public_visibility === "hidden" ||
    repair.user_visible === false ||
    repair.user_visible === "false";
}

function publicMetadata(metadata = {}, { operatorAuditOnly = false } = {}) {
  if (!operatorAuditOnly) return metadata;
  const rest = { ...metadata };
  delete rest.operator_repair;
  delete rest.operatorRepair;
  delete rest.last_error;
  return rest;
}

function requestLifecycle(row = {}, status = normalizeRequestStatus(row.status), metadata = {}) {
  if (isOperatorAuditOnlyTaskRequest({ ...row, metadata })) {
    return {
      isActive: false,
      isProcessing: false,
      needsAttention: false,
      isStale: false,
      isTerminal: true,
      canRetry: false,
      canDismiss: false,
      displayUntil: null,
    };
  }
  const ageMs = requestAgeMs(row.updated_at || row.created_at);
  const generatedTaskId = safeText(row.generated_task_id, 180);
  const hasGeneratedTask = Boolean(generatedTaskId);
  const isFailedVisible = !hasGeneratedTask && status === "failed";
  const isPublishedVisible = !hasGeneratedTask && status === "published";
  const isProcessing = !hasGeneratedTask && (["signing", "queued", "generating"].includes(status) || isPublishedVisible);
  const isActive = isProcessing || isFailedVisible;
  const isStale = ["published", "queued", "generating"].includes(status) && ageMs > 2 * 60 * 1000 && !generatedTaskId;
  const isTerminal = ["proposed", "cancelled"].includes(status) || Boolean(generatedTaskId);

  return {
    isActive,
    isProcessing,
    needsAttention: isFailedVisible,
    isStale,
    isTerminal,
    canRetry: !hasGeneratedTask && status === "failed",
    canDismiss: !hasGeneratedTask && status === "failed",
    displayUntil: null,
  };
}

export function publicTaskRequest(row = {}) {
  const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  const operatorAuditOnly = isOperatorAuditOnlyTaskRequest({ ...row, metadata });
  const status = normalizeRequestStatus(row.status);
  const lifecycle = requestLifecycle(row, status, metadata);
  return {
    requestId: row.request_id || "",
    bundleId: row.bundle_id || "",
    accountId: row.account_id || "",
    subjectWallet: row.subject_wallet || "",
    source: row.source || "task_interface",
    sourceConversationId: row.source_conversation_id || "",
    sourceConversationTitle: row.source_conversation_title || "",
    requestText: row.request_text || "",
    userDetailText: row.user_detail_text || "",
    requestedTaskKind: row.requested_task_kind || "personal",
    requestBundleCid: row.request_bundle_cid || "",
    requestEventCid: row.request_event_cid || "",
    requestTxHash: row.request_tx_hash || "",
    status,
    progressStage: metadata.workerHeartbeat?.stage || status,
    progressRevision: toIso(row.updated_at),
    statusLabel: metadata.requestDismissal && status === "cancelled" ? "Dismissed" : statusLabel(status, { operatorAuditOnly }),
    generatedTaskId: row.generated_task_id || "",
    workerId: row.worker_id || "",
    workerAttemptId: row.worker_attempt_id || "",
    workerAttemptCount: Number(row.worker_attempt_count || 0),
    workerClaimedAt: toIso(row.worker_claimed_at),
    workerHeartbeatAt: toIso(row.worker_heartbeat_at),
    workerCompletedAt: toIso(row.worker_completed_at),
    workerRetryAfter: toIso(row.worker_retry_after),
    lastError: operatorAuditOnly ? "" : row.last_error || "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    ago: relativeAge(row.updated_at || row.created_at),
    ...lifecycle,
    metadata: publicMetadata(metadata, { operatorAuditOnly }),
  };
}

export function emptyTaskRequestState({ walletLinked = false, walletAddress = "" } = {}) {
  return {
    items: [],
    sync: {
      source: "task_requests",
      status: walletLinked ? "empty" : "wallet_required",
      walletAddress: walletAddress || null,
      requestCount: 0,
      lastUpdatedAt: null,
    },
  };
}

export async function upsertTaskRequest(request = {}, { queryImpl = query } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const requestId = safeText(request.requestId || request.request_id, 180);
  if (!requestId) throw new Error("task_request_id_required");
  const metadata = { ...(request.metadata && typeof request.metadata === "object" ? request.metadata : {}), requestIntentDigest: taskRequestIntentDigest(request) };
  const result = await queryImpl(
    `
      INSERT INTO task_requests (
        request_id,
        account_id,
        subject_wallet,
        source,
        source_conversation_id,
        source_conversation_title,
        request_text,
        user_detail_text,
        requested_task_kind,
        request_bundle_cid,
        request_event_cid,
        request_tx_hash,
        bundle_id,
        status,
        generated_task_id,
        last_error,
        metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15,
        $16, $17::jsonb
      )
      ON CONFLICT (request_id) DO NOTHING
      RETURNING *
    `,
    [
      requestId,
      safeText(request.accountId || request.account_id, 180),
      safeText(request.subjectWallet || request.subject_wallet, 120),
      safeText(request.source || "task_interface", 80) || "task_interface",
      safeText(request.sourceConversationId || request.source_conversation_id || request.conversationId, 180),
      safeText(request.sourceConversationTitle || request.source_conversation_title, 180),
      safeText(request.requestText || request.request_text, 8000),
      safeText(request.userDetailText || request.user_detail_text, 8000),
      safeText(request.requestedTaskKind || request.requested_task_kind || "personal", 80) || "personal",
      safeText(request.requestBundleCid || request.request_bundle_cid, 240),
      safeText(request.requestEventCid || request.request_event_cid || request.cid, 240),
      safeText(request.requestTxHash || request.request_tx_hash || request.txHash, 160),
      safeText(request.bundleId || request.bundle_id, 180),
      normalizeRequestStatus(request.status),
      safeText(request.generatedTaskId || request.generated_task_id, 180),
      safeText(request.lastError || request.last_error, 1000),
      JSON.stringify(metadata),
    ]
  );
  if (result.rows[0]) return { ok: true, replayed: false, request: publicTaskRequest(result.rows[0]) };
  const existing = await queryImpl("SELECT * FROM task_requests WHERE request_id = $1", [requestId]);
  const row = existing.rows[0];
  const digest = row?.metadata_json?.requestIntentDigest || taskRequestIntentDigest(row);
  if (!row || row.account_id !== safeText(request.accountId || request.account_id, 180) ||
      row.subject_wallet !== safeText(request.subjectWallet || request.subject_wallet, 120) ||
      digest !== metadata.requestIntentDigest) throw taskRequestConflict();
  return { ok: true, replayed: true, request: publicTaskRequest(row) };
}

export async function getOwnedTaskRequest({ requestId = "", accountId = "" } = {}) {
  if (!databaseEnabled() || !accountId || !requestId) return null;
  const result = await query("SELECT * FROM task_requests WHERE request_id = $1 AND account_id = $2", [
    safeText(requestId, 180), safeText(accountId, 180),
  ]);
  const row = result.rows[0];
  return row && !isOperatorAuditOnlyTaskRequest(row) ? publicTaskRequest(row) : null;
}

export async function saveTaskRequestContext({ request, bundle } = {}) {
  const result = await query(`
    UPDATE task_requests
    SET metadata_json = metadata_json || jsonb_build_object(
      'requestBundle', $4::jsonb, 'contextEnrichmentPending', false,
      'contextEnrichedAt', now()), updated_at = now()
    WHERE request_id = $1 AND account_id = $2 AND worker_attempt_id = $3
      AND status = 'generating'
      AND metadata_json->>'contextEnrichmentPending' = 'true'
    RETURNING *
  `, [request.requestId, request.accountId, request.workerAttemptId, JSON.stringify(bundle)]);
  if (!result.rows[0]) throw Object.assign(new Error("task_generation_attempt_lost"), { staleAttempt: true });
  return publicTaskRequest(result.rows[0]);
}

export async function getTaskRequestByRequestId(requestId = "") {
  if (!databaseEnabled()) return null;
  const normalizedRequestId = safeText(requestId, 180);
  if (!normalizedRequestId) return null;
  const result = await query("SELECT * FROM task_requests WHERE request_id = $1", [normalizedRequestId]);
  return result.rows[0] ? publicTaskRequest(result.rows[0]) : null;
}

export async function reclaimStaleTaskGenerationRequests({
  maxAttempts = 3,
  staleSeconds = 900,
  limit = 25,
} = {}) {
  if (!databaseEnabled()) return { retried: [], failed: [] };
  const safeMaxAttempts = positiveInteger(maxAttempts, 3, { min: 1, max: 25 });
  const safeStaleSeconds = positiveInteger(staleSeconds, 900, { min: 5, max: 86_400 });
  const safeLimit = positiveInteger(limit, 25, { min: 1, max: 100 });
  const stalePredicate = `
    status = 'generating'
    AND generated_task_id = ''
    AND COALESCE(worker_heartbeat_at, worker_claimed_at, updated_at, created_at) < now() - ($2::text || ' seconds')::interval
  `;
  const retryResult = await query(
    `
      WITH stale AS (
        SELECT request_id
        FROM task_requests
        WHERE ${stalePredicate}
          AND worker_attempt_count < $1
        ORDER BY COALESCE(worker_heartbeat_at, worker_claimed_at, updated_at, created_at) ASC, request_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      )
      UPDATE task_requests tr
      SET
        status = 'queued',
        worker_id = '',
        worker_attempt_id = '',
        worker_claimed_at = NULL,
        worker_heartbeat_at = NULL,
        worker_retry_after = NULL,
        last_error = 'task_generation_stale_reclaimed_for_retry',
        metadata_json = metadata_json || jsonb_build_object(
          'lastStaleReclaimAt', now(),
          'lastStaleReclaimAction', 'retry',
          'lastStaleReclaimMaxAttempts', $1,
          'lastStaleReclaimStaleSeconds', $2
        ),
        updated_at = now()
      FROM stale
      WHERE tr.request_id = stale.request_id
      RETURNING tr.*
    `,
    [safeMaxAttempts, safeStaleSeconds, safeLimit]
  );
  const remainingLimit = Math.max(0, safeLimit - retryResult.rows.length);
  const failResult = remainingLimit > 0
    ? await query(
      `
        WITH stale AS (
          SELECT request_id
          FROM task_requests
          WHERE ${stalePredicate}
            AND worker_attempt_count >= $1
          ORDER BY COALESCE(worker_heartbeat_at, worker_claimed_at, updated_at, created_at) ASC, request_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        UPDATE task_requests tr
        SET
          status = 'failed',
          worker_completed_at = now(),
          worker_id = '',
          worker_attempt_id = '',
          worker_heartbeat_at = NULL,
          worker_retry_after = NULL,
          last_error = 'task_generation_stale_attempts_exhausted',
          metadata_json = metadata_json || jsonb_build_object(
            'lastStaleReclaimAt', now(),
            'lastStaleReclaimAction', 'failed',
            'lastStaleReclaimMaxAttempts', $1,
            'lastStaleReclaimStaleSeconds', $2
          ),
          updated_at = now()
        FROM stale
        WHERE tr.request_id = stale.request_id
        RETURNING tr.*
      `,
      [safeMaxAttempts, safeStaleSeconds, remainingLimit]
    )
    : { rows: [] };
  return {
    retried: retryResult.rows.map(publicTaskRequest),
    failed: failResult.rows.map(publicTaskRequest),
  };
}

export async function claimTaskGenerationRequests({
  limit = 1,
  workerId = "",
  maxAttempts = 3,
} = {}) {
  if (!databaseEnabled()) return [];
  const normalizedWorkerId = safeText(workerId, 180) || `taskgen_worker_${process.pid || "unknown"}`;
  const safeMaxAttempts = positiveInteger(maxAttempts, 3, { min: 1, max: 25 });
  const result = await query(
    `
      WITH next_requests AS (
        SELECT request_id
        FROM task_requests
        WHERE status IN ('published', 'queued')
          AND request_bundle_cid <> ''
          AND generated_task_id = ''
          AND worker_attempt_count < $2
          AND (worker_retry_after IS NULL OR worker_retry_after <= now())
        ORDER BY updated_at ASC, created_at ASC, request_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE task_requests tr
      SET
        status = 'generating',
        worker_id = $3,
        worker_attempt_id = $4,
        worker_claimed_at = now(),
        worker_heartbeat_at = now(),
        worker_completed_at = NULL,
        worker_retry_after = NULL,
        worker_attempt_count = tr.worker_attempt_count + 1,
        last_error = '',
        updated_at = now()
      FROM next_requests
      WHERE tr.request_id = next_requests.request_id
      RETURNING tr.*
    `,
    [
      Math.min(Math.max(Number(limit || 1), 1), 10),
      safeMaxAttempts,
      normalizedWorkerId,
      `taskgen_attempt_${randomUUID().replaceAll("-", "")}`,
    ]
  );
  return result.rows.map(publicTaskRequest);
}

export async function heartbeatTaskGenerationRequest({
  requestId = "",
  workerAttemptId = "",
  workerId = "",
  stage = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const metadata = stage
    ? jsonbStageMetadata({ stage, workerId })
    : "{}";
  const result = await query(
    `
      UPDATE task_requests
      SET
        worker_heartbeat_at = now(),
        metadata_json = metadata_json || $4::jsonb,
        updated_at = now()
      WHERE request_id = $1
        AND status IN ('generating', 'proposed')
        AND worker_attempt_id = $2
        AND ($3::text = '' OR worker_id = $3)
      RETURNING *
    `,
    [
      safeText(requestId, 180),
      safeText(workerAttemptId, 180),
      safeText(workerId, 180),
      metadata,
    ]
  );
  return result.rows[0]
    ? { ok: true, request: publicTaskRequest(result.rows[0]) }
    : { ok: false, stale: true, reason: "task_generation_attempt_not_owner" };
}

function jsonbStageMetadata({ stage = "", workerId = "" } = {}) {
  return JSON.stringify({
    workerHeartbeat: {
      stage: safeText(stage, 120),
      workerId: safeText(workerId, 180),
      at: new Date().toISOString(),
    },
  });
}

export async function markTaskRequestProposed({
  requestId = "",
  generatedTaskId = "",
  subjectWallet = "",
  metadata = {},
  workerAttemptId = "",
  workerId = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const attemptGuard = safeText(workerAttemptId, 180);
  const workerGuard = safeText(workerId, 180);
  const result = await query(
    `
      UPDATE task_requests
      SET
        subject_wallet = COALESCE(NULLIF($2, ''), subject_wallet),
        generated_task_id = $3,
        status = 'proposed',
        worker_completed_at = now(),
        worker_heartbeat_at = now(),
        last_error = '',
        metadata_json = metadata_json || $4::jsonb,
        updated_at = now()
      WHERE request_id = $1
        AND (
          $5::text = ''
          OR (
            (status = 'generating' OR (status = 'proposed' AND generated_task_id = $3))
            AND worker_attempt_id = $5
            AND ($6::text = '' OR worker_id = $6)
          )
        )
      RETURNING *
    `,
    [
      safeText(requestId, 180),
      safeText(subjectWallet, 120),
      safeText(generatedTaskId, 180),
      JSON.stringify({
        workerResult: metadata,
        workerCompletedAt: new Date().toISOString(),
      }),
      attemptGuard,
      workerGuard,
    ]
  );
  return result.rows[0]
    ? { ok: true, request: publicTaskRequest(result.rows[0]) }
    : { ok: false, stale: Boolean(attemptGuard), reason: "task_request_not_owned_by_attempt" };
}

export async function markTaskRequestFailed({
  requestId = "",
  error = "",
  metadata = {},
  workerAttemptId = "",
  workerId = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const attemptGuard = safeText(workerAttemptId, 180);
  const workerGuard = safeText(workerId, 180);
  const result = await query(
    `
      UPDATE task_requests
      SET
        status = 'failed',
        worker_completed_at = now(),
        worker_heartbeat_at = now(),
        worker_retry_after = NULL,
        last_error = $2,
        metadata_json = metadata_json || $3::jsonb,
        updated_at = now()
      WHERE request_id = $1
        AND (
          $4::text = ''
          OR (
            status = 'generating'
            AND worker_attempt_id = $4
            AND ($5::text = '' OR worker_id = $5)
          )
        )
      RETURNING *
    `,
    [
      safeText(requestId, 180),
      safeText(error, 1000),
      JSON.stringify({
        workerError: safeText(error, 1000),
        workerFailedAt: new Date().toISOString(),
        ...metadata,
      }),
      attemptGuard,
      workerGuard,
    ]
  );
  return result.rows[0]
    ? { ok: true, request: publicTaskRequest(result.rows[0]) }
    : { ok: false, stale: Boolean(attemptGuard), reason: "task_request_not_owned_by_attempt" };
}

export async function retryTaskGenerationRequest({
  requestId = "",
  error = "",
  retryDelayMs = 0,
  metadata = {},
  workerAttemptId = "",
  workerId = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const attemptGuard = safeText(workerAttemptId, 180);
  const workerGuard = safeText(workerId, 180);
  if (!attemptGuard) return { ok: false, reason: "task_generation_attempt_required" };
  const safeRetryDelayMs = positiveInteger(retryDelayMs, 15_000, { min: 1_000, max: 15 * 60 * 1000 });
  const result = await query(
    `
      UPDATE task_requests
      SET
        status = 'queued',
        worker_id = '',
        worker_attempt_id = '',
        worker_claimed_at = NULL,
        worker_heartbeat_at = NULL,
        worker_completed_at = NULL,
        worker_retry_after = now() + ($3::text || ' milliseconds')::interval,
        last_error = $2,
        metadata_json = metadata_json || $4::jsonb,
        updated_at = now()
      WHERE request_id = $1
        AND status = 'generating'
        AND worker_attempt_id = $5
        AND ($6::text = '' OR worker_id = $6)
      RETURNING *
    `,
    [
      safeText(requestId, 180),
      safeText(error, 1000),
      safeRetryDelayMs,
      JSON.stringify({
        workerRetry: {
          error: safeText(error, 1000),
          delayMs: safeRetryDelayMs,
          scheduledAt: new Date().toISOString(),
        },
        ...metadata,
      }),
      attemptGuard,
      workerGuard,
    ]
  );
  return result.rows[0]
    ? { ok: true, request: publicTaskRequest(result.rows[0]) }
    : { ok: false, stale: true, reason: "task_request_not_owned_by_attempt" };
}

export async function dismissOwnedTaskRequest({ accountId, requestId, expectedAttemptCount, reason = "Dismissed by the request owner." }) {
  if (!accountId || !requestId || !Number.isInteger(expectedAttemptCount) || expectedAttemptCount < 0) {
    throw Object.assign(new Error("task_request_dismiss_invalid"), { status: 400 });
  }
  const result = await query(`UPDATE task_requests SET status='cancelled',updated_at=now(),
    metadata_json=metadata_json || jsonb_build_object('requestDismissal',jsonb_build_object(
      'accountId',$2::text,'at',now(),'attemptCount',$3::integer,'reason',$4::text))
    WHERE request_id=$1 AND account_id=$2 AND status='failed' AND COALESCE(generated_task_id,'')=''
      AND worker_attempt_count=$3 RETURNING *`, [requestId, accountId, expectedAttemptCount, safeText(reason, 1000)]);
  if (result.rows[0]) return publicTaskRequest(result.rows[0]);
  const existing = await getOwnedTaskRequest({ accountId, requestId });
  if (!existing) throw Object.assign(new Error("task_request_not_found"), { status: 404 });
  // Replays preserve the receipt; a stale click cannot dismiss a newer attempt
  // or a request that already generated a task.
  return existing;
}

export async function retryOwnedTaskRequest({ accountId, requestId, expectedAttemptCount }) {
  if (!accountId || !requestId || !Number.isInteger(expectedAttemptCount) || expectedAttemptCount < 0) {
    throw Object.assign(new Error("task_request_retry_invalid"), { status: 400 });
  }
  const result = await query(`UPDATE task_requests SET status='queued',worker_id='',worker_attempt_id='',
    worker_claimed_at=NULL,worker_heartbeat_at=NULL,worker_completed_at=NULL,worker_retry_after=now(),
    last_error='',updated_at=now(),metadata_json=metadata_json || jsonb_build_object('manualRetryAt',now())
    WHERE request_id=$1 AND account_id=$2 AND status='failed' AND coalesce(generated_task_id,'')=''
      AND worker_attempt_count=$3 RETURNING *`, [requestId, accountId, expectedAttemptCount]);
  if (result.rows[0]) return publicTaskRequest(result.rows[0]);
  const existing = await getOwnedTaskRequest({ accountId, requestId });
  if (!existing) throw Object.assign(new Error("task_request_not_found"), { status: 404 });
  // The original attempt number prevents an old retry from restarting a newer
  // failure. Repeated delivery after a successful enqueue simply returns it.
  return existing;
}

export async function listTaskRequests({ accountId = "", walletAddress = "", limit = 40, cursor = "" } = {}) {
  const linked = Boolean(safeText(walletAddress, 120));
  if (!linked && !accountId) return emptyTaskRequestState({ walletLinked: false });
  if (!databaseEnabled()) {
    return {
      ...emptyTaskRequestState({ walletLinked: true, walletAddress }),
      sync: {
        source: "task_requests",
        status: "database_not_configured",
        walletAddress,
        requestCount: 0,
        lastUpdatedAt: null,
      },
    };
  }

  let after = null;
  if (cursor) {
    try {
      after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (![0, 1].includes(after.active) || typeof after.id !== "string" || after.id.length > 180 ||
          typeof after.createdAt !== "string" || !Number.isFinite(Date.parse(after.createdAt))) throw new Error("invalid_cursor");
    } catch {
      throw Object.assign(new Error("Task request page cursor is invalid."), { status: 400, code: "task_request_cursor_invalid" });
    }
  }
  const pageSize = Math.min(Math.max(Number(limit || 40), 1), 100);
  const activeRank = "CASE WHEN tr.generated_task_id='' AND tr.status IN ('signing','published','queued','generating','failed') THEN 1 ELSE 0 END";
  const result = await query(
    `
      SELECT tr.*, tr.created_at::text AS cursor_created_at, ${activeRank} AS cursor_active
      FROM task_requests tr
      WHERE (($1::text <> '' AND tr.account_id = $1) OR ($1::text = '' AND tr.subject_wallet = $2))
        AND ($4::text = '' OR (${activeRank}, tr.created_at, tr.request_id) < ($5::integer, NULLIF($4, '')::timestamptz, $6::text))
        AND NOT (
          COALESCE(tr.metadata_json->'operator_repair'->>'action', '') = 'fail_network_task_generation_chain'
          OR COALESCE(tr.metadata_json->'operator_repair'->>'public_visibility', '') = 'hidden'
          OR COALESCE(tr.metadata_json->'operator_repair'->>'user_visible', '') = 'false'
        )
      ORDER BY ${activeRank} DESC, tr.created_at DESC, tr.request_id DESC
      LIMIT $3
    `,
    [safeText(accountId, 180), safeText(walletAddress, 120), pageSize + 1, after?.createdAt || "", after?.active || 0, after?.id || ""]
  );
  const page = result.rows.slice(0, pageSize);
  const items = page.map(publicTaskRequest);
  const last = page.at(-1);
  const nextCursor = result.rows.length > pageSize && last ? Buffer.from(JSON.stringify({
    active: last.cursor_active, createdAt: last.cursor_created_at, id: last.request_id,
  })).toString("base64url") : null;
  return {
    items,
    nextCursor,
    sync: {
      source: "task_requests",
      status: items.length ? "ready" : "empty",
      walletAddress,
      requestCount: items.length,
      lastUpdatedAt: items.reduce((latest, item) => item.updatedAt && (!latest || item.updatedAt > latest) ? item.updatedAt : latest, null),
    },
  };
}
