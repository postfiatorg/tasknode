import { databaseEnabled, query } from "../db/pool.js";
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
import { taskRewardOutcome } from "../task-reward-outcome.js";
import { currentVerificationRequest } from "../task-verification-view.js";
import { getNetworkTaskEligibility } from "./network-tasks.js";
import { emptyTaskRequestState, listTaskRequests } from "./task-requests.js";
import { taskRefreshMetadata, taskStatusTab } from "../../shared/task-lifecycle.js";

import {
  countTaskProjectionRows,
  emptyTaskCounts,
  emptyTaskReadIntegrity,
  emptyTaskState,
  groupTasks,
  isProjectionBehindCachedPointer,
  latestPointerSortValue,
  maxIso,
  mergeTaskForensicsTimeline,
  publicTask,
  refreshActiveRequestCount,
  safeObject,
  safeText,
  taskActionState,
  taskProjectionReadErrorState,
  taskRequestHandoffState,
  toIso,
} from "./task-projection-contract.js";
export {
  isProjectionBehindCachedPointer,
  taskRequestHandoffState,
} from "./task-projection-contract.js";
export { importTaskReplayReceipt } from "./task-replay-import.js";


async function listTaskProjectionRows({ accountId = "", walletAddress = "", limit = 200 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit || 200), 1), 500);
  if (!String(walletAddress || "").trim()) {
    return {
      rows: [],
      sync: {
        source: "task_projections",
        status: "wallet_required",
        walletAddress: null,
        projectionCount: 0,
        lastSyncedAt: null,
      },
    };
  }
  if (!databaseEnabled()) {
    return {
      rows: [],
      sync: {
        source: "task_projections",
        status: "database_not_configured",
        walletAddress,
        projectionCount: 0,
        lastSyncedAt: null,
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
      LIMIT $3
    `,
    [walletAddress, accountId || "", normalizedLimit]
  );
  return {
    rows: result.rows,
    sync: {
      source: "task_projections",
      status: result.rows.length > 0 ? "ready" : "empty",
      walletAddress,
      projectionCount: result.rows.length,
      lastSyncedAt: result.rows[0]?.updated_at ? toIso(result.rows[0].updated_at) : null,
    },
  };
}
export async function listTaskProjectionCounts({ accountId = "", walletAddress = "" } = {}) {
  try {
    const { rows, sync } = await listTaskProjectionRows({ accountId, walletAddress, limit: 200 });
    return {
      counts: countTaskProjectionRows(rows),
      sync,
    };
  } catch (error) {
    return {
      counts: emptyTaskCounts(),
      sync: {
        source: "task_projections",
        status: "database_error",
        walletAddress: walletAddress || null,
        projectionCount: 0,
        lastSyncedAt: null,
        error: safeText(error?.message || error, 500),
      },
    };
  }
}

export async function listTaskProjectionRewards({
  accountId = "",
  walletAddress = "",
  limit = 10,
} = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit || 10), 1), 50);
  try {
    const { rows, sync } = await listTaskProjectionRows({ accountId, walletAddress, limit: 200 });
    return {
      rewards: rows
        .map((row) => publicTask(row))
        .filter((task) => taskStatusTab(task.statusKey) === "rewarded")
        .slice(0, normalizedLimit),
      sync,
    };
  } catch (error) {
    return {
      rewards: [],
      sync: {
        source: "task_projections",
        status: "database_error",
        walletAddress: walletAddress || null,
        projectionCount: 0,
        lastSyncedAt: null,
        error: safeText(error?.message || error, 500),
      },
    };
  }
}

export async function listTaskProjectionTasks({
  accountId = "",
  walletAddress = "",
  tab = "outstanding",
  limit = 200,
} = {}) {
  const normalizedTab = safeText(tab || "outstanding", 80);
  try {
    const { rows, sync } = await listTaskProjectionRows({ accountId, walletAddress, limit });
    const grouped = groupTasks(rows.map((row) => publicTask(row)));
    const tasks = Array.isArray(grouped[normalizedTab]) ? grouped[normalizedTab] : [];
    return {
      tab: normalizedTab,
      tasks,
      counts: countTaskProjectionRows(rows),
      sync,
    };
  } catch (error) {
    return {
      tab: normalizedTab,
      tasks: [],
      counts: emptyTaskCounts(),
      sync: {
        source: "task_projections",
        status: "database_error",
        walletAddress: walletAddress || null,
        projectionCount: 0,
        lastSyncedAt: null,
        error: safeText(error?.message || error, 500),
      },
    };
  }
}

export async function getTerminalTaskProjectionDetail({
  accountId = "",
  walletAddress = "",
  taskId = "",
} = {}) {
  const normalizedTaskId = safeText(taskId, 180);
  if (!String(walletAddress || "").trim() || !normalizedTaskId) return null;
  if (!databaseEnabled()) {
    const error = new Error("database_not_configured");
    error.code = "TASKNODE_DATABASE_NOT_CONFIGURED";
    throw error;
  }

  const result = await query(
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
  const row = result.rows[0];
  if (!row) return null;

  const metadata = safeObject(row.metadata_json);
  const submissionSummaries = Array.isArray(metadata.submissionSummaries)
    ? metadata.submissionSummaries
    : [];
  const task = publicTask(row);
  const eventCount = Number(row.event_count || 0);
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
    currentVerificationRequest: safeObject(metadata.currentVerificationRequest),
    rewardOutcome: null,
    forensics: {
      source: row.source || "task_projections",
      eventCount,
      requestBundleCid: row.request_bundle_cid || "",
      contextCid: row.context_cid || "",
      lastEventTxHash: row.last_event_tx_hash || "",
      lastEventCid: row.last_event_cid || "",
      cids: [],
      transactions: [],
      timeline: [],
      pointerEvents: [],
      reducerEvents: [],
      reviewState: taskEventExpectation({ status: row.status, timeline: [] }),
      integrity: {
        expectedEventCount: eventCount,
        pointerEventCount: 0,
        reducerEventCount: 0,
        renderedEventCount: 0,
        terminalLightweight: true,
        projectionLastEvent: {
          txHash: safeText(row.last_event_tx_hash, 240),
          cid: safeText(row.last_event_cid, 240),
          status: safeText(row.status, 80),
          eventCount,
        },
      },
    },
    sync: {
      updatedAt: toIso(row.updated_at),
      lastEventAt: toIso(row.last_event_at),
      requiresRefresh: false,
      nextPollMs: null,
      refreshReason: "",
      activeRequestCount: 0,
      refreshTaskIds: [],
    },
  };
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
          pointer_kind: taskIntegrity.latestCachedPointer.pointerKind,
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
  const timeline = mergeTaskForensicsTimeline(pointerTimeline, reducerTimeline);
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
