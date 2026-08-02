const DEFAULT_KEEPALIVE_INTERVAL_MS = 60_000;
const KEEPALIVE_NAME = "background_worker_liveness_keepalive";

let keepaliveHandle = null;
let clearKeepalive = clearInterval;

function handleType(handle) {
  return handle?.constructor?.name || "Unknown";
}

function handleReferenced(handle) {
  return typeof handle?.hasRef === "function" ? handle.hasRef() : true;
}

export function backgroundWorkerLivenessStatus() {
  return {
    active: Boolean(keepaliveHandle),
    heldHandle: keepaliveHandle
      ? {
          name: KEEPALIVE_NAME,
          type: handleType(keepaliveHandle),
          referenced: handleReferenced(keepaliveHandle),
        }
      : null,
  };
}

export function backgroundWorkerLivenessSelfCheck({ role = "", startup = {}, liveness = {} } = {}) {
  return {
    role: String(role || ""),
    heldHandle: liveness.heldHandle || null,
    startedWorkerGroups: Array.isArray(startup.startedWorkerGroups) ? [...startup.startedWorkerGroups] : [],
  };
}

// ---------------------------------------------------------------------------
// Worker-group heartbeat primitives (dependency-injectable, deterministic).
//
// Storage is in-process unless an existing generic durable status facility is
// supplied. No schema/migration ownership was granted for this workstream, and
// no suitable generic status table currently exists (checked migrations
// 001-097; the orc_runtime_directives table is a queue/claim primitive, not a
// status facility). Heartbeat storage never takes timers or module-load side
// effects, and a storage write failure never throws to the caller.
// ---------------------------------------------------------------------------

export const WORKER_HEARTBEAT_GROUPS = [
  "app",
  "board-secretary",
  "worker-pftl",
  "worker-taskgen",
  "worker-task-review",
  "worker-context-rewrite",
  "worker-hive",
  "worker-memory-profile",
  "worker-airdrop",
];

export const DEFAULT_WORKER_HEARTBEAT_STALE_AFTER_MS = 5 * 60_000;

const DEFAULT_GROUP_THRESHOLDS_MS = {
  app: 2 * 60_000,
  "board-secretary": DEFAULT_WORKER_HEARTBEAT_STALE_AFTER_MS,
  "worker-pftl": DEFAULT_WORKER_HEARTBEAT_STALE_AFTER_MS,
  "worker-taskgen": 5 * 60_000,
  "worker-task-review": 5 * 60_000,
  "worker-context-rewrite": 10 * 60_000,
  "worker-hive": 10 * 60_000,
  "worker-memory-profile": 10 * 60_000,
  "worker-airdrop": 30 * 60_000,
};

const heartbeats = new Map();

function normalizeGroup(value) {
  return String(value || "").trim();
}

export function inferWorkerGroup(env = process.env) {
  const raw = normalizeGroup(env.FLY_PROCESS_GROUP || env.TASKNODE_PROCESS_ROLE || "app").toLowerCase() || "app";
  return {
    web: "app",
    api: "app",
    "worker:pftl": "worker-pftl",
    "worker:taskgen": "worker-taskgen",
    "worker:task-review": "worker-task-review",
    "worker:context-rewrite": "worker-context-rewrite",
    "worker:hive": "worker-hive",
    "worker:memory-profile": "worker-memory-profile",
    "worker:airdrop": "worker-airdrop",
  }[raw] || raw;
}

export function workerHeartbeatScope({ selfGroup = inferWorkerGroup() } = {}) {
  return {
    scope: "this_process_only",
    selfGroup: normalizeGroup(selfGroup),
    crossProcessHeartbeats: "unavailable_round1",
  };
}

// Honest database durability label. There is no reused generic durable status
// facility in this workstream: when a database is configured but no such
// facility exists we report db_unavailable; when it is disabled entirely we
// report database_disabled. Identical to the pool eligibility intent.
export function workerHeartbeatDatabaseState(env = process.env) {
  const url = String(env.DATABASE_URL || "").trim();
  const explicitlyDisabled =
    env.TASKNODE_DATABASE_DISABLED === "true" || env.TASKNODE_POSTGRES_DISABLED === "true";
  if (!url || explicitlyDisabled) return "database_disabled";
  const enabled = env.TASKNODE_DATABASE_ENABLED === "true" || env.TASKNODE_POSTGRES_ENABLED === "true";
  return enabled ? "db_unavailable" : "database_disabled";
}

function storageErrorShape(error) {
  return error ? String(error?.message || error) : "unknown_storage_error";
}

function thresholdFor(group, thresholdsMs) {
  const th = thresholdsMs && typeof thresholdsMs === "object" ? thresholdsMs : DEFAULT_GROUP_THRESHOLDS_MS;
  return Number(th[group]) > 0 ? Number(th[group]) : DEFAULT_WORKER_HEARTBEAT_STALE_AFTER_MS;
}

function coverageForGroup(group, selfGroup) {
  return group === selfGroup ? "self" : "unobserved";
}

function buildEntry({ group, entry, nowMs, thresholdsMs, source, selfGroup }) {
  const database = workerHeartbeatDatabaseState();
  const coverage = coverageForGroup(group, selfGroup);
  if (!entry || entry.lastTickAt == null) {
    return {
      group,
      lastTickAt: null,
      ageMs: null,
      stale: true,
      thresholdMs: thresholdFor(group, thresholdsMs),
      availability: "missing",
      coverage,
      storage: { source, database },
    };
  }
  const ageMs = nowMs - entry.lastTickAt;
  const thresholdMs = thresholdFor(group, thresholdsMs);
  return {
    group,
    lastTickAt: new Date(entry.lastTickAt).toISOString(),
    ageMs: Math.max(0, ageMs),
    stale: ageMs > thresholdMs,
    thresholdMs,
    availability: "available",
    coverage,
    storage: { source, database },
  };
}

