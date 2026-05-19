import { databaseEnabled, query } from "../db/pool.js";

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

function statusLabel(status = "") {
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

function requestLifecycle(row = {}, status = normalizeRequestStatus(row.status)) {
  const ageMs = requestAgeMs(row.updated_at || row.created_at);
  const generatedTaskId = safeText(row.generated_task_id, 180);
  const isFailedVisible = status === "failed" && ageMs < 24 * 60 * 60 * 1000;
  const isPublishedVisible = status === "published" && ageMs < 20 * 60 * 1000 && !generatedTaskId;
  const isActive = ["signing", "queued", "generating"].includes(status) || isPublishedVisible || isFailedVisible;
  const isStale = ["published", "queued", "generating"].includes(status) && ageMs > 2 * 60 * 1000 && !generatedTaskId;
  const isTerminal = ["proposed", "cancelled"].includes(status) || Boolean(generatedTaskId);

  return {
    isActive,
    isStale,
    isTerminal,
    canRetry: status === "failed" || isStale,
    displayUntil: isActive ? toIso(new Date(Date.now() + 20 * 60 * 1000)) : null,
  };
}

function publicTaskRequest(row = {}) {
  const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  const status = normalizeRequestStatus(row.status);
  const lifecycle = requestLifecycle(row, status);
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
    statusLabel: statusLabel(status),
    generatedTaskId: row.generated_task_id || "",
    workerAttemptCount: Number(row.worker_attempt_count || 0),
    workerClaimedAt: toIso(row.worker_claimed_at),
    workerCompletedAt: toIso(row.worker_completed_at),
    lastError: row.last_error || "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    ago: relativeAge(row.updated_at || row.created_at),
    ...lifecycle,
    metadata,
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

export async function upsertTaskRequest(request = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const requestId = safeText(request.requestId || request.request_id, 180);
  if (!requestId) throw new Error("task_request_id_required");
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {};
  const result = await query(
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
      ON CONFLICT (request_id)
      DO UPDATE SET
        account_id = COALESCE(NULLIF(EXCLUDED.account_id, ''), task_requests.account_id),
        subject_wallet = COALESCE(NULLIF(EXCLUDED.subject_wallet, ''), task_requests.subject_wallet),
        source = COALESCE(NULLIF(EXCLUDED.source, ''), task_requests.source),
        source_conversation_id = COALESCE(NULLIF(EXCLUDED.source_conversation_id, ''), task_requests.source_conversation_id),
        source_conversation_title = COALESCE(NULLIF(EXCLUDED.source_conversation_title, ''), task_requests.source_conversation_title),
        request_text = COALESCE(NULLIF(EXCLUDED.request_text, ''), task_requests.request_text),
        user_detail_text = COALESCE(NULLIF(EXCLUDED.user_detail_text, ''), task_requests.user_detail_text),
        requested_task_kind = COALESCE(NULLIF(EXCLUDED.requested_task_kind, ''), task_requests.requested_task_kind),
        request_bundle_cid = COALESCE(NULLIF(EXCLUDED.request_bundle_cid, ''), task_requests.request_bundle_cid),
        request_event_cid = COALESCE(NULLIF(EXCLUDED.request_event_cid, ''), task_requests.request_event_cid),
        request_tx_hash = COALESCE(NULLIF(EXCLUDED.request_tx_hash, ''), task_requests.request_tx_hash),
        bundle_id = COALESCE(NULLIF(EXCLUDED.bundle_id, ''), task_requests.bundle_id),
        status = EXCLUDED.status,
        generated_task_id = COALESCE(NULLIF(EXCLUDED.generated_task_id, ''), task_requests.generated_task_id),
        last_error = EXCLUDED.last_error,
        metadata_json = task_requests.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
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
  return { ok: true, request: publicTaskRequest(result.rows[0]) };
}

export async function claimTaskGenerationRequests({ limit = 1 } = {}) {
  if (!databaseEnabled()) return [];
  const result = await query(
    `
      WITH next_requests AS (
        SELECT request_id
        FROM task_requests
        WHERE status IN ('published', 'queued')
          AND request_bundle_cid <> ''
        ORDER BY updated_at ASC, created_at ASC, request_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE task_requests tr
      SET
        status = 'generating',
        worker_claimed_at = now(),
        worker_completed_at = NULL,
        worker_attempt_count = tr.worker_attempt_count + 1,
        last_error = '',
        updated_at = now()
      FROM next_requests
      WHERE tr.request_id = next_requests.request_id
      RETURNING tr.*
    `,
    [Math.min(Math.max(Number(limit || 1), 1), 10)]
  );
  return result.rows.map(publicTaskRequest);
}

export async function markTaskRequestProposed({
  requestId = "",
  generatedTaskId = "",
  subjectWallet = "",
  metadata = {},
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE task_requests
      SET
        subject_wallet = COALESCE(NULLIF($2, ''), subject_wallet),
        generated_task_id = $3,
        status = 'proposed',
        worker_completed_at = now(),
        last_error = '',
        metadata_json = metadata_json || $4::jsonb,
        updated_at = now()
      WHERE request_id = $1
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
    ]
  );
  return { ok: true, request: publicTaskRequest(result.rows[0]) };
}

export async function markTaskRequestFailed({ requestId = "", error = "", metadata = {} } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE task_requests
      SET
        status = 'failed',
        worker_completed_at = now(),
        last_error = $2,
        metadata_json = metadata_json || $3::jsonb,
        updated_at = now()
      WHERE request_id = $1
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
    ]
  );
  return { ok: true, request: publicTaskRequest(result.rows[0]) };
}

export async function listTaskRequests({ accountId = "", walletAddress = "", limit = 40 } = {}) {
  const linked = Boolean(safeText(walletAddress, 120));
  if (!linked) return emptyTaskRequestState({ walletLinked: false });
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

  const result = await query(
    `
      SELECT tr.*
      FROM task_requests tr
      WHERE ($1::text = '' OR tr.account_id = $1)
        AND (
          tr.subject_wallet = $2
          OR tr.subject_wallet = ''
        )
      ORDER BY tr.updated_at DESC, tr.created_at DESC, tr.request_id DESC
      LIMIT $3
    `,
    [safeText(accountId, 180), safeText(walletAddress, 120), Math.min(Math.max(Number(limit || 40), 1), 100)]
  );
  const items = result.rows.map(publicTaskRequest);
  return {
    items,
    sync: {
      source: "task_requests",
      status: items.length ? "ready" : "empty",
      walletAddress,
      requestCount: items.length,
      lastUpdatedAt: items[0]?.updatedAt || null,
    },
  };
}
