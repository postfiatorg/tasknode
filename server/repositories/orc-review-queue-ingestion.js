import { databaseEnabled, query } from "../db/pool.js";
import { getDirectoryRewardedTasksDocument } from "./directory-rewarded-tasks.js";
import { packetNeedsReview } from "./network-task-status.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function intValue(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function reviewItemsTableExists(queryImpl = query, databaseReady = databaseEnabled()) {
  if (!databaseReady && queryImpl === query) return false;
  const result = await queryImpl("SELECT to_regclass('public.orc_task_review_items') AS name");
  return Boolean(result.rows[0]?.name);
}

export function directoryRewardedTaskToReviewItem(task = {}) {
  const operator = safeObject(task.operator);
  const lastEvent = safeObject(task.lastEvent);
  const project = safeObject(task.project);
  const evaluationPacket = safeObject(task.evaluationPacket);
  const statusPacket = safeObject(task.statusPacket);
  return {
    task_id: safeText(task.taskId || task.task_id, 180),
    source_mode: "directory_public",
    account_id: safeText(operator.accountId || task.accountId || task.account_id, 180),
    operator_handle: safeText(operator.handle || task.handle, 160).replace(/^@+/, ""),
    operator_wallet: safeText(operator.wallet || task.wallet || task.walletAddress || task.wallet_address, 160),
    title: safeText(task.title, 400),
    description: safeText(task.description, 2400),
    task_kind: safeText(task.taskKind || task.task_kind || "network", 80).toLowerCase() || "network",
    task_status: "rewarded",
    reward_offer_pft: 0,
    reward_actual_pft: numeric(task.rewardActualPft || task.reward_actual_pft || task.rewardPft || task.reward_pft),
    request_bundle_cid: safeText(task.requestBundleCid || task.request_bundle_cid, 240),
    last_event_cid: safeText(lastEvent.cid || task.lastEventCid || task.last_event_cid, 240),
    last_event_tx_hash: safeText(lastEvent.txHash || task.lastEventTxHash || task.last_event_tx_hash, 180),
    public_hive_task_detail_url: safeText(task.hiveTaskDetailUrl || task.publicHiveTaskDetailUrl || task.public_hive_task_detail_url, 300),
    event_count: intValue(task.eventCount || task.event_count),
    last_seen_event_tx_hash: safeText(lastEvent.txHash || task.lastEventTxHash || task.last_event_tx_hash, 180),
    last_seen_at: toIso(lastEvent.occurredAt || task.updatedAt || task.updated_at) || new Date().toISOString(),
    metadata_json: {
      ingestedFrom: "directory_rewarded_tasks",
      directoryPolicy: safeObject(task.policy),
      project: project.id ? project : null,
      evaluationPacket: evaluationPacket.id || evaluationPacket.summary ? evaluationPacket : null,
      statusPacket: statusPacket.schema ? statusPacket : null,
    },
  };
}