function readExternal(store, groups) {
  if (!store || typeof store.readAll !== "function") return [];
  try {
    const stored = store.readAll({ groups });
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/**
 * Record the last tick for a process group at `nowMs` (injected clock, or
 * Date.now when none is provided). Writes go through the optional `store.write`
 * hook. Never throws: storage failures are recorded in the returned metadata
 * and never crash a worker. The in-process mirror always tracks the latest tick
 * so readers still observe freshness for the current process.
 */
export function recordWorkerGroupHeartbeat({
  group,
  nowMs = null,
  groups = WORKER_HEARTBEAT_GROUPS,
  store = null,
  thresholdsMs = null,
} = {}) {
  const normalized = normalizeGroup(group);
  if (!normalized) return { ok: false, error: "missing_group" };
  const tickAtMs = nowMs == null ? Date.now() : nowMs;
  const entry = {
    group: normalized,
    lastTickAt: tickAtMs,
    recordedAtMs: Date.now(),
  };
  let storageSource = "in_process";
  let error = null;

  if (store && typeof store.write === "function") {
    try {
      store.write({ entry, groups, thresholdsMs });
      if (store.source) storageSource = store.source;
    } catch (writeError) {
      error = storageErrorShape(writeError);
    }
  }

  heartbeats.set(normalized, { ...entry, source: storageSource, storageError: error });

  return {
    ok: true,
    group: normalized,
    lastTickAtMs: tickAtMs,
    source: storageSource,
    database: workerHeartbeatDatabaseState(),
    error,
  };
}

/**
 * Read the current heartbeat snapshot for every configured group, computing
 * age/staleness with an injected clock. Each entry uses the unified wire shape
 * {group,lastTickAt,ageMs,stale,thresholdMs,availability,storage}.
 */
export function readWorkerGroupHeartbeats({
  now = Date.now,
  groups = WORKER_HEARTBEAT_GROUPS,
  thresholdsMs = null,
  store = null,
  selfGroup = inferWorkerGroup(),
} = {}) {
  const nowMs = typeof now === "function" ? now() : now;
  const storageSource = store && store.source ? store.source : "in_process";
  const normalizedSelfGroup = normalizeGroup(selfGroup);

  const combined = new Map(heartbeats);
  for (const entry of readExternal(store, groups)) {
    if (!entry || !normalizeGroup(entry.group)) continue;
    const group = normalizeGroup(entry.group);
    if (entry.lastTickAt == null) continue;
    if (!combined.has(group) || combined.get(group).lastTickAt < entry.lastTickAt) {
      combined.set(group, { group, lastTickAt: entry.lastTickAt, source: entry.source || storageSource });
    }
  }

  return groups.map((group) => {
    const entry = combined.get(group);
    return buildEntry({
      group,
      entry,
      nowMs,
      thresholdsMs,
      source: entry && entry.source ? entry.source : storageSource,
      selfGroup: normalizedSelfGroup,
    });
  });
}

export function readWorkerGroupHeartbeat({
  group,
  now = Date.now,
  groups = WORKER_HEARTBEAT_GROUPS,
  thresholdsMs = null,
  store = null,
  selfGroup = inferWorkerGroup(),
} = {}) {
  const normalized = normalizeGroup(group);
  const all = readWorkerGroupHeartbeats({ now, groups, thresholdsMs, store, selfGroup });
  return all.find((entry) => entry.group === normalized) || buildEntry({
    group: normalized,
    entry: null,
    nowMs: typeof now === "function" ? now() : now,
    thresholdsMs,
    source: store && store.source ? store.source : "in_process",
    selfGroup: normalizeGroup(selfGroup),
  });
}

export function resetWorkerHeartbeatsForTests() {
  heartbeats.clear();
}

// ---------------------------------------------------------------------------
// Keepalive: records a real heartbeat on start and on each interval tick.
// ---------------------------------------------------------------------------

export function startBackgroundWorkerKeepalive({
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  intervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
  group = null,
  now = Date.now,
  store = null,
} = {}) {
  if (keepaliveHandle) return backgroundWorkerLivenessStatus();
  const processGroup = normalizeGroup(group) || inferWorkerGroup();
  const nowValue = () => (typeof now === "function" ? now() : now);
  const tick = () => {
    // Storage errors never escape a worker tick.
    try {
      recordWorkerGroupHeartbeat({ group: processGroup, nowMs: nowValue(), store });
    } catch {
      // ignored: a failed tick must not crash the worker or the interval.
    }
  };
  tick();
  keepaliveHandle = setIntervalImpl(tick, intervalMs);
  clearKeepalive = clearIntervalImpl;
  return backgroundWorkerLivenessStatus();
}

export function stopBackgroundWorkerKeepalive() {
  if (keepaliveHandle) clearKeepalive(keepaliveHandle);
  keepaliveHandle = null;
  clearKeepalive = clearInterval;
  return backgroundWorkerLivenessStatus();
}

export function resetBackgroundWorkerKeepaliveForTests() {
  return stopBackgroundWorkerKeepalive();
}
