export const TASK_REQUEST_SETTLE_POLL_MS = 2500;
export const TASK_REQUEST_SETTLE_WINDOW_MS = 90_000;

export function taskRequestSettleDeadline(nowMs = Date.now()) {
  return Number(nowMs || 0) + TASK_REQUEST_SETTLE_WINDOW_MS;
}

export function shouldStartTaskRequestSettle({
  previousActiveRequestCount = 0,
  currentActiveRequestCount = 0,
} = {}) {
  return Number(previousActiveRequestCount || 0) > 0 && Number(currentActiveRequestCount || 0) === 0;
}

export function settledTaskRequestHasVisibleOutstanding({
  outstandingCount = 0,
  taskRequestSettling = false,
} = {}) {
  return Boolean(taskRequestSettling && Number(outstandingCount || 0) > 0);
}

export function shouldRevealSettledOutstandingTask({
  currentTab = "outstanding",
  outstandingCount = 0,
  taskRequestSettling = false,
} = {}) {
  return settledTaskRequestHasVisibleOutstanding({
    outstandingCount,
    taskRequestSettling,
  }) && String(currentTab || "outstanding") !== "outstanding";
}

export const TASK_READ_FAILURE_BACKOFF_STEPS_MS = Object.freeze([5000, 10000, 30000]);

// Pure exponential backoff for temporary task-read failures
// (database_error/integrity_unavailable): 5s -> 10s -> 30s cap, reset by the
// caller on the first healthy response.
export function taskReadFailureBackoffMs(readFailureCount = 0) {
  const failures = Math.floor(Number(readFailureCount || 0));
  if (failures <= 0) return 0;
  return TASK_READ_FAILURE_BACKOFF_STEPS_MS[
    Math.min(failures, TASK_READ_FAILURE_BACKOFF_STEPS_MS.length) - 1
  ];
}

export function taskRefreshPolicy({
  directOffchain = false,
  handoffProjectionPending = false,
  legacyRefreshNeeded = false,
  nextPollMs = null,
  nowMs = Date.now(),
  processingRequestCount = 0,
  settleUntilMs = 0,
  taskReadFailureCount = 0,
  taskSyncForceProjection = false,
  taskSyncRequiresRefresh = false,
  taskSyncStatus = "ready",
} = {}) {
  const syncStatus = String(taskSyncStatus || "ready");
  // A failing projection read is not fixed by a forced sync+reduce write pass;
  // it only needs patient re-reads, so it never forces projection refresh.
  const temporaryReadFailure = syncStatus === "database_error" ||
    syncStatus === "integrity_unavailable";
  const shouldRefreshTaskProjection = (!directOffchain && syncStatus === "indexing_lag") ||
    syncStatus === "reducer_attention";
  const requestCount = Number(processingRequestCount || 0);
  const taskRequestSettling = Number(settleUntilMs || 0) > Number(nowMs || 0);
  const projectionPendingHandoff = Boolean(handoffProjectionPending);
  const shouldForceTaskProjection = Boolean(
    shouldRefreshTaskProjection ||
      requestCount > 0 ||
      projectionPendingHandoff ||
      taskRequestSettling ||
      taskSyncForceProjection ||
      legacyRefreshNeeded
  );
  const shouldRefreshTaskState = Boolean(
    shouldForceTaskProjection ||
      taskSyncRequiresRefresh ||
      temporaryReadFailure
  );
  const basePollMs = Math.min(
    Math.max(Number(nextPollMs || TASK_REQUEST_SETTLE_POLL_MS), 1000),
    30000
  );
  const pollMs = temporaryReadFailure
    ? Math.min(
      Math.max(basePollMs, taskReadFailureBackoffMs(Math.max(Number(taskReadFailureCount || 0), 1))),
      30000
    )
    : basePollMs;

  return {
    shouldForceTaskProjection,
    shouldRefreshTaskProjection,
    shouldRefreshTaskState,
    handoffProjectionPending: projectionPendingHandoff,
    taskRefreshMs: pollMs,
    taskRequestSettling,
    temporaryReadFailure,
  };
}

export function shouldForceTaskSyncNotice(sync = {}, { directOffchain = false } = {}) {
  const status = String(sync?.status || "ready");
  if (status === "database_error" || status === "integrity_unavailable") return true;
  if (status === "reducer_attention") return true;
  if (directOffchain && status === "indexing_lag") return false;
  return status === "indexing_lag" && Number(sync?.indexingLagCount || 0) > 3;
}
