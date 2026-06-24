import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { canonicalReceiptProjection } from "../task-receipt-projection.js";
import { taskEventExpectation } from "../task-event-meaning.js";
import {
  dedupeAuditEntries,
  eventCidEntries,
  eventTransactionEntries,
  hydrateForensicsEvent,
  publicCidEntries,
  publicPointerEvent,
  publicReducerEvent,
  publicTransactionEntries,
} from "../task-forensics-format.js";
import { taskProductConfig } from "../task-product-config.js";
import { taskRewardOutcome } from "../task-reward-outcome.js";
import { currentVerificationRequest } from "../task-verification-view.js";
import { getNetworkTaskEligibility, syncNetworkTaskProjection } from "./network-tasks.js";
import { enqueueNetworkTaskProfileForRewardThreshold } from "./network-task-profile.js";
import { emptyTaskRequestState, listTaskRequests } from "./task-requests.js";
import { normalizeTaskStatus, taskLifecycleActions, taskRefreshMetadata, taskStatusInfo, taskStatusLabel, taskStatusTab } from "../../shared/task-lifecycle.js";
import { formatTaskDeadline, formatTaskTimestamp } from "../../shared/task-time-format.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function hasNumericValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function titleCase(value = "") {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function objectKeyCount(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
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

function maxIso(values = []) {
  const timestamps = values
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function emptyTaskState({ walletLinked = false, walletAddress = "" } = {}) {
  return {
    ...taskProductConfig(),
    requests: emptyTaskRequestState({ walletLinked, walletAddress }),
    outstanding: [], verification: [], refused: [], rewarded: [],
    sync: {
      source: "task_projections",
      status: walletLinked ? "empty" : "wallet_required",
      walletAddress: walletAddress || null,
      projectionCount: 0, lastSyncedAt: null, requiresRefresh: false, nextPollMs: null,
      refreshReason: "", activeRequestCount: 0, refreshTaskIds: [],
    },
  };
}

// Only processing requests (signing/queued/generating/recently published) count
// toward refresh pressure. Failed requests are attention states: they stay
// visible in the request strip, but no projection refresh can resolve them.
function refreshActiveRequestCount(requests = {}) {
  return Array.isArray(requests?.items)
    ? requests.items.filter((request) => request?.isProcessing).length
    : 0;
}

function taskProjectionReadErrorState({
  error,
  networkTasks,
  requests,
  walletAddress = "",
} = {}) {
  return {
    ...emptyTaskState({ walletLinked: true, walletAddress }),
    networkTasks,
    requests,
    sync: {
      source: "task_projections",
      status: "database_error",
      walletAddress,
      projectionCount: 0,
      lastSyncedAt: null,
      requiresRefresh: true,
      // A forced sync/reduce write pass against a failing database is the
      // wrong remediation; the client polls with backoff instead.
      forceProjectionRefresh: false,
      nextPollMs: 5000,
      refreshReason: "task_projection_read_failed",
      activeRequestCount: refreshActiveRequestCount(requests),
      refreshTaskIds: [],
      error: safeText(error?.message || error, 500),
    },
  };
}

function emptyTaskReadIntegrity({ error = "" } = {}) {
  return {
    byTaskId: new Map(),
    totals: {
      pendingReducerCount: 0,
      processingReducerCount: 0,
      failedReducerCount: 0,
      indexingLagCount: 0,
      integrityUnavailable: Boolean(error),
      error: safeText(error, 500),
    },
  };
}

function taskSteps(row, generatedTask = {}) {
  const generatedSteps = Array.isArray(generatedTask.steps)
    ? generatedTask.steps.map((step) => safeText(step, 1000)).filter(Boolean).slice(0, 5)
    : [];
  if (generatedSteps.length) return generatedSteps;
  const requirement = safeText(row.submission_requirement_text || "", 2000);
  if (!requirement) return [];
  return [requirement];
}

function publicTask(row) {
  const rewardActual = numeric(row.reward_actual_pft);
  const rewardOffer = numeric(row.reward_offer_pft);
  const actualRewardRecorded = hasNumericValue(row.reward_actual_pft);
  const statusKey = normalizeTaskStatus(row.status);
  const statusInfo = taskStatusInfo(statusKey);
  const pft = statusKey === "rewarded" && actualRewardRecorded ? rewardActual : rewardOffer;
  const metadata = safeObject(row.metadata_json);
  const generatedTask = safeObject(metadata.generatedTask);
  const networkTask = safeObject(generatedTask.network_task);
  const taskClass = safeText(generatedTask.task_class || networkTask.task_class, 80);
  const isNetworkTask = taskClass === "network" || taskClass === "alpha" || objectKeyCount(networkTask) > 0;
  const taskKindLabel = taskClass === "alpha" ? "Alpha" : isNetworkTask ? "Network" : "Personal";
  const verification = safeObject(row.verification_policy_json);
  const acceptBy = toIso(row.accept_by);
  const deadlineAt = toIso(row.deadline_at);
  const acceptWindowApplies = statusKey === "proposed" && Boolean(acceptBy);
  const dueAt = deadlineAt || (acceptWindowApplies ? acceptBy : null);
  const formattedDue = formatTaskDeadline(dueAt, { locale: "en-US" });
  const dueLabel = deadlineAt ? "Deadline" : acceptWindowApplies ? "Accept by" : "Deadline";

  return {
    id: String(row.task_id || "").slice(0, 12),
    fullId: row.task_id,
    taskId: row.task_id,
    title: row.title || "Untitled task",
    kind: taskKindLabel,
    originalKind: titleCase(row.task_kind || "task"),
    taskClass,
    isNetworkTask,
    status: taskStatusLabel(statusKey),
    statusKey,
    statusTone: statusInfo.tone,
    statusColor: statusInfo.color,
    statusTab: statusInfo.tab,
    lifecycle: statusInfo,
    due: formattedDue,
    fullDue: formattedDue,
    dueLabel,
    dueAt,
    acceptBy,
    deadlineAt,
    ago: relativeAge(row.updated_at || row.last_event_at),
    pft,
    description: row.description || "",
    steps: taskSteps(row, generatedTask),
    verification: {
      title: row.submission_type ? `Submit ${titleCase(row.submission_type)}` : "Submit evidence",
      body:
        row.submission_requirement_text ||
        verification.criteria ||
        generatedTask?.submission_requirement?.criteria ||
        "Submit evidence that satisfies the task requirement.",
      policy: verification,
    },
    submissionRequirement: {
      type: row.submission_type || generatedTask?.submission_requirement?.type || "",
      criteria:
        row.submission_requirement_text ||
        generatedTask?.submission_requirement?.criteria ||
        generatedTask?.submission_requirement?.description ||
        "",
    },
    verificationPolicy: verification,
    submissionType: row.submission_type || generatedTask?.submission_requirement?.type || "",
    requestBundleCid: row.request_bundle_cid || "",
    contextCid: row.context_cid || "",
    txHash: row.last_event_tx_hash || "",
    source: row.source || "pftl_replay",
    updatedAt: toIso(row.updated_at),
    updatedAtDisplay: formatTaskTimestamp(row.updated_at, { locale: "en-US" }),
    lastEventAt: toIso(row.last_event_at),
    lastEventAtDisplay: formatTaskTimestamp(row.last_event_at, { locale: "en-US" }),
    metadata: {
      requestId: row.request_id || undefined, eventCount: Number(row.event_count || 0),
      sourceRunId: metadata.runId || undefined, openaiResponseId: metadata.taskgen?.openai_response_id || undefined,
      model: metadata.taskgen?.model || undefined,
      networkTask: objectKeyCount(networkTask) ? networkTask : undefined,
      networkProjectId: generatedTask.network_project_id || networkTask.project_id || undefined,
      networkAllocationId: generatedTask.network_allocation_id || networkTask.allocation_id || undefined,
      routingProfileDigest: generatedTask.routing_profile_digest || networkTask.routing_profile_digest || undefined,
    },
  };
}

function groupTasks(tasks) {
  const outstanding = [];
  const verification = [];
  const refused = [];
  const rewarded = [];

  for (const task of tasks) {
    const tab = taskStatusTab(task.statusKey);
    if (tab === "rewarded") {
      rewarded.push(task);
    } else if (tab === "refused") {
      refused.push(task);
    } else if (tab === "verification") {
      verification.push(task);
    } else {
      outstanding.push(task);
    }
  }

  return { outstanding, verification, refused, rewarded };
}

export function taskRequestHandoffState({ requests = {}, taskItems = [] } = {}) {
  const items = Array.isArray(requests?.items) ? requests.items : [];
  const latest = items[0] || null;
  if (!latest) {
    return {
      latestRequestId: "",
      latestRequestStatus: "",
      latestRequestUpdatedAt: null,
      generatedTaskId: "",
      generatedTaskVisible: false,
      requestHandoffState: "none",
      lastError: "",
      isProcessing: false,
      needsAttention: false,
    };
  }

  const generatedTaskId = safeText(latest.generatedTaskId, 180);
  const visibleTask = generatedTaskId
    ? taskItems.find((task) => [task.taskId, task.fullId, task.id].some((value) => safeText(value, 180) === generatedTaskId))
    : null;
  const status = safeText(latest.status, 80);
  const generatedTaskVisible = Boolean(visibleTask);
  const requestHandoffState = generatedTaskId
    ? generatedTaskVisible
      ? "generated_visible"
      : "generated_projection_pending"
    : latest.needsAttention || status === "failed"
      ? "failed"
      : latest.isProcessing || ["signing", "published", "queued", "generating"].includes(status)
        ? status || "processing"
        : latest.isTerminal
          ? "terminal"
          : "waiting";

  return {
    latestRequestId: latest.requestId || "",
    latestRequestStatus: status,
    latestRequestUpdatedAt: latest.updatedAt || null,
    generatedTaskId,
    generatedTaskVisible,
    visibleTaskId: visibleTask?.taskId || "",
    requestHandoffState,
    lastError: latest.lastError || "",
    isProcessing: Boolean(latest.isProcessing),
    needsAttention: Boolean(latest.needsAttention),
  };
}

function taskActionState(status = "") {
  return taskLifecycleActions(status);
}

function latestPointerSortValue(row = {}) {
  return [
    Number(row.ledger_index || 0),
    Date.parse(row.close_time || "") || 0,
    String(row.tx_hash || ""),
    Number(row.memo_index || 0),
  ].join(":");
}

function isProjectionBehindCachedPointer(row = {}, latest = {}) {
  if (!latest?.tx_hash && !latest?.cid) return false;
  const projectionTx = safeText(row.last_event_tx_hash, 240);
  const projectionCid = safeText(row.last_event_cid, 240);
  const cachedTx = safeText(latest.tx_hash, 240);
  const cachedCid = safeText(latest.cid, 240);
  if (cachedTx && projectionTx && cachedTx === projectionTx) return false;
  if (cachedCid && projectionCid && cachedCid === projectionCid) return false;
  return Boolean(cachedTx || cachedCid);
}

async function taskReadIntegrityByTaskId({ taskIds = [], accountId = "", walletAddress = "" } = {}) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map((id) => safeText(id, 180)).filter(Boolean))];
  if (!ids.length || !databaseEnabled()) {
    return {
      byTaskId: new Map(),
      totals: {
        pendingReducerCount: 0,
        processingReducerCount: 0,
        failedReducerCount: 0,
        indexingLagCount: 0,
      },
    };
  }

  const [reducerResult, cachedPointerResult] = await Promise.all([
    query(
      `
        SELECT
          task_id,
          count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
          count(*) FILTER (WHERE status = 'processing')::int AS processing_count,
          count(*) FILTER (WHERE status = 'failed')::int AS failed_count,
          max(updated_at) AS latest_reducer_updated_at,
          max(processed_at) AS latest_reducer_processed_at
        FROM pftl_cache_reducer_events
        WHERE task_id = ANY($1::text[])
          AND ($2::text = '' OR account_id = $2)
        GROUP BY task_id
      `,
      [ids, accountId || ""]
    ),
    query(
      `
        SELECT DISTINCT ON (task_id)
          task_id,
          tx_hash,
          cid,
          pointer_kind,
          ledger_index,
          close_time,
          memo_index,
          wallet_address,
          account_id
        FROM (
          SELECT
            COALESCE(NULLIF(po.task_id, ''), NULLIF(pm.task_id, '')) AS task_id,
            pm.tx_hash,
            pm.cid,
            pm.pointer_kind,
            pm.memo_index,
            t.ledger_index,
            t.close_time,
            po.wallet_address,
            po.account_id
          FROM pftl_pointer_memos pm
          JOIN pftl_pointer_observations po
            ON po.tx_hash = pm.tx_hash
           AND po.memo_index = pm.memo_index
          LEFT JOIN pftl_transactions t ON t.tx_hash = pm.tx_hash
          WHERE COALESCE(NULLIF(po.task_id, ''), NULLIF(pm.task_id, '')) = ANY($1::text[])
            AND pm.cid IS NOT NULL
            AND pm.decode_error IS NULL
            AND pm.pointer_kind IN ('TASK', 'TASK_UPDATE', 'TASK_SUBMISSION', 'REWARD')
            AND (
              ($2::text <> '' AND po.account_id = $2)
              OR ($2::text = '' AND po.wallet_address = $3)
            )
        ) scoped
        WHERE task_id IS NOT NULL
        ORDER BY
          task_id,
          ledger_index DESC NULLS LAST,
          close_time DESC NULLS LAST,
          tx_hash DESC,
          memo_index DESC
      `,
      [ids, accountId || "", walletAddress || ""]
    ),
  ]);

  const byTaskId = new Map();
  for (const id of ids) {
    byTaskId.set(id, {
      pendingReducerCount: 0,
      processingReducerCount: 0,
      failedReducerCount: 0,
      latestCachedPointer: null,
      projectionBehindCachedPointer: false,
    });
  }

  for (const row of reducerResult.rows) {
    const taskId = safeText(row.task_id, 180);
    const existing = byTaskId.get(taskId) || {};
    byTaskId.set(taskId, {
      ...existing,
      pendingReducerCount: Number(row.pending_count || 0),
      processingReducerCount: Number(row.processing_count || 0),
      failedReducerCount: Number(row.failed_count || 0),
      latestReducerUpdatedAt: toIso(row.latest_reducer_updated_at),
      latestReducerProcessedAt: toIso(row.latest_reducer_processed_at),
    });
  }

  for (const row of cachedPointerResult.rows) {
    const taskId = safeText(row.task_id, 180);
    const existing = byTaskId.get(taskId) || {};
    byTaskId.set(taskId, {
      ...existing,
      latestCachedPointer: {
        txHash: safeText(row.tx_hash, 240),
        cid: safeText(row.cid, 240),
        pointerKind: safeText(row.pointer_kind, 120),
        ledgerIndex: row.ledger_index ?? null,
        closeTime: toIso(row.close_time),
        memoIndex: row.memo_index ?? null,
        walletAddress: safeText(row.wallet_address, 180),
        accountId: safeText(row.account_id, 180),
        sortValue: latestPointerSortValue(row),
      },
    });
  }

  const totals = {
    pendingReducerCount: 0,
    processingReducerCount: 0,
    failedReducerCount: 0,
    indexingLagCount: 0,
  };
  for (const item of byTaskId.values()) {
    totals.pendingReducerCount += Number(item.pendingReducerCount || 0);
    totals.processingReducerCount += Number(item.processingReducerCount || 0);
    totals.failedReducerCount += Number(item.failedReducerCount || 0);
  }

  return { byTaskId, totals };
}

