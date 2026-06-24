import assert from "node:assert/strict";
import {
  TASK_REQUEST_SETTLE_POLL_MS,
  TASK_REQUEST_SETTLE_WINDOW_MS,
  settledTaskRequestHasVisibleOutstanding,
  shouldRevealSettledOutstandingTask,
  shouldForceTaskSyncNotice,
  shouldStartTaskRequestSettle,
  taskReadFailureBackoffMs,
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
  nowMs,
  processingRequestCount: 1,
  taskSyncStatus: "empty",
});
assert.equal(activeRequest.shouldRefreshTaskState, true);
assert.equal(activeRequest.shouldForceTaskProjection, true);
assert.equal(activeRequest.taskRefreshMs, TASK_REQUEST_SETTLE_POLL_MS);

const settlingRequest = taskRefreshPolicy({
  nowMs,
  processingRequestCount: 0,
  settleUntilMs: nowMs + 1,
  taskSyncStatus: "empty",
});
assert.equal(settlingRequest.shouldRefreshTaskState, true);
assert.equal(settlingRequest.shouldForceTaskProjection, true);
assert.equal(settlingRequest.taskRequestSettling, true);

const expiredSettle = taskRefreshPolicy({
  nowMs,
  processingRequestCount: 0,
  settleUntilMs: nowMs - 1,
  taskSyncStatus: "empty",
});
assert.equal(expiredSettle.shouldRefreshTaskState, false);
assert.equal(expiredSettle.shouldForceTaskProjection, false);

const pendingGeneratedProjection = taskRefreshPolicy({
  handoffProjectionPending: true,
  nowMs,
  processingRequestCount: 0,
  taskSyncStatus: "ready",
});
assert.equal(pendingGeneratedProjection.shouldRefreshTaskState, true);
assert.equal(pendingGeneratedProjection.shouldForceTaskProjection, true);
assert.equal(pendingGeneratedProjection.handoffProjectionPending, true);

// Server slow tier (active-but-idle tasks): requiresRefresh keeps polling at
// the server-suggested 10s cadence, but does not force projection refresh.
const slowTierRefresh = taskRefreshPolicy({
  nextPollMs: 10000,
  nowMs,
  processingRequestCount: 0,
  taskSyncRequiresRefresh: true,
  taskSyncStatus: "ready",
});
assert.equal(slowTierRefresh.shouldRefreshTaskState, true);
assert.equal(slowTierRefresh.shouldForceTaskProjection, false);
assert.equal(slowTierRefresh.taskRefreshMs, 10000);

// Server fast tier carries the explicit force flag.
const forcedReviewLoopRefresh = taskRefreshPolicy({
  nextPollMs: 2500,
  nowMs,
  processingRequestCount: 0,
  taskSyncForceProjection: true,
  taskSyncRequiresRefresh: true,
  taskSyncStatus: "ready",
});
assert.equal(forcedReviewLoopRefresh.shouldRefreshTaskState, true);
assert.equal(forcedReviewLoopRefresh.shouldForceTaskProjection, true);
assert.equal(forcedReviewLoopRefresh.taskRefreshMs, 2500);

const legacyReviewLoopRefresh = taskRefreshPolicy({
  legacyRefreshNeeded: true,
  nowMs,
  processingRequestCount: 0,
  taskSyncStatus: "ready",
});
assert.equal(legacyReviewLoopRefresh.shouldRefreshTaskState, true);
assert.equal(legacyReviewLoopRefresh.shouldForceTaskProjection, true);

const indexingLag = taskRefreshPolicy({
  nowMs,
  nextPollMs: 500,
  processingRequestCount: 0,
  taskSyncStatus: "indexing_lag",
});
assert.equal(indexingLag.shouldRefreshTaskState, true);
assert.equal(indexingLag.shouldRefreshTaskProjection, true);
assert.equal(indexingLag.shouldForceTaskProjection, true);
assert.equal(indexingLag.taskRefreshMs, 1000);
assert.equal(shouldForceTaskSyncNotice({ status: "indexing_lag", indexingLagCount: 1 }), false);
assert.equal(shouldForceTaskSyncNotice({ status: "indexing_lag", indexingLagCount: 4 }), true);
assert.equal(shouldForceTaskSyncNotice({ status: "reducer_attention", failedReducerCount: 1 }), true);