function publicReviewItemsUpsertSql() {
  return `
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS item (
        task_id text,
        source_mode text,
        account_id text,
        operator_handle text,
        operator_wallet text,
        title text,
        description text,
        task_kind text,
        task_status text,
        reward_offer_pft numeric,
        reward_actual_pft numeric,
        request_bundle_cid text,
        last_event_cid text,
        last_event_tx_hash text,
        public_hive_task_detail_url text,
        event_count integer,
        last_seen_event_tx_hash text,
        last_seen_at timestamptz,
        metadata_json jsonb
      )
      WHERE COALESCE(task_id, '') <> ''
        AND source_mode IN ('directory_public', 'hive_public_detail', 'network_status_packet')
    ),
    upserted AS (
      INSERT INTO orc_task_review_items (
        task_id,
        source_mode,
        account_id,
        operator_handle,
        operator_wallet,
        title,
        description,
        task_kind,
        task_status,
        reward_offer_pft,
        reward_actual_pft,
        request_bundle_cid,
        last_event_cid,
        last_event_tx_hash,
        public_hive_task_detail_url,
        event_count,
        first_seen_at,
        last_seen_at,
        last_seen_event_tx_hash,
        metadata_json,
        created_at,
        updated_at
      )
      SELECT
        task_id,
        COALESCE(NULLIF(source_mode, ''), 'directory_public'),
        COALESCE(account_id, ''),
        COALESCE(operator_handle, ''),
        COALESCE(operator_wallet, ''),
        COALESCE(title, ''),
        COALESCE(description, ''),
        COALESCE(NULLIF(task_kind, ''), 'network'),
        COALESCE(NULLIF(task_status, ''), 'rewarded'),
        COALESCE(reward_offer_pft, 0),
        COALESCE(reward_actual_pft, 0),
        COALESCE(request_bundle_cid, ''),
        COALESCE(last_event_cid, ''),
        COALESCE(last_event_tx_hash, ''),
        COALESCE(public_hive_task_detail_url, ''),
        COALESCE(event_count, 0),
        COALESCE(last_seen_at, now()),
        COALESCE(last_seen_at, now()),
        COALESCE(last_seen_event_tx_hash, ''),
        COALESCE(metadata_json, '{}'::jsonb),
        now(),
        now()
      FROM incoming
      ON CONFLICT (task_id) DO UPDATE SET
        source_mode = CASE
          WHEN orc_task_review_items.source_mode = 'local_projection' THEN orc_task_review_items.source_mode
          ELSE EXCLUDED.source_mode
        END,
        account_id = COALESCE(NULLIF(orc_task_review_items.account_id, ''), NULLIF(EXCLUDED.account_id, ''), ''),
        operator_handle = COALESCE(NULLIF(orc_task_review_items.operator_handle, ''), NULLIF(EXCLUDED.operator_handle, ''), ''),
        operator_wallet = COALESCE(NULLIF(orc_task_review_items.operator_wallet, ''), NULLIF(EXCLUDED.operator_wallet, ''), ''),
        title = COALESCE(NULLIF(orc_task_review_items.title, ''), NULLIF(EXCLUDED.title, ''), ''),
        description = COALESCE(NULLIF(orc_task_review_items.description, ''), NULLIF(EXCLUDED.description, ''), ''),
        task_kind = COALESCE(NULLIF(orc_task_review_items.task_kind, ''), NULLIF(EXCLUDED.task_kind, ''), 'network'),
        task_status = COALESCE(NULLIF(orc_task_review_items.task_status, ''), NULLIF(EXCLUDED.task_status, ''), 'rewarded'),
        reward_offer_pft = CASE
          WHEN orc_task_review_items.reward_offer_pft > 0 THEN orc_task_review_items.reward_offer_pft
          ELSE EXCLUDED.reward_offer_pft
        END,
        reward_actual_pft = CASE
          WHEN orc_task_review_items.reward_actual_pft > 0 THEN orc_task_review_items.reward_actual_pft
          ELSE EXCLUDED.reward_actual_pft
        END,
        request_bundle_cid = COALESCE(NULLIF(orc_task_review_items.request_bundle_cid, ''), NULLIF(EXCLUDED.request_bundle_cid, ''), ''),
        last_event_cid = COALESCE(NULLIF(EXCLUDED.last_event_cid, ''), orc_task_review_items.last_event_cid),
        last_event_tx_hash = COALESCE(NULLIF(EXCLUDED.last_event_tx_hash, ''), orc_task_review_items.last_event_tx_hash),
        public_hive_task_detail_url = COALESCE(NULLIF(orc_task_review_items.public_hive_task_detail_url, ''), NULLIF(EXCLUDED.public_hive_task_detail_url, ''), ''),
        event_count = GREATEST(orc_task_review_items.event_count, EXCLUDED.event_count),
        last_seen_at = EXCLUDED.last_seen_at,
        last_seen_event_tx_hash = COALESCE(NULLIF(EXCLUDED.last_seen_event_tx_hash, ''), orc_task_review_items.last_seen_event_tx_hash),
        metadata_json = orc_task_review_items.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      WHERE orc_task_review_items.source_mode <> 'local_projection'
        AND (
          orc_task_review_items.last_seen_event_tx_hash IS DISTINCT FROM EXCLUDED.last_seen_event_tx_hash
          OR orc_task_review_items.last_seen_event_tx_hash = ''
          OR orc_task_review_items.title = ''
          OR orc_task_review_items.request_bundle_cid = ''
          OR orc_task_review_items.public_hive_task_detail_url = ''
        )
      RETURNING task_id, source_mode, last_seen_event_tx_hash, updated_at
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(upserted) ORDER BY task_id), '[]'::jsonb) AS rows
    FROM upserted
  `;
}

export async function ingestDirectoryRewardedTasksIntoReviewQueue({
  taskKind = "network",
  limit = 500,
  execute = false,
  directoryReader = getDirectoryRewardedTasksDocument,
  queryImpl = query,
  databaseReady = databaseEnabled(),
} = {}) {
  if (!databaseReady && queryImpl === query) {
    return { ok: false, skipped: true, error: "database_not_configured" };
  }
  if (!(await reviewItemsTableExists(queryImpl, databaseReady))) {
    return { ok: false, status: 409, error: "orc_task_review_items_not_migrated" };
  }
  const document = await directoryReader({ taskKind, limit });
  if (document?.ok === false) return document;
  const tasks = Array.isArray(document?.tasks) ? document.tasks : [];
  const items = tasks
    .map(directoryRewardedTaskToReviewItem)
    .filter((item) => (
      item.task_id &&
      item.task_kind === "network" &&
      packetNeedsReview(safeObject(item.metadata_json).statusPacket) &&
      (
        item.last_event_tx_hash ||
        item.last_event_cid ||
        safeObject(item.metadata_json).statusPacket?.repairRequired === true
      )
    ));
  if (!execute) {
    return {
      ok: true,
      execute: false,
      taskKind,
      scanned: tasks.length,
      ingestible: items.length,
      sampleTaskIds: items.slice(0, 10).map((item) => item.task_id),
    };
  }
  if (!items.length) {
    return {
      ok: true,
      execute: true,
      taskKind,
      scanned: tasks.length,
      ingestible: 0,
      upserted: 0,
      rows: [],
    };
  }
  const result = await queryImpl(publicReviewItemsUpsertSql(), [JSON.stringify(items)]);
  const rows = Array.isArray(result.rows?.[0]?.rows) ? result.rows[0].rows : [];
  return {
    ok: true,
    execute: true,
    taskKind,
    scanned: tasks.length,
    ingestible: items.length,
    upserted: rows.length,
    rows,
  };
}
