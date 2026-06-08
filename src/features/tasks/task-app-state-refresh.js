function parseTimestampMs(value = "") {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function taskWalletAddress(tasks = {}) {
  return tasks?.sync?.walletAddress || tasks?.requests?.sync?.walletAddress || "";
}

function handoffRank(handoff = {}) {
  const state = String(handoff?.requestHandoffState || "").trim();
  return {
    none: 0,
    waiting: 1,
    published: 2,
    queued: 2,
    signing: 2,
    generating: 3,
    failed: 4,
    generated_projection_pending: 5,
    generated_visible: 6,
    terminal: 6,
  }[state] ?? 0;
}

export function taskStateVersionMs(appState = {}) {
  const tasks = appState?.tasks || {};
  const sync = tasks?.sync || {};
  const requestsSync = tasks?.requests?.sync || {};
  const handoff = sync?.handoff || {};
  const candidates = [
    sync.taskSyncVersion,
    sync.lastSyncedAt,
    requestsSync.lastUpdatedAt,
    handoff.latestRequestUpdatedAt,
  ].map(parseTimestampMs).filter((value) => value !== null);

  if (candidates.length) return Math.max(...candidates);
  return parseTimestampMs(appState?.generatedAt);
}

export function incomingTaskStateIsStale(current = null, next = null) {
  if (!current?.tasks || !next?.tasks) return false;

  const currentWallet = taskWalletAddress(current.tasks);
  const nextWallet = taskWalletAddress(next.tasks);
  if (currentWallet && nextWallet && currentWallet !== nextWallet) return false;

  const currentVersion = taskStateVersionMs(current);
  const nextVersion = taskStateVersionMs(next);
  if (currentVersion !== null && nextVersion !== null && nextVersion < currentVersion) return true;

  const currentProjectionCount = numeric(current.tasks?.sync?.projectionCount);
  const nextProjectionCount = numeric(next.tasks?.sync?.projectionCount);
  if (currentVersion === nextVersion && nextProjectionCount < currentProjectionCount) return true;

  const currentHandoffRank = handoffRank(current.tasks?.sync?.handoff);
  const nextHandoffRank = handoffRank(next.tasks?.sync?.handoff);
  return currentVersion === nextVersion && nextHandoffRank < currentHandoffRank;
}

export function mergeAppStateWithMonotonicTasks(current = null, next = null, {
  mergeBase = (_current, incoming) => incoming,
} = {}) {
  const merged = mergeBase(current, next);
  if (!incomingTaskStateIsStale(current, next)) return merged;
  return {
    ...merged,
    tasks: current.tasks,
  };
}
