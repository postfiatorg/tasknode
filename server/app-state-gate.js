const DEFAULT_MAX_CONCURRENT_APP_STATE = 6;

let activeComputes = 0;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function appStateMaxConcurrent() {
  return positiveInteger(process.env.APP_STATE_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT_APP_STATE);
}

export function tryAcquireAppStateCompute({ allowOverflow = false } = {}) {
  const maxConcurrent = appStateMaxConcurrent();
  if (!allowOverflow && activeComputes >= maxConcurrent) {
    return null;
  }

  activeComputes += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeComputes = Math.max(0, activeComputes - 1);
  };
}

export function appStateGateSnapshot() {
  return {
    activeComputes,
    maxConcurrent: appStateMaxConcurrent(),
  };
}

export function __resetAppStateGateForTests() {
  activeComputes = 0;
}
