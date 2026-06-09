import assert from "node:assert/strict";

import {
  incomingTaskStateIsStale,
  mergeAppStateWithMonotonicTasks,
  taskStateVersionMs,
} from "../src/features/tasks/task-app-state-refresh.js";

function appState({
  accountId = "acct_monotonic",
  generatedAt = "2026-06-08T01:00:40.000Z",
  handoffState = "none",
  projectionCount = 0,
  taskSyncVersion = "2026-06-08T01:00:40.000Z",
  walletAddress = "rMonotonicWallet",
} = {}) {
  return {
    generatedAt,
    session: { status: "signed_in", accountId },
    tasks: {
      outstanding: Array.from({ length: projectionCount }, (_, index) => ({
        taskId: `task_${index}`,
        statusKey: index === 0 ? "proposed" : "accepted",
      })),
      verification: [],
      refused: [],
      rewarded: [],
      requests: {
        items: [],
        sync: {
          lastUpdatedAt: taskSyncVersion,
          walletAddress,
        },
      },
      sync: {
        handoff: {
          requestHandoffState: handoffState,
          latestRequestUpdatedAt: taskSyncVersion,
        },
        projectionCount,
        taskSyncVersion,
        walletAddress,
      },
    },
    wallet: { pftWallet: { status: walletAddress ? "linked" : "not_linked", address: walletAddress || null } },
  };
}

const fresh = appState({
  handoffState: "generated_visible",
  projectionCount: 12,
  taskSyncVersion: "2026-06-08T01:00:36.000Z",
});
const staleRpcBroken = appState({
  generatedAt: "2026-06-08T01:00:45.000Z",
  handoffState: "failed",
  projectionCount: 11,
  taskSyncVersion: "2026-06-08T01:00:15.000Z",
});

assert.equal(taskStateVersionMs(fresh), Date.parse("2026-06-08T01:00:36.000Z"));
assert.equal(incomingTaskStateIsStale(fresh, staleRpcBroken), true);

const merged = mergeAppStateWithMonotonicTasks(fresh, staleRpcBroken, {
  mergeBase: (_current, incoming) => ({
    ...incoming,
    wallet: { refreshed: true },
  }),
});
assert.equal(merged.tasks.sync.projectionCount, 12);
assert.equal(merged.tasks.sync.handoff.requestHandoffState, "generated_visible");
assert.equal(merged.wallet.refreshed, true);

const newerGenerated = appState({
  handoffState: "generated_visible",
  projectionCount: 13,
  taskSyncVersion: "2026-06-08T01:01:00.000Z",
});
assert.equal(incomingTaskStateIsStale(fresh, newerGenerated), false);

const sameVersionLowerProjection = appState({
  handoffState: "generated_visible",
  projectionCount: 11,
  taskSyncVersion: "2026-06-08T01:00:36.000Z",
});
assert.equal(incomingTaskStateIsStale(fresh, sameVersionLowerProjection), true);

const temporaryReadFailure = appState({
  generatedAt: "2026-06-08T01:02:00.000Z",
  handoffState: "none",
  projectionCount: 0,
  taskSyncVersion: "",
});
temporaryReadFailure.tasks.sync.status = "database_error";
temporaryReadFailure.tasks.sync.taskSyncVersion = "";
temporaryReadFailure.tasks.sync.lastSyncedAt = null;
temporaryReadFailure.tasks.requests.sync.lastUpdatedAt = null;
temporaryReadFailure.tasks.sync.handoff.latestRequestUpdatedAt = null;
assert.equal(incomingTaskStateIsStale(fresh, temporaryReadFailure), true);
const readFailureMerge = mergeAppStateWithMonotonicTasks(fresh, temporaryReadFailure);
assert.equal(readFailureMerge.tasks.sync.projectionCount, 12);
assert.equal(readFailureMerge.tasks.sync.handoff.requestHandoffState, "generated_visible");

const sameVersionLowerHandoff = appState({
  handoffState: "failed",
  projectionCount: 12,
  taskSyncVersion: "2026-06-08T01:00:36.000Z",
});
assert.equal(incomingTaskStateIsStale(fresh, sameVersionLowerHandoff), true);

const preLinkEmpty = {
  generatedAt: "2026-06-08T12:00:00.000Z",
  session: { status: "signed_in", accountId: "acct_wallet_link" },
  tasks: {
    outstanding: [],
    verification: [],
    refused: [],
    rewarded: [],
    requests: {
      items: [],
      sync: {
        status: "wallet_required",
        walletAddress: "",
      },
    },
    sync: {
      status: "wallet_required",
      projectionCount: 0,
      walletAddress: null,
    },
  },
  wallet: { pftWallet: { status: "not_linked", address: null } },
};
const linkedHistoricalTasks = appState({
  accountId: "acct_wallet_link",
  generatedAt: "2026-06-08T12:00:02.000Z",
  handoffState: "none",
  projectionCount: 47,
  taskSyncVersion: "2026-06-01T23:44:02.000Z",
  walletAddress: "rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE",
});
assert.equal(incomingTaskStateIsStale(preLinkEmpty, linkedHistoricalTasks), false);
const linkedMerge = mergeAppStateWithMonotonicTasks(preLinkEmpty, linkedHistoricalTasks);
assert.equal(linkedMerge.tasks.sync.walletAddress, "rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE");
assert.equal(linkedMerge.tasks.sync.projectionCount, 47);

const otherAccountTasks = appState({
  accountId: "acct_other",
  generatedAt: "2026-06-08T01:00:20.000Z",
  projectionCount: 2,
  taskSyncVersion: "2026-06-08T01:00:20.000Z",
});
assert.equal(incomingTaskStateIsStale(fresh, otherAccountTasks), false);

console.log("task app-state refresh smoke ok");