export async function listTaskState({ accountId = "", walletAddress = "" } = {}) {
  const linked = Boolean(String(walletAddress || "").trim());
  const networkTasks = await getNetworkTaskEligibility({ accountId, walletAddress }).catch((error) => ({
    schema: "pf.task_node.network_task_eligibility.v1",
    status: "unavailable",
    label: "Network task routing unavailable",
    summary: "Task Node could not inspect Network Task routing state.",
    nextAction: "Try again after task state reloads.",
    error: safeText(error?.message || error, 500),
    gates: [],
  }));
  if (!linked) return {
    ...emptyTaskState({ walletLinked: false }),
    networkTasks,
  };
  const requests = await listTaskRequests({ accountId, walletAddress }).catch((error) => ({
    ...emptyTaskRequestState({ walletLinked: true, walletAddress }),
    sync: {
      source: "task_requests",
      status: "error",
      walletAddress,
      requestCount: 0,
      lastUpdatedAt: null,
      error: safeText(error?.message || error, 500),
    },
  }));

  if (!databaseEnabled()) {
    return {
      ...emptyTaskState({ walletLinked: true, walletAddress }),
      networkTasks,
      requests,
      sync: {
        source: "task_projections",
        status: "database_not_configured",
        walletAddress,
        projectionCount: 0, lastSyncedAt: null, requiresRefresh: false, nextPollMs: null,
        refreshReason: "", activeRequestCount: 0, refreshTaskIds: [],
      },
    };
  }

  const result = await query(
    `
      SELECT *
      FROM task_projections
      WHERE subject_wallet = $1
        AND ($2::text = '' OR account_id = $2)
      ORDER BY updated_at DESC, task_id DESC
      LIMIT 200
    `,
    [walletAddress, accountId || ""]
  ).catch((error) => ({ error }));
  if (result.error) {
    return taskProjectionReadErrorState({
      error: result.error,
      networkTasks,
      requests,
      walletAddress,
    });
  }
  const rows = result.rows;
  const integrity = await taskReadIntegrityByTaskId({
    taskIds: rows.map((row) => row.task_id),
    accountId,
    walletAddress,
  }).catch((error) => emptyTaskReadIntegrity({ error: error?.message || error }));
  const taskItems = rows.map((row) => {
    const task = publicTask(row);
    const taskIntegrity = integrity.byTaskId.get(row.task_id) || {};
    const projectionBehindCachedPointer = isProjectionBehindCachedPointer(
      row,
      taskIntegrity.latestCachedPointer
        ? {
          tx_hash: taskIntegrity.latestCachedPointer.txHash,
          cid: taskIntegrity.latestCachedPointer.cid,
        }
        : {}
    );
    if (projectionBehindCachedPointer) integrity.totals.indexingLagCount += 1;
    return {
      ...task,
      integrity: {
        ...taskIntegrity,
        projectionBehindCachedPointer,
      },
    };
  });
  const grouped = groupTasks(taskItems);
  const lastSyncedAt = rows[0]?.updated_at ? toIso(rows[0].updated_at) : null;
  const handoff = taskRequestHandoffState({ requests, taskItems });
  const handoffProjectionPending = handoff.requestHandoffState === "generated_projection_pending";
  const taskSyncVersion = maxIso([
    lastSyncedAt,
    requests?.sync?.lastUpdatedAt,
    handoff.latestRequestUpdatedAt,
    ...taskItems.map((task) => task.updatedAt),
  ]);
  const syncStatus = integrity.totals.integrityUnavailable
    ? "integrity_unavailable"
    : integrity.totals.indexingLagCount > 0
    ? "indexing_lag"
    : integrity.totals.failedReducerCount > 0
      ? "reducer_attention"
      : rows.length > 0
        ? "ready"
        : "empty";
  const projectionRefreshRequired = syncStatus === "indexing_lag" ||
    integrity.totals.pendingReducerCount > 0 ||
    integrity.totals.processingReducerCount > 0;
  const refresh = taskRefreshMetadata({
    tasks: taskItems,
    activeRequestCount: refreshActiveRequestCount(requests),
    handoffProjectionPending,
    projectionRefreshRequired,
    projectionRefreshReason: syncStatus === "indexing_lag"
      ? "task_projection_indexing_lag"
      : "task_reducer_pending",
  });

  return {
    ...emptyTaskState({ walletLinked: true, walletAddress }),
    networkTasks,
    requests,
    ...grouped,
    sync: {
      source: "task_projections",
      status: syncStatus,
      walletAddress,
      projectionCount: rows.length,
      lastSyncedAt,
      pendingReducerCount: integrity.totals.pendingReducerCount,
      processingReducerCount: integrity.totals.processingReducerCount,
      failedReducerCount: integrity.totals.failedReducerCount,
      indexingLagCount: integrity.totals.indexingLagCount,
      integrityUnavailable: Boolean(integrity.totals.integrityUnavailable),
      error: integrity.totals.error || undefined,
      handoff,
      taskSyncVersion,
      ...refresh,
    },
  };
}

