import assert from "node:assert/strict";
import {
  TASK_REQUEST_SETTLE_POLL_MS,
  TASK_REQUEST_SETTLE_WINDOW_MS,
  settledTaskRequestHasVisibleOutstanding,
  shouldRevealSettledOutstandingTask,
  shouldForceTaskSyncNotice,
  shouldStartTaskRequestSettle,
  taskRefreshPolicy,
  taskRequestSettleDeadline,
} from "../src/features/tasks/task-refresh-policy.js";

const nowMs = 1_000_000;

assert.equal(taskRequestSettleDeadline(nowMs), nowMs + TASK_REQUEST_SETTLE_WINDOW_MS);
assert.equal(shouldStartTaskRequestSettle({
  previousActiveRequestCount: 1,
  currentActiveRequestCount: 0,
}), true);
assert.equal(shouldStartTaskRequestSettle({
  previousActiveRequestCount: 0,
  currentActiveRequestCount: 0,
}), false);
assert.equal(shouldStartTaskRequestSettle({
  previousActiveRequestCount: 1,
  currentActiveRequestCount: 1,
}), false);

const activeRequest = taskRefreshPolicy({
  activeRequestCount: 1,
  nowMs,
  taskSyncStatus: "empty",
});
assert.equal(activeRequest.shouldRefreshTaskState, true);
assert.equal(activeRequest.shouldForceTaskProjection, true);
assert.equal(activeRequest.taskRefreshMs, TASK_REQUEST_SETTLE_POLL_MS);

const settlingRequest = taskRefreshPolicy({
  activeRequestCount: 0,
  nowMs,
  settleUntilMs: nowMs + 1,
  taskSyncStatus: "empty",
});
assert.equal(settlingRequest.shouldRefreshTaskState, true);
assert.equal(settlingRequest.shouldForceTaskProjection, true);
assert.equal(settlingRequest.taskRequestSettling, true);

const expiredSettle = taskRefreshPolicy({
  activeRequestCount: 0,
  nowMs,
  settleUntilMs: nowMs - 1,
  taskSyncStatus: "empty",
});
assert.equal(expiredSettle.shouldRefreshTaskState, false);
assert.equal(expiredSettle.shouldForceTaskProjection, false);

const pendingGeneratedProjection = taskRefreshPolicy({
  activeRequestCount: 0,
  handoffProjectionPending: true,
  nowMs,
  taskSyncStatus: "ready",
});
assert.equal(pendingGeneratedProjection.shouldRefreshTaskState, true);
assert.equal(pendingGeneratedProjection.shouldForceTaskProjection, true);
assert.equal(pendingGeneratedProjection.handoffProjectionPending, true);

const reviewLoopRefresh = taskRefreshPolicy({
  activeRequestCount: 0,
  nowMs,
  taskSyncRequiresRefresh: true,
  taskSyncStatus: "ready",
});
assert.equal(reviewLoopRefresh.shouldRefreshTaskState, true);
assert.equal(reviewLoopRefresh.shouldForceTaskProjection, true);

const legacyReviewLoopRefresh = taskRefreshPolicy({
  activeRequestCount: 0,
  legacyRefreshNeeded: true,
  nowMs,
  taskSyncStatus: "ready",
});
assert.equal(legacyReviewLoopRefresh.shouldRefreshTaskState, true);
assert.equal(legacyReviewLoopRefresh.shouldForceTaskProjection, true);

const indexingLag = taskRefreshPolicy({
  activeRequestCount: 0,
  nowMs,
  nextPollMs: 500,
  taskSyncStatus: "indexing_lag",
});
assert.equal(indexingLag.shouldRefreshTaskState, true);
assert.equal(indexingLag.shouldRefreshTaskProjection, true);
assert.equal(indexingLag.shouldForceTaskProjection, true);
assert.equal(indexingLag.taskRefreshMs, 1000);
assert.equal(shouldForceTaskSyncNotice({ status: "indexing_lag", indexingLagCount: 1 }), false);
assert.equal(shouldForceTaskSyncNotice({ status: "indexing_lag", indexingLagCount: 4 }), true);
assert.equal(shouldForceTaskSyncNotice({ status: "reducer_attention", failedReducerCount: 1 }), true);

assert.equal(settledTaskRequestHasVisibleOutstanding({
  outstandingCount: 1,
  taskRequestSettling: true,
}), true);
assert.equal(shouldRevealSettledOutstandingTask({
  currentTab: "rewarded",
  outstandingCount: 1,
  taskRequestSettling: true,
}), true);
assert.equal(shouldRevealSettledOutstandingTask({
  currentTab: "outstanding",
  outstandingCount: 1,
  taskRequestSettling: true,
}), false);
assert.equal(shouldRevealSettledOutstandingTask({
  currentTab: "rewarded",
  outstandingCount: 0,
  taskRequestSettling: true,
}), false);

console.log("task refresh policy smoke ok");
