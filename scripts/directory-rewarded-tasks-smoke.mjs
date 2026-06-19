import assert from "node:assert/strict";

import { handleDirectoryRoute } from "../server/directory-routes.js";
import {
  DIRECTORY_REWARDED_TASKS_MAX_LIMIT,
  directoryRewardedTasksLimit,
  getDirectoryRewardedTasksDocument,
} from "../server/repositories/directory-rewarded-tasks.js";

const publicIdentities = [
  {
    accountId: "acct_public_operator",
    walletAddress: "rPublicOperatorWallet",
    hiveHandle: "public-operator",
    publicAliases: [{ handle: "public-operator" }],
  },
];

const queryCalls = [];
const queryImpl = async (sql, params = []) => {
  queryCalls.push({ sql, params });
  assert.deepEqual(params[0], ["acct_public_operator"]);
  assert.match(sql, /FROM task_projections p/);
  assert.match(sql, /JOIN visible_accounts visible/);
  assert.match(sql, /network_project_task_refs refs/);
  assert.match(sql, /reward_actual_pft > 0/);
  if (params[1] === "personal") {
    return {
      rows: [{
        task_id: "task_personal_rewarded",
        account_id: "acct_public_operator",
        subject_wallet: "rPublicOperatorWallet",
        task_kind: "personal",
        title: "Personal rewarded task",
        description: "Public profile task summary.",
        reward_actual_pft: "7.5",
        request_bundle_cid: "bafyPersonalRequest",
        last_event_tx_hash: "tx_personal_reward",
        last_event_cid: "bafyPersonalReward",
        event_count: 3,
        last_event_at: "2026-06-18T12:00:00.000Z",
        updated_at: "2026-06-18T12:00:00.000Z",
        project_id: "",
        project_ref_source: "",
        project_title: "",
        latest_event_tx_hash: "tx_personal_reward",
        latest_event_cid: "bafyPersonalReward",
        latest_event_at: "2026-06-18T12:00:00.000Z",
      }],
    };
  }
  return {
    rows: [{
      task_id: "task_network_rewarded",
      account_id: "acct_public_operator",
      subject_wallet: "rPublicOperatorWallet",
      task_kind: "network",
      title: "Network rewarded task",
      description: "Public network task summary.",
      reward_actual_pft: "42",
      request_bundle_cid: "bafyNetworkRequest",
      last_event_tx_hash: "tx_network_reward",
      last_event_cid: "bafyNetworkReward",
      event_count: 5,
      last_event_at: "2026-06-18T13:00:00.000Z",
      updated_at: "2026-06-18T13:00:00.000Z",
      project_id: "project_core",
      project_ref_source: "network_task_generation",
      project_title: "Task Node Core Product",
      latest_event_tx_hash: "tx_network_reward",
      latest_event_cid: "bafyNetworkReward",
      latest_event_at: "2026-06-18T13:00:00.000Z",
    }],
  };
};

const evaluationPacketReader = async ({ taskIds }) => {
  assert.deepEqual(taskIds, ["task_network_rewarded"]);
  return [{
    id: "evalpkt_network_rewarded",
    taskId: "task_network_rewarded",
    packetStatus: "ready",
    evaluatorId: "evidence_evaluation_orc",
    summary: "Public evidence packet summary.",
    recommendation: "Needs no follow-up.",
    sourceDigest: "sha256:evaluation",
    updatedAt: "2026-06-18T14:00:00.000Z",
  }];
};

assert.equal(directoryRewardedTasksLimit(99999), DIRECTORY_REWARDED_TASKS_MAX_LIMIT);
assert.equal(directoryRewardedTasksLimit(0), 100);

const networkDocument = await getDirectoryRewardedTasksDocument({
  taskKind: "network",
  limit: 10,
  identityProvider: publicIdentities,
  queryImpl,
  databaseReady: true,
  evaluationPacketReader,
});

assert.equal(networkDocument.ok, true);
assert.equal(networkDocument.taskKind, "network");
assert.equal(networkDocument.tasks.length, 1);
assert.equal(networkDocument.tasks[0].taskId, "task_network_rewarded");
assert.equal(networkDocument.tasks[0].operator.handle, "public-operator");
assert.equal(networkDocument.tasks[0].operator.wallet, "rPublicOperatorWallet");
assert.equal(networkDocument.tasks[0].rewardActualPft, 42);
assert.equal(networkDocument.tasks[0].requestBundleCid, "bafyNetworkRequest");
assert.equal(networkDocument.tasks[0].lastEvent.cid, "bafyNetworkReward");
assert.equal(networkDocument.tasks[0].eventCount, 5);
assert.equal(networkDocument.tasks[0].hiveTaskDetailUrl, "/api/hive/task-detail?taskId=task_network_rewarded");
assert.equal(networkDocument.tasks[0].evaluationPacket.summary, "Public evidence packet summary.");
assert.equal(networkDocument.policy.privateEvidence, "excluded");

const personalDocument = await getDirectoryRewardedTasksDocument({
  taskKind: "personal",
  identityProvider: publicIdentities,
  queryImpl,
  databaseReady: true,
  evaluationPacketReader: async () => [],
});
assert.equal(personalDocument.tasks[0].taskKind, "personal");
assert.equal(personalDocument.tasks[0].hiveTaskDetailUrl, "");

const invalidDocument = await getDirectoryRewardedTasksDocument({
  taskKind: "admin",
  identityProvider: publicIdentities,
  queryImpl,
  databaseReady: true,
});
assert.equal(invalidDocument.ok, false);
assert.equal(invalidDocument.status, 400);

function captureJson(res, status, body) {
  res.status = status;
  res.body = body;
}

const routeResponse = {};
const handled = await handleDirectoryRoute({
  json: captureJson,
  req: { method: "GET" },
  res: routeResponse,
  session: null,
  url: new URL("https://tasknode.local/api/directory/rewarded-tasks?taskKind=network&limit=2"),
  rewardedTasksReader: async ({ taskKind, limit }) => {
    assert.equal(taskKind, "network");
    assert.equal(limit, "2");
    return { ok: true, taskKind, limit: 2, tasks: [], totals: { rewardActualPft: 0 } };
  },
});
assert.equal(handled, true);
assert.equal(routeResponse.status, 200);
assert.equal(routeResponse.body.ok, true);

const invalidRouteResponse = {};
await handleDirectoryRoute({
  json: captureJson,
  req: { method: "GET" },
  res: invalidRouteResponse,
  session: null,
  url: new URL("https://tasknode.local/api/directory/rewarded-tasks?taskKind=private"),
  rewardedTasksReader: async () => {
    throw new Error("invalid route should not call reader");
  },
});
assert.equal(invalidRouteResponse.status, 400);
assert.equal(invalidRouteResponse.body.error, "directory_rewarded_tasks_invalid_task_kind");

console.log("directory rewarded tasks smoke ok");