export async function getTaskDetail({ accountId = "", walletAddress = "", taskId = "" } = {}) {
  const linked = Boolean(String(walletAddress || "").trim());
  const normalizedTaskId = safeText(taskId, 180);
  if (!linked || !normalizedTaskId) return null;
  if (!databaseEnabled()) {
    const error = new Error("database_not_configured");
    error.code = "TASKNODE_DATABASE_NOT_CONFIGURED";
    throw error;
  }

  const taskResult = await query(
    `
      SELECT *
      FROM task_projections
      WHERE task_id = $1
        AND subject_wallet = $2
        AND ($3::text = '' OR account_id = $3)
      LIMIT 1
    `,
    [normalizedTaskId, walletAddress, accountId || ""]
  );
  const row = taskResult.rows[0];
  if (!row) return null;

  const [pointerResult, reducerResult, reducerHealthResult, cachedPointerResult] = await Promise.all([
    query(
      `
        SELECT *
        FROM pftl_task_pointer_events
        WHERE task_id = $1
          AND wallet_address = $2
          AND ($3::text = '' OR account_id = $3)
        ORDER BY observed_at ASC, memo_index ASC, id ASC
        LIMIT 200
      `,
      [normalizedTaskId, walletAddress, accountId || ""]
    ),
    query(
      `
        SELECT *
        FROM task_events
        WHERE task_id = $1
          AND wallet_address = $2
          AND ($3::text = '' OR account_id = $3)
        ORDER BY occurred_at ASC, id ASC
        LIMIT 200
      `,
      [normalizedTaskId, walletAddress, accountId || ""]
    ),
    query(
      `
        SELECT
          count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
          count(*) FILTER (WHERE status = 'processing')::int AS processing_count,
          count(*) FILTER (WHERE status = 'failed')::int AS failed_count,
          max(updated_at) AS latest_reducer_updated_at,
          max(processed_at) AS latest_reducer_processed_at,
          jsonb_agg(
            jsonb_build_object(
              'id', id,
              'status', status,
              'walletAddress', wallet_address,
              'txHash', tx_hash,
              'cid', cid,
              'lastError', last_error,
              'updatedAt', updated_at
            )
            ORDER BY updated_at DESC, id DESC
          ) FILTER (WHERE status = 'failed') AS failed_examples
        FROM pftl_cache_reducer_events
        WHERE task_id = $1
          AND ($2::text = '' OR account_id = $2)
      `,
      [normalizedTaskId, accountId || ""]
    ),
    query(
      `
        SELECT DISTINCT ON (task_id)
          task_id,
          tx_hash,
          cid,
          pointer_kind,
          ledger_index,
          close_time,
          memo_index,
          wallet_address,
          account_id
        FROM (
          SELECT
            COALESCE(NULLIF(po.task_id, ''), NULLIF(pm.task_id, '')) AS task_id,
            pm.tx_hash,
            pm.cid,
            pm.pointer_kind,
            pm.memo_index,
            t.ledger_index,
            t.close_time,
            po.wallet_address,
            po.account_id
          FROM pftl_pointer_memos pm
          JOIN pftl_pointer_observations po
            ON po.tx_hash = pm.tx_hash
           AND po.memo_index = pm.memo_index
          LEFT JOIN pftl_transactions t ON t.tx_hash = pm.tx_hash
          WHERE COALESCE(NULLIF(po.task_id, ''), NULLIF(pm.task_id, '')) = $1
            AND pm.cid IS NOT NULL
            AND pm.decode_error IS NULL
            AND pm.pointer_kind IN ('TASK', 'TASK_UPDATE', 'TASK_SUBMISSION', 'REWARD')
            AND (
              ($2::text <> '' AND po.account_id = $2)
              OR ($2::text = '' AND po.wallet_address = $3)
            )
        ) scoped
        WHERE task_id IS NOT NULL
        ORDER BY
          task_id,
          ledger_index DESC NULLS LAST,
          close_time DESC NULLS LAST,
          tx_hash DESC,
          memo_index DESC
        LIMIT 1
      `,
      [normalizedTaskId, accountId || "", walletAddress || ""]
    ),
  ]);

  const metadata = safeObject(row.metadata_json);
  const submissionSummaries = Array.isArray(metadata.submissionSummaries)
    ? metadata.submissionSummaries
    : [];
  const task = publicTask(row);
  const pointerTimeline = await Promise.all(pointerResult.rows.map((eventRow, index) => (
    hydrateForensicsEvent(publicPointerEvent(eventRow, index))
  )));
  const reducerTimeline = await Promise.all(reducerResult.rows.map((eventRow, index) => (
    hydrateForensicsEvent(publicReducerEvent(eventRow, index))
  )));
  const timeline = pointerTimeline.length ? pointerTimeline : reducerTimeline;
  const cidEntries = dedupeAuditEntries([
    ...publicCidEntries(metadata.cids),
    ...eventCidEntries(timeline),
  ], "cid");
  const transactionEntries = dedupeAuditEntries([
    ...publicTransactionEntries(metadata.txs),
    ...eventTransactionEntries(timeline),
  ], "txHash");
  const expectedEventCount = Number(row.event_count || 0);
  const reducerHealth = reducerHealthResult.rows[0] || {};
  const cachedPointer = cachedPointerResult.rows[0] || {};
  const projectionBehindCachedPointer = isProjectionBehindCachedPointer(row, cachedPointer);
  const detailProjectionRefreshRequired = projectionBehindCachedPointer ||
    Number(reducerHealth.pending_count || 0) > 0 ||
    Number(reducerHealth.processing_count || 0) > 0;

  return {
    ok: true,
    task,
    wallets: {
      user: row.subject_wallet || "",
      authority: row.authority_wallet || "",
      allocation: row.allocation_wallet || "",
    },
    actions: taskActionState(row.status),
    submission: {
      summaries: submissionSummaries.slice(0, 12),
      generatedTask: safeObject(metadata.generatedTask),
      verificationPolicy: safeObject(row.verification_policy_json),
    },
    currentVerificationRequest: currentVerificationRequest(timeline),
    rewardOutcome: taskRewardOutcome({ offeredPft: row.reward_offer_pft, task, timeline }),
    forensics: {
      source: row.source || "task_projections",
      eventCount: Number(row.event_count || 0),
      requestBundleCid: row.request_bundle_cid || "",
      contextCid: row.context_cid || "",
      lastEventTxHash: row.last_event_tx_hash || "",
      lastEventCid: row.last_event_cid || "",
      cids: cidEntries,
      transactions: transactionEntries,
      timeline,
      pointerEvents: pointerTimeline,
      reducerEvents: reducerTimeline,
      reviewState: taskEventExpectation({ status: row.status, timeline }),
      integrity: {
        expectedEventCount,
        pointerEventCount: pointerTimeline.length,
        reducerEventCount: reducerTimeline.length,
        renderedEventCount: timeline.length,
        missingTimelineRows: expectedEventCount > 0 && timeline.length === 0,
        pendingReducerCount: Number(reducerHealth.pending_count || 0),
        processingReducerCount: Number(reducerHealth.processing_count || 0),
        failedReducerCount: Number(reducerHealth.failed_count || 0),
        failedReducerExamples: Array.isArray(reducerHealth.failed_examples) ? reducerHealth.failed_examples : [],
        latestReducerUpdatedAt: toIso(reducerHealth.latest_reducer_updated_at),
        latestReducerProcessedAt: toIso(reducerHealth.latest_reducer_processed_at),
        latestCachedPointer: cachedPointer.tx_hash || cachedPointer.cid
          ? {
            txHash: safeText(cachedPointer.tx_hash, 240),
            cid: safeText(cachedPointer.cid, 240),
            pointerKind: safeText(cachedPointer.pointer_kind, 120),
            ledgerIndex: cachedPointer.ledger_index ?? null,
            closeTime: toIso(cachedPointer.close_time),
            memoIndex: cachedPointer.memo_index ?? null,
            walletAddress: safeText(cachedPointer.wallet_address, 180),
            accountId: safeText(cachedPointer.account_id, 180),
          }
          : null,
        projectionBehindCachedPointer,
        projectionLastEvent: {
          txHash: safeText(row.last_event_tx_hash, 240),
          cid: safeText(row.last_event_cid, 240),
          status: safeText(row.status, 80),
          eventCount: expectedEventCount,
        },
      },
    },
    sync: {
      updatedAt: toIso(row.updated_at),
      lastEventAt: toIso(row.last_event_at),
      ...taskRefreshMetadata({
        tasks: [task],
        projectionRefreshRequired: detailProjectionRefreshRequired,
        projectionRefreshReason: projectionBehindCachedPointer
          ? "task_projection_indexing_lag"
          : "task_reducer_pending",
      }),
    },
  };
}

