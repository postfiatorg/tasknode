import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  directoryRewardedTaskToReviewItem,
  ingestDirectoryRewardedTasksIntoReviewQueue,
} from "../server/repositories/orc-review-queue-ingestion.js";

const migration = await readFile(
  new URL("../server/db/migrations/064_orc_review_queue_public_items.sql", import.meta.url),
  "utf8"
);
const statusMigration = await readFile(
  new URL("../server/db/migrations/065_network_task_status_packets.sql", import.meta.url),
  "utf8"
);
const migrateJs = await readFile(new URL("../server/db/migrate.js", import.meta.url), "utf8");

assert.match(migrateJs, /064_orc_review_queue_public_items\.sql/);
assert.match(migrateJs, /065_network_task_status_packets\.sql/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS orc_task_review_items/);
assert.match(migration, /source_mode text NOT NULL DEFAULT 'local_projection'/);
assert.match(migration, /'directory_public'/);
assert.match(migration, /INSERT INTO orc_task_review_items/);
assert.match(migration, /FROM task_projections p/);
assert.match(migration, /source_mode = 'local_projection'/);
assert.match(migration, /DROP VIEW IF EXISTS orc_task_review_queue/);
assert.match(migration, /CREATE VIEW orc_task_review_queue AS/);
assert.match(migration, /FROM orc_task_review_items item/);
assert.match(migration, /LEFT JOIN orc_task_review_states s/);
assert.match(statusMigration, /statusPacket/);
assert.match(statusMigration, /network_status_packet/);
assert.match(statusMigration, /status_packet_json/);
assert.match(statusMigration, /closed_zero/);

const publicTask = {
  taskId: "task_public_rewarded",
  taskKind: "network",
  operator: {
    accountId: "acct_public",
    handle: "publicorc",
    wallet: "rPublicOrc",
  },
  title: "Review public rewarded task",
  description: "Public Directory task description.",
  rewardActualPft: 12345,
  statusPacket: {
    schema: "pf.task_node.network_task_status_packet.v1",
    allocationState: "published",
    taskState: "rewarded",
    rewardMovement: "paid_positive",
    repairRequired: false,
    repairReason: "",
  },
  requestBundleCid: "bafyRequest",
  lastEvent: {
    txHash: "TX_PUBLIC_REWARD",
    cid: "bafyReward",
    occurredAt: "2026-06-19T01:00:00.000Z",
  },
  eventCount: 6,
  hiveTaskDetailUrl: "/api/hive/task-detail?taskId=task_public_rewarded",
  project: {
    id: "task_node_core_product",
    title: "Task Node Core Product",
    source: "network_task_generation",
  },
  evaluationPacket: {
    id: "evalpkt_public",
    summary: "Public evaluation summary.",
    recommendation: "Review for follow-up.",
  },
};

const item = directoryRewardedTaskToReviewItem(publicTask);
assert.equal(item.task_id, "task_public_rewarded");
assert.equal(item.source_mode, "directory_public");
assert.equal(item.operator_handle, "publicorc");
assert.equal(item.operator_wallet, "rPublicOrc");
assert.equal(item.reward_actual_pft, 12345);
assert.equal(item.last_seen_event_tx_hash, "TX_PUBLIC_REWARD");
assert.equal(item.public_hive_task_detail_url, "/api/hive/task-detail?taskId=task_public_rewarded");
assert.equal(item.metadata_json.project.id, "task_node_core_product");
assert.equal(item.metadata_json.evaluationPacket.summary, "Public evaluation summary.");
assert.equal(item.metadata_json.statusPacket.rewardMovement, "paid_positive");

const zeroRewardTask = {
  ...publicTask,
  taskId: "task_public_zero_reward",
  title: "Review zero-reward task",
  rewardActualPft: 0,
  lastEvent: {
    txHash: "TX_PUBLIC_ZERO",
    cid: "bafyZero",
    occurredAt: "2026-06-19T00:30:00.000Z",
  },
  statusPacket: {
    schema: "pf.task_node.network_task_status_packet.v1",
    allocationState: "published",
    taskState: "rewarded",
    rewardMovement: "closed_zero",
    repairRequired: false,
    repairReason: "",
  },
};

const calls = [];
const result = await ingestDirectoryRewardedTasksIntoReviewQueue({
  taskKind: "network",
  limit: 500,
  execute: true,
  databaseReady: true,
  directoryReader: async ({ taskKind, limit }) => {
    assert.equal(taskKind, "network");
    assert.equal(limit, 500);
    return {
      ok: true,
      tasks: [
        publicTask,
        zeroRewardTask,
        {
          ...publicTask,
          taskId: "task_personal_skipped",
          taskKind: "personal",
        },
      ],
    };
  },
  queryImpl: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("to_regclass('public.orc_task_review_items')")) {
      return { rows: [{ name: "orc_task_review_items" }] };
    }
    assert.match(sql, /ON CONFLICT \(task_id\) DO UPDATE SET/);
    assert.match(sql, /orc_task_review_items\.source_mode <> 'local_projection'/);
    assert.match(sql, /last_seen_event_tx_hash IS DISTINCT FROM EXCLUDED\.last_seen_event_tx_hash/);
    const payload = JSON.parse(params[0]);
    assert.equal(payload.length, 2);
    assert.equal(payload[0].task_id, "task_public_rewarded");
    assert.equal(payload[0].source_mode, "directory_public");
    assert.equal(payload[0].last_seen_event_tx_hash, "TX_PUBLIC_REWARD");
    assert.equal(payload[0].metadata_json.statusPacket.rewardMovement, "paid_positive");
    assert.equal(payload[1].task_id, "task_public_zero_reward");
    assert.equal(payload[1].metadata_json.statusPacket.rewardMovement, "closed_zero");
    return {
      rows: [{
        rows: [{
          task_id: "task_public_rewarded",
          source_mode: "directory_public",
          last_seen_event_tx_hash: "TX_PUBLIC_REWARD",
        }, {
          task_id: "task_public_zero_reward",
          source_mode: "directory_public",
          last_seen_event_tx_hash: "TX_PUBLIC_ZERO",
        }],
      }],
    };
  },
});

assert.equal(result.ok, true);
assert.equal(result.scanned, 3);
assert.equal(result.ingestible, 2);
assert.equal(result.upserted, 2);
assert.equal(calls.length, 2);

const dryRun = await ingestDirectoryRewardedTasksIntoReviewQueue({
  taskKind: "network",
  execute: false,
  databaseReady: true,
  directoryReader: async () => ({ ok: true, tasks: [publicTask] }),
  queryImpl: async (sql) => {
    if (sql.includes("to_regclass('public.orc_task_review_items')")) {
      return { rows: [{ name: "orc_task_review_items" }] };
    }
    throw new Error("dry-run must not upsert");
  },
});
assert.equal(dryRun.execute, false);
assert.equal(dryRun.ingestible, 1);
assert.deepEqual(dryRun.sampleTaskIds, ["task_public_rewarded"]);

console.log("orc review queue ingestion smoke ok");
