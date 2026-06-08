import assert from "node:assert/strict";

import {
  incomingTaskStateIsStale,
  mergeAppStateWithMonotonicTasks,
  taskStateVersionMs,
} from "../src/features/tasks/task-app-state-refresh.js";

function appState({
  generatedAt = "2026-06-08T01:00:40.000Z",
  handoffState = "none",
  projectionCount = 0,
  taskSyncVersion = "2026-06-08T01:00:40.000Z",
} = {}) {
  return {
    generatedAt,
    session: { status: "signed_in" },
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
          walletAddress: "rMonotonicWallet",
        },
      },
      sync: {
        handoff: {
          requestHandoffState: handoffState,
          latestRequestUpdatedAt: taskSyncVersion,
        },
        projectionCount,
        taskSyncVersion,
        walletAddress: "rMonotonicWallet",
      },
    },
    wallet: { pftWallet: { status: "linked", address: "rMonotonicWallet" } },
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

const sameVersionLowerHandoff = appState({
  handoffState: "failed",
  projectionCount: 12,
  taskSyncVersion: "2026-06-08T01:00:36.000Z",
});
assert.equal(incomingTaskStateIsStale(fresh, sameVersionLowerHandoff), true);

console.log("task app-state refresh smoke ok");