function roleWallet(receipt, role) {
  const wallets = Array.isArray(receipt?.wallets) ? receipt.wallets : [];
  return wallets.find((wallet) => wallet?.role === role)?.address || "";
}

function projectionForReceipt(receipt) {
  const taskId = safeText(receipt?.task_id || "", 160);
  const projection = receipt?.projection?.[taskId] || {};
  const generatedTask = receipt?.generated_task || {};
  const submissionRequirement = generatedTask?.submission_requirement || {};
  const metadata = {
    runId: receipt?.run_id || "",
    fixture: receipt?.fixture || {},
    taskgen: receipt?.taskgen || {},
    generatedTask,
    submissionSummaries: receipt?.submission_summaries || [],
    cids: receipt?.cids || {},
    txs: receipt?.txs || {},
  };
  const hydratedEvents = Array.isArray(receipt?.hydrated_events) ? receipt.hydrated_events : [];
  const lastEvent = hydratedEvents[hydratedEvents.length - 1] || {};
  const canonicalProjection = canonicalReceiptProjection({ projection, hydratedEvents });
  const rewardOffer = numeric(generatedTask?.reward_offer?.amount_estimate_pft || projection.reward_offer_pft);
  const rewardActual = numeric(canonicalProjection.rewardActualPft || generatedTask?.reward_actual_pft);

  return {
    taskId,
    accountId: safeText(receipt?.fixture?.account_id || "", 180),
    subjectWallet: roleWallet(receipt, "user"),
    authorityWallet: roleWallet(receipt, "task_authority"),
    allocationWallet: roleWallet(receipt, "allocation_reward"),
    requestId: safeText(receipt?.fixture?.request_id || "", 180),
    status: safeText(canonicalProjection.status || "unknown", 80),
    title: safeText(generatedTask.title || projection.title || "", 240),
    description: safeText(generatedTask.description || projection.description || "", 8000),
    taskKind: safeText(generatedTask.task_kind || projection.task_kind || "", 80),
    rewardOffer,
    rewardActual,
    requestBundleCid: safeText(projection.request_bundle_cid || receipt?.cids?.request_bundle || "", 180),
    contextCid: safeText(receipt?.cids?.context_doc || "", 180),
    submissionType: safeText(submissionRequirement.type || "", 120),
    submissionRequirementText: safeText(submissionRequirement.criteria || submissionRequirement.description || "", 4000),
    verificationPolicy: generatedTask.verification_policy || {},
    acceptBy: toIso(generatedTask?.deadline?.accept_by),
    deadlineAt: toIso(generatedTask?.deadline?.deadline_at),
    eventCount: Number(projection.events?.length || hydratedEvents.length || 0),
    lastEventTxHash: safeText(lastEvent.tx_hash || receipt?.txs?.reward?.tx_hash || "", 180),
    lastEventCid: safeText(lastEvent.cid || receipt?.cids?.reward || "", 180),
    metadata,
    hydratedEvents,
  };
}

