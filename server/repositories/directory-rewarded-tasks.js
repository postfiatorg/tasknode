import { databaseEnabled, query } from "../db/pool.js";
import { listDiscoverableAccountWalletIdentities } from "../runtime-store.js";
import { listEvidenceEvaluationPackets } from "./evidence-evaluation-packets.js";
import { canonicalRewardedTaskProjectionSql } from "./task-projection-integrity.js";

export const DIRECTORY_REWARDED_TASKS_DEFAULT_LIMIT = 100;
export const DIRECTORY_REWARDED_TASKS_MAX_LIMIT = 500;
export const DIRECTORY_REWARDED_TASK_KINDS = new Set(["network", "personal"]);

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeHandle(value = "") {
  return safeText(value, 120).replace(/^@+/, "");
}

function firstPublicAliasHandle(identity = {}) {
  const alias = (Array.isArray(identity.publicAliases) ? identity.publicAliases : [])
    .find((entry) => safeText(entry?.handle, 120));
  return normalizeHandle(alias?.handle || "");
}

function handleForIdentity(identity = {}) {
  return normalizeHandle(identity.hiveHandle || firstPublicAliasHandle(identity));
}

export function normalizeDirectoryRewardedTaskKind(value = "network") {
  const taskKind = safeText(value || "network", 40).toLowerCase() || "network";
  return DIRECTORY_REWARDED_TASK_KINDS.has(taskKind) ? taskKind : "";
}

export function directoryRewardedTasksLimit(value = DIRECTORY_REWARDED_TASKS_DEFAULT_LIMIT) {
  const parsed = Number(value || DIRECTORY_REWARDED_TASKS_DEFAULT_LIMIT);
  const limit = Number.isFinite(parsed) ? Math.round(parsed) : DIRECTORY_REWARDED_TASKS_DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), DIRECTORY_REWARDED_TASKS_MAX_LIMIT);
}

function publicIdentityMap(identities = []) {
  const result = new Map();
  for (const identity of identities) {
    const accountId = safeText(identity?.accountId, 180);
    if (!accountId || accountId.startsWith("deleted_account_")) continue;
    result.set(accountId, identity);
  }
  return result;
}

function publicHiveTaskDetailUrl({ taskId = "", taskKind = "", projectId = "" } = {}) {
  const normalizedTaskId = safeText(taskId, 180);
  if (!normalizedTaskId || taskKind !== "network" || !safeText(projectId, 180)) return "";
  return `/api/hive/task-detail?taskId=${encodeURIComponent(normalizedTaskId)}`;
}

function evaluationPacketSummary(packet = {}) {
  if (!packet?.id && !packet?.summary && !packet?.recommendation) return null;
  return {
    id: safeText(packet.id, 180),
    packetStatus: safeText(packet.packetStatus, 80),
    evaluatorId: safeText(packet.evaluatorId, 180),
    summary: safeText(packet.summary, 700),
    recommendation: safeText(packet.recommendation, 700),
    sourceDigest: safeText(packet.sourceDigest, 120),
    updatedAt: toIso(packet.updatedAt),
  };
}

async function queryRewardedTaskRows({
  accountIds = [],
  taskKind = "network",
  limit = DIRECTORY_REWARDED_TASKS_DEFAULT_LIMIT,
  queryImpl = query,
  databaseReady = databaseEnabled(),
} = {}) {
  if (!databaseReady || !accountIds.length) return [];
  const result = await queryImpl(
    `
      WITH visible_accounts AS (
        SELECT unnest($1::text[]) AS account_id
      )
      SELECT p.task_id,
             p.account_id,
             p.subject_wallet,
             p.task_kind,
             p.title,
             p.description,
             p.reward_actual_pft::text AS reward_actual_pft,
             p.request_bundle_cid,
             p.last_event_tx_hash,
             p.last_event_cid,
             p.event_count,
             p.last_event_at,
             p.updated_at,
             refs.project_id,
             refs.source AS project_ref_source,
             project.title AS project_title,
             latest_event.source_tx_hash AS latest_event_tx_hash,
             latest_event.source_cid AS latest_event_cid,
             latest_event.occurred_at AS latest_event_at
      FROM task_projections p
      JOIN visible_accounts visible
        ON visible.account_id = p.account_id
      LEFT JOIN LATERAL (
        SELECT refs.project_id,
               refs.source
        FROM network_project_task_refs refs
        WHERE refs.task_id = p.task_id
          AND refs.task_id <> ''
        ORDER BY (refs.source = 'network_task_generation') DESC,
                 refs.updated_at DESC NULLS LAST,
                 refs.id DESC
        LIMIT 1
      ) refs ON true
      LEFT JOIN network_projects project
        ON project.id = refs.project_id
      LEFT JOIN LATERAL (
        SELECT event.source_tx_hash,
               event.source_cid,
               event.occurred_at
        FROM task_events event
        WHERE event.task_id = p.task_id
        ORDER BY event.occurred_at DESC NULLS LAST, event.id DESC
        LIMIT 1
      ) latest_event ON true
      WHERE lower(COALESCE(p.task_kind, '')) = $2
        AND ${canonicalRewardedTaskProjectionSql("p")}
      ORDER BY COALESCE(latest_event.occurred_at, p.last_event_at, p.updated_at) DESC NULLS LAST,
               p.reward_actual_pft DESC,
               p.task_id ASC
      LIMIT $3
    `,
    [accountIds, taskKind, limit]
  );
  return result.rows;
}

