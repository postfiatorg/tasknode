import { query as defaultQuery } from "../db/pool.js";
import {
  allocationStatusForTaskStatus,
  safeText,
  toIso,
} from "./network-tasks-utils.js";

export const terminalNetworkTaskStatuses = Object.freeze([
  "refused",
  "rejected",
  "cancelled",
  "expired",
  "rerouted",
  "failed",
  "completed",
  "rewarded",
]);

function alias(value, fallback) {
  const normalized = safeText(value, 40);
  return /^[a-z_][a-z0-9_]*$/i.test(normalized) ? normalized : fallback;
}

// Allocation/projection linkage is intentionally one-way: a populated
// generated_task_id is authoritative; request_id is only a fallback while
// generated_task_id is empty. Keep this predicate shared by every mirror
// read/write so stale request matches cannot override a generated task.
export function canonicalAllocationProjectionLinkSql(
  allocationAlias = "alloc",
  projectionAlias = "projection"
) {
  const allocation = alias(allocationAlias, "alloc");
  const projection = alias(projectionAlias, "projection");
  return `(
    (${allocation}.generated_task_id <> '' AND ${projection}.task_id = ${allocation}.generated_task_id)
    OR
    (${allocation}.generated_task_id = ''
      AND ${allocation}.task_request_id <> ''
      AND ${projection}.request_id = ${allocation}.task_request_id)
  )`;
}

function executorFor(client) {
  return client && typeof client.query === "function" ? client : { query: defaultQuery };
}

function projectionValue(projection = {}, key, fallback = "") {
  return projection[key] ?? projection[key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`)] ?? fallback;
}

export async function syncNetworkTaskAllocationMirrors({
  client,
  projection = {},
  taskId = "",
  requestId = "",
  status = "",
  updatedAt = null,
  lastEventAt = null,
} = {}) {
  const runner = executorFor(client);
  const normalizedTaskId = safeText(taskId || projectionValue(projection, "taskId"), 180);
  const normalizedRequestId = safeText(requestId || projectionValue(projection, "requestId"), 180);
  const canonicalStatus = safeText(status || projectionValue(projection, "status"), 80).toLowerCase();
  if (!canonicalStatus) {
    return { ok: false, skipped: true, reason: "projection_status_missing", allocationsUpdated: 0, rows: [] };
  }
  if (!normalizedTaskId && !normalizedRequestId) {
    return { ok: false, skipped: true, reason: "projection_link_missing", allocationsUpdated: 0, rows: [] };
  }
  const allocationStatus = allocationStatusForTaskStatus(canonicalStatus);
  const projectionUpdatedAt = toIso(updatedAt || projectionValue(projection, "updatedAt"));
  const projectionLastEventAt = toIso(lastEventAt || projectionValue(projection, "lastEventAt"));
  const metadata = JSON.stringify({
    source_of_truth: "task_projections",
    task_projection_status: canonicalStatus,
    task_projection_updated_at: projectionUpdatedAt,
    task_projection_last_event_at: projectionLastEventAt,
  });
  const result = await runner.query(
    `
      WITH projection(task_id, request_id, status) AS (
        VALUES ($1::text, $2::text, $3::text)
      )
      UPDATE network_task_allocations alloc
         SET allocation_status = $4,
             metadata_json = COALESCE(alloc.metadata_json, '{}'::jsonb) || $5::jsonb,
             updated_at = now()
        FROM projection
       WHERE ${canonicalAllocationProjectionLinkSql("alloc", "projection")}
       RETURNING alloc.id,
                 alloc.project_id,
                 alloc.generated_task_id,
                 alloc.task_request_id,
                 alloc.allocation_status
    `,
    [normalizedTaskId, normalizedRequestId, canonicalStatus, allocationStatus, metadata]
  );
  return {
    ok: true,
    taskId: normalizedTaskId,
    requestId: normalizedRequestId,
    status: canonicalStatus,
    allocationStatus,
    allocationsUpdated: result.rowCount || 0,
    rows: result.rows || [],
  };
}

export async function listNetworkTaskAllocationDivergences({
  client,
  taskId = "",
  accountId = "",
  walletAddress = "",
  limit = 500,
} = {}) {
  const runner = executorFor(client);
  const normalizedTaskId = safeText(taskId, 180);
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWalletAddress = safeText(walletAddress, 120);
  const boundedLimit = Math.min(Math.max(Number(limit || 100), 1), 500);
  const result = await runner.query(
    `
      SELECT
        alloc.id AS allocation_id,
        alloc.allocation_status,
        alloc.generated_task_id,
        alloc.task_request_id AS allocation_request_id,
        alloc.candidate_account_id,
        alloc.candidate_wallet_address,
        alloc.created_at AS allocation_created_at,
        alloc.updated_at AS allocation_updated_at,
        projection.task_id AS canonical_task_id,
        projection.status AS canonical_task_status,
        projection.request_id AS canonical_request_id,
        projection.account_id AS canonical_account_id,
        projection.subject_wallet AS canonical_wallet_address,
        projection.created_at AS projection_created_at,
        projection.updated_at AS projection_updated_at
      FROM network_task_allocations alloc
      JOIN task_projections projection
        ON ${canonicalAllocationProjectionLinkSql("alloc", "projection")}
      WHERE alloc.allocation_status IS DISTINCT FROM projection.status
        AND ($1::text = '' OR projection.task_id = $1)
        AND ($2::text = '' OR alloc.candidate_account_id = $2 OR projection.account_id = $2)
        AND ($3::text = '' OR alloc.candidate_wallet_address = $3 OR projection.subject_wallet = $3)
      ORDER BY GREATEST(alloc.updated_at, projection.updated_at) DESC, alloc.id DESC
      LIMIT $4
    `,
    [normalizedTaskId, normalizedAccountId, normalizedWalletAddress, boundedLimit]
  );
  return result.rows || [];
}

export const detectNetworkTaskAllocationDivergences = listNetworkTaskAllocationDivergences;