function pointerKindForSchema(schema = "") {
  if (schema === "pf.reward.v1") return "REWARD";
  if (schema === "pf.task.submission.v1" || schema === "pf.task.verification_response.v1") return "TASK_SUBMISSION";
  if (schema === "pf.task.update.v1") return "TASK_UPDATE";
  return "TASK";
}

async function projectionWithDurableOwner(projection = {}) {
  const requestId = safeText(projection.requestId, 180);
  const subjectWallet = safeText(projection.subjectWallet, 120);
  if (!requestId && !subjectWallet) return projection;

  const result = await query(
    `SELECT account_id, subject_wallet, request_id
       FROM task_requests
      WHERE ($1::text <> '' AND request_id = $1)
         OR ($1::text = '' AND $2::text <> '' AND subject_wallet = $2)
      ORDER BY CASE WHEN request_id = $1 THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`,
    [requestId, subjectWallet]
  );
  const row = result.rows[0];
  if (!row?.account_id) return projection;

  const ownerAccountId = safeText(row.account_id, 180);
  const ownerWallet = safeText(row.subject_wallet || subjectWallet, 120);
  const ownerRequestId = safeText(row.request_id || requestId, 180);
  const metadata = safeObject(projection.metadata);
  const fixture = { ...safeObject(metadata.fixture), account_id: ownerAccountId, request_id: ownerRequestId };
  return { ...projection, accountId: ownerAccountId, subjectWallet: ownerWallet || projection.subjectWallet, requestId: ownerRequestId, metadata: { ...metadata, fixture } };
}

