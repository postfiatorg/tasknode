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

export function taskRefreshPolicy({
  activeRequestCount = 0,
  legacyRefreshNeeded = false,
  nextPollMs = null,
  nowMs = Date.now(),
  settleUntilMs = 0,
  taskSyncRequiresRefresh = false,
  taskSyncStatus = "ready",
} = {}) {
  const syncStatus = String(taskSyncStatus || "ready");
  const shouldRefreshTaskProjection = syncStatus === "indexing_lag" || syncStatus === "reducer_attention";
  const requestCount = Number(activeRequestCount || 0);
  const taskRequestSettling = Number(settleUntilMs || 0) > Number(nowMs || 0);
  const shouldForceTaskProjection = Boolean(
    shouldRefreshTaskProjection ||
      requestCount > 0 ||
      taskRequestSettling
  );
  const shouldRefreshTaskState = Boolean(
    shouldRefreshTaskProjection ||
      taskSyncRequiresRefresh ||
      requestCount > 0 ||
      legacyRefreshNeeded ||
      taskRequestSettling
  );
  const pollMs = Math.min(
    Math.max(Number(nextPollMs || TASK_REQUEST_SETTLE_POLL_MS), 1000),
    30000
  );

  return {
    shouldForceTaskProjection,
    shouldRefreshTaskProjection,
    shouldRefreshTaskState,
    taskRefreshMs: pollMs,
    taskRequestSettling,
  };
}