export async function getDirectoryRewardedTasksDocument({
  taskKind = "network",
  limit = DIRECTORY_REWARDED_TASKS_DEFAULT_LIMIT,
  identityProvider = listDiscoverableAccountWalletIdentities,
  queryImpl = query,
  databaseReady = databaseEnabled(),
  evaluationPacketReader = listEvidenceEvaluationPackets,
} = {}) {
  const normalizedTaskKind = normalizeDirectoryRewardedTaskKind(taskKind);
  if (!normalizedTaskKind) {
    return {
      ok: false,
      status: 400,
      error: "directory_rewarded_tasks_invalid_task_kind",
      message: "taskKind must be network or personal.",
    };
  }
  const normalizedLimit = directoryRewardedTasksLimit(limit);
  const identities = typeof identityProvider === "function" ? identityProvider() : identityProvider;
  const identityByAccount = publicIdentityMap(Array.isArray(identities) ? identities : []);
  const accountIds = Array.from(identityByAccount.keys());
  const rows = await queryRewardedTaskRows({
    accountIds,
    taskKind: normalizedTaskKind,
    limit: normalizedLimit,
    queryImpl,
    databaseReady,
  });
  const taskIds = rows.map((row) => safeText(row.task_id, 180)).filter(Boolean);
  const packets = taskIds.length
    ? await evaluationPacketReader({
      taskIds,
      limit: Math.min(Math.max(taskIds.length, 1), 200),
      queryImpl,
      databaseReady,
    }).catch(() => [])
    : [];
  const packetByTask = new Map();
  for (const packet of Array.isArray(packets) ? packets : []) {
    const packetTaskId = safeText(packet?.taskId, 180);
    if (packetTaskId && !packetByTask.has(packetTaskId)) packetByTask.set(packetTaskId, packet);
  }

  const tasks = rows.map((row) => {
    const taskId = safeText(row.task_id, 180);
    const accountId = safeText(row.account_id, 180);
    const identity = identityByAccount.get(accountId) || {};
    const projectId = safeText(row.project_id, 180);
    return {
      taskId,
      taskKind: normalizedTaskKind,
      operator: {
        accountId,
        handle: handleForIdentity(identity),
        wallet: safeText(identity.walletAddress, 160) || safeText(row.subject_wallet, 160),
      },
      title: safeText(row.title, 240),
      description: safeText(row.description, 1600),
      rewardActualPft: numeric(row.reward_actual_pft),
      requestBundleCid: safeText(row.request_bundle_cid, 240),
      lastEvent: {
        txHash: safeText(row.last_event_tx_hash || row.latest_event_tx_hash, 180),
        cid: safeText(row.last_event_cid || row.latest_event_cid, 240),
        occurredAt: toIso(row.latest_event_at || row.last_event_at || row.updated_at),
      },
      eventCount: Math.max(0, Math.round(Number(row.event_count || 0))),
      hiveTaskDetailUrl: publicHiveTaskDetailUrl({ taskId, taskKind: normalizedTaskKind, projectId }),
      project: projectId
        ? {
          id: projectId,
          title: safeText(row.project_title, 180),
          source: safeText(row.project_ref_source, 120),
        }
        : null,
      evaluationPacket: evaluationPacketSummary(packetByTask.get(taskId)),
    };
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    taskKind: normalizedTaskKind,
    limit: normalizedLimit,
    policy: {
      visibility: "directory_public_discoverable_operator_tasks",
      taskDetail: "hive_task_detail_url_only_for_network_project_tasks",
      privateEvidence: "excluded",
    },
    totals: {
      tasks: tasks.length,
      rewardActualPft: numeric(tasks.reduce((sum, task) => sum + Number(task.rewardActualPft || 0), 0)),
    },
    tasks,
  };
}
