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

export function startBackgroundWorkerKeepalive({
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  intervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
} = {}) {
  if (keepaliveHandle) return backgroundWorkerLivenessStatus();
  keepaliveHandle = setIntervalImpl(() => {}, intervalMs);
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