async function maybeQueueNetworkTaskProfileAfterReward(projection = {}) {
  const accountId = safeText(projection.accountId, 180);
  const rewardActual = numeric(projection.rewardActual);
  const statusTab = taskStatusTab(normalizeTaskStatus(projection.status));
  if (!accountId || rewardActual <= 0 || statusTab !== "rewarded") {
    return { queued: false, reason: "not_positive_reward_projection" };
  }
  return enqueueNetworkTaskProfileForRewardThreshold({
    accountId,
    reason: "rewarded_task_projection",
  }).catch((error) => ({
    queued: false,
    reason: "reward_threshold_enqueue_failed",
    error: safeText(error?.message || error, 1000),
  }));
}

export async function importTaskReplayReceipt(receipt, { sourceRef = "", source = "pftl_replay_receipt" } = {}) {
  if (!databaseEnabled()) {
    const error = new Error("database_not_configured");
    error.code = "TASKNODE_DATABASE_NOT_CONFIGURED";
    throw error;
  }

  const projection = await projectionWithDurableOwner(projectionForReceipt(receipt));
  if (!projection.taskId) throw new Error("receipt_missing_task_id");
  if (!projection.subjectWallet) throw new Error("receipt_missing_subject_wallet");

  const syncRunId = `task_sync_${randomUUID()}`;
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO pftl_task_sync_runs (
         id, account_id, wallet_address, source, source_ref, status, task_count,
         pointer_event_count, metadata_json
       )
       VALUES ($1, $2, $3, $4, $5, 'completed', 1, $6, $7::jsonb)`,
      [
        syncRunId,
        projection.accountId,
        projection.subjectWallet,
        source,
        sourceRef,
        projection.hydratedEvents.length,
        JSON.stringify({ runId: receipt?.run_id || "", taskId: projection.taskId, importedFrom: sourceRef }),
      ]
    );

    for (const [index, event] of projection.hydratedEvents.entries()) {
      const eventId = `ptr_evt_${randomUUID()}`;
      const taskEventId = `task_evt_${randomUUID()}`;
      const eventTaskId = safeText(event.task_id || projection.taskId, 180);
      const eventSchema = safeText(event.schema || "", 120);
      const txHash = safeText(event.tx_hash || "", 180);
      const cid = safeText(event.cid || "", 180);
      if (!txHash || !cid) continue;
      const eventPayload = safeObject(event.payload);
      const pointerEnvelope = { schema: eventSchema, task_id: eventTaskId, tx_hash: txHash, cid };
      const payloadJson = objectKeyCount(eventPayload) > objectKeyCount(pointerEnvelope)
        ? eventPayload
        : pointerEnvelope;
      await client.query(
        `
          INSERT INTO pftl_task_pointer_events (
            id,
            sync_run_id,
            account_id,
            wallet_address,
            task_id,
            event_schema,
            pointer_kind,
            source_tx_hash,
            source_cid,
            memo_index,
            event_digest,
            payload_json,
            pointer_json,
            source
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)
          ON CONFLICT (account_id, wallet_address, source_tx_hash, memo_index, source_cid)
          DO UPDATE SET
            sync_run_id = EXCLUDED.sync_run_id,
            task_id = EXCLUDED.task_id,
            event_schema = EXCLUDED.event_schema,
            event_digest = EXCLUDED.event_digest,
            payload_json = EXCLUDED.payload_json,
            pointer_json = EXCLUDED.pointer_json,
            observed_at = now()
        `,
        [
          eventId,
          syncRunId,
          projection.accountId,
          projection.subjectWallet,
          eventTaskId,
          eventSchema,
          pointerKindForSchema(eventSchema),
          txHash,
          cid,
          index,
          safeText(event.event_digest || "", 180),
          JSON.stringify(payloadJson),
          JSON.stringify(event),
          source,
        ]
      );
      if (eventTaskId) {
        await client.query(
          `
            INSERT INTO task_events (
              id,
              task_id,
              account_id,
              wallet_address,
              event_type,
              source_tx_hash,
              source_cid,
              event_digest,
              payload_json,
              pointer_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
            ON CONFLICT (task_id, event_type, source_tx_hash, source_cid)
            DO UPDATE SET
              account_id = EXCLUDED.account_id,
              wallet_address = EXCLUDED.wallet_address,
              event_digest = EXCLUDED.event_digest,
              payload_json = EXCLUDED.payload_json,
              pointer_json = EXCLUDED.pointer_json
          `,
          [
            taskEventId,
            eventTaskId,
            projection.accountId,
            projection.subjectWallet,
            eventSchema,
            txHash,
            cid,
            safeText(event.event_digest || "", 180),
            JSON.stringify(payloadJson),
            JSON.stringify(event),
          ]
        );
      }
    }

    await client.query(
      `
        INSERT INTO task_projections (
          task_id,
          account_id,
          subject_wallet,
          authority_wallet,
          allocation_wallet,
          request_id,
          status,
          title,
          description,
          task_kind,
          reward_offer_pft,
          reward_actual_pft,
          request_bundle_cid,
          context_cid,
          submission_type,
          submission_requirement_text,
          verification_policy_json,
          accept_by,
          deadline_at,
          event_count,
          last_event_tx_hash,
          last_event_cid,
          source,
          metadata_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15,
          $16, $17::jsonb, $18, $19, $20, $21,
          $22, $23, $24::jsonb
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          account_id = EXCLUDED.account_id,
          subject_wallet = EXCLUDED.subject_wallet,
          authority_wallet = EXCLUDED.authority_wallet,
          allocation_wallet = EXCLUDED.allocation_wallet,
          request_id = EXCLUDED.request_id,
          status = CASE
            -- A Board-Manager-cancelled task is server-terminal: the reducer may
            -- never revive it, including to 'rewarded'. agent_cancelled is only
            -- ever written together with a terminal cancelled/refused status, so
            -- a later cache replay (even a stale reward pointer) must not change
            -- the status or mark the task rewarded.
            WHEN task_projections.metadata_json ? 'agent_cancelled'
            THEN task_projections.status
            ELSE EXCLUDED.status
          END,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          task_kind = EXCLUDED.task_kind,
          reward_offer_pft = EXCLUDED.reward_offer_pft,
          reward_actual_pft = CASE
            WHEN task_projections.metadata_json ? 'agent_cancelled'
            THEN task_projections.reward_actual_pft
            ELSE EXCLUDED.reward_actual_pft
          END,
          request_bundle_cid = EXCLUDED.request_bundle_cid,
          context_cid = EXCLUDED.context_cid,
          submission_type = EXCLUDED.submission_type,
          submission_requirement_text = EXCLUDED.submission_requirement_text,
          verification_policy_json = EXCLUDED.verification_policy_json,
          accept_by = EXCLUDED.accept_by,
          deadline_at = EXCLUDED.deadline_at,
          event_count = EXCLUDED.event_count,
          last_event_tx_hash = EXCLUDED.last_event_tx_hash,
          last_event_cid = EXCLUDED.last_event_cid,
          source = EXCLUDED.source,
          metadata_json = CASE
            WHEN task_projections.metadata_json ? 'agent_cancelled'
            THEN task_projections.metadata_json || EXCLUDED.metadata_json
            ELSE EXCLUDED.metadata_json
          END,
          updated_at = now()
        WHERE task_projections.metadata_json ? 'agent_cancelled'
           OR NOT EXISTS (
             SELECT 1
               FROM pftl_transactions current_tx
               JOIN pftl_transactions incoming_tx
                 ON incoming_tx.tx_hash = EXCLUDED.last_event_tx_hash
              WHERE current_tx.tx_hash = task_projections.last_event_tx_hash
                AND (
                  current_tx.ledger_index > incoming_tx.ledger_index
                  OR (
                    current_tx.ledger_index = incoming_tx.ledger_index
                    AND current_tx.close_time > incoming_tx.close_time
                  )
                  OR (
                    current_tx.ledger_index = incoming_tx.ledger_index
                    AND current_tx.close_time = incoming_tx.close_time
                    AND task_projections.last_event_tx_hash > EXCLUDED.last_event_tx_hash
                  )
                )
           )
      `,
      [
        projection.taskId,
        projection.accountId,
        projection.subjectWallet,
        projection.authorityWallet,
        projection.allocationWallet,
        projection.requestId,
        projection.status,
        projection.title,
        projection.description,
        projection.taskKind,
        projection.rewardOffer,
        projection.rewardActual,
        projection.requestBundleCid,
        projection.contextCid,
        projection.submissionType,
        projection.submissionRequirementText,
        JSON.stringify(projection.verificationPolicy),
        projection.acceptBy,
        projection.deadlineAt,
        projection.eventCount,
        projection.lastEventTxHash,
        projection.lastEventCid,
        source,
        JSON.stringify(projection.metadata),
      ]
    );
  });

  await syncNetworkTaskProjection({ taskId: projection.taskId }).catch(() => null);
  const networkTaskProfile = await maybeQueueNetworkTaskProfileAfterReward(projection);

  return {
    ok: true,
    syncRunId,
    taskId: projection.taskId,
    accountId: projection.accountId,
    walletAddress: projection.subjectWallet,
    status: projection.status,
    pointerEventCount: projection.hydratedEvents.length,
    networkTaskProfile,
  };
}