const directOffchainIndexingLag = taskRefreshPolicy({
  directOffchain: true,
  nowMs,
  nextPollMs: 500,
  processingRequestCount: 0,
  taskSyncStatus: "indexing_lag",
});
assert.equal(directOffchainIndexingLag.shouldRefreshTaskProjection, false);
assert.equal(directOffchainIndexingLag.shouldForceTaskProjection, false);
assert.equal(directOffchainIndexingLag.shouldRefreshTaskState, false);
assert.equal(shouldForceTaskSyncNotice({ status: "indexing_lag", indexingLagCount: 4 }, { directOffchain: true }), false);

// database_error/integrity_unavailable keep polling without forcing the
// projection write pass, and back off exponentially: 5s -> 10s -> 30s cap.
assert.equal(taskReadFailureBackoffMs(0), 0);
assert.equal(taskReadFailureBackoffMs(1), 5000);
assert.equal(taskReadFailureBackoffMs(2), 10000);
assert.equal(taskReadFailureBackoffMs(3), 30000);
assert.equal(taskReadFailureBackoffMs(9), 30000);

const databaseErrorFirstFailure = taskRefreshPolicy({
  nextPollMs: 5000,
  nowMs,
  processingRequestCount: 0,
  taskReadFailureCount: 1,
  taskSyncRequiresRefresh: true,
  taskSyncStatus: "database_error",
});
assert.equal(databaseErrorFirstFailure.shouldRefreshTaskState, true);
assert.equal(databaseErrorFirstFailure.shouldRefreshTaskProjection, false);
assert.equal(databaseErrorFirstFailure.shouldForceTaskProjection, false);
assert.equal(databaseErrorFirstFailure.temporaryReadFailure, true);
assert.equal(databaseErrorFirstFailure.taskRefreshMs, 5000);

const databaseErrorSecondFailure = taskRefreshPolicy({
  nextPollMs: 5000,
  nowMs,
  taskReadFailureCount: 2,
  taskSyncRequiresRefresh: true,
  taskSyncStatus: "database_error",
});
assert.equal(databaseErrorSecondFailure.taskRefreshMs, 10000);
assert.equal(databaseErrorSecondFailure.shouldForceTaskProjection, false);

const databaseErrorSustainedFailure = taskRefreshPolicy({
  nextPollMs: 5000,
  nowMs,
  taskReadFailureCount: 5,
  taskSyncRequiresRefresh: true,
  taskSyncStatus: "database_error",
});
assert.equal(databaseErrorSustainedFailure.taskRefreshMs, 30000);

// The server-suggested cadence is a floor: a 5s suggestion is never clamped
// down to the 2.5s tier, even before the failure counter catches up.
const databaseErrorNoCounterYet = taskRefreshPolicy({
  nextPollMs: 5000,
  nowMs,
  taskReadFailureCount: 0,
  taskSyncRequiresRefresh: true,
  taskSyncStatus: "integrity_unavailable",
});
assert.equal(databaseErrorNoCounterYet.taskRefreshMs, 5000);
assert.equal(databaseErrorNoCounterYet.shouldForceTaskProjection, false);

// Recovery: a healthy snapshot resets to the normal policy.
const recoveredAfterFailure = taskRefreshPolicy({
  nextPollMs: 10000,
  nowMs,
  taskReadFailureCount: 0,
  taskSyncRequiresRefresh: true,
  taskSyncStatus: "ready",
});
assert.equal(recoveredAfterFailure.temporaryReadFailure, false);
assert.equal(recoveredAfterFailure.taskRefreshMs, 10000);

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
