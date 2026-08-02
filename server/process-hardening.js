const PROCESS_HANDLER_STATES = new WeakMap();

function boundedText(value, fallback = "unknown_error") {
  try {
    const text = String(value ?? fallback);
    return text.slice(0, 4000) || fallback;
  } catch {
    return fallback;
  }
}

function errorDetails(error) {
  if (error && typeof error === "object") {
    return {
      name: boundedText(error.name, "Error"),
      message: boundedText(error.message, "unknown_error"),
      code: error.code === undefined ? undefined : boundedText(error.code),
      stack: error.stack === undefined ? undefined : boundedText(error.stack),
    };
  }

  return {
    name: "NonErrorRejection",
    message: boundedText(error),
  };
}

function timestamp(now) {
  try {
    const value = now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function emitStructuredRecord({ logger = console, processImpl = process, now = () => new Date(), event, details = {} }) {
  const line = JSON.stringify({
    schema: "tasknode.process_hardening.v1",
    timestamp: timestamp(now),
    event,
    ...details,
  });

  try {
    if (typeof logger?.error === "function") {
      logger.error(line);
      return true;
    }
  } catch (loggerError) {
    void loggerError;
  }

  try {
    if (typeof processImpl?.stderr?.write === "function") {
      processImpl.stderr.write(`${line}\n`);
      return true;
    }
  } catch (writeError) {
    void writeError;
  }

  return false;
}

function boundedFlush({
  flush,
  timeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  if (typeof flush !== "function") return Promise.resolve({ attempted: false });

  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) {
        try {
          clearTimeoutImpl(timeout);
        } catch (clearError) {
          void clearError;
        }
      }
      resolve(result);
    };

    try {
      timeout = setTimeoutImpl(() => finish({ attempted: true, timedOut: true }), timeoutMs);
      Promise.resolve()
        .then(() => flush())
        .then(
          () => finish({ attempted: true, timedOut: false }),
          () => finish({ attempted: true, failed: true })
        );
    } catch (error) {
      finish({ attempted: true, failed: true, error: errorDetails(error) });
    }
  });
}

export function installProcessHardening({
  processImpl = process,
  logger = console,
  flush,
  flushTimeoutMs = 5000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  exit = (code) => processImpl.exit(code),
  now = () => new Date(),
} = {}) {
  const installed = PROCESS_HANDLER_STATES.get(processImpl);
  if (installed) return installed.api;

  let handlingRejection = false;
  let fatalStarted = false;
  let exitCalled = false;

  const unhandledRejection = (reason) => {
    if (handlingRejection || fatalStarted) return;
    handlingRejection = true;
    try {
      emitStructuredRecord({
        logger,
        now,
        processImpl,
        event: "unhandled_rejection",
        details: { error: errorDetails(reason) },
      });
    } finally {
      handlingRejection = false;
    }
  };

  const uncaughtException = (error, origin = "") => {
    if (fatalStarted) return;
    fatalStarted = true;

    emitStructuredRecord({
      logger,
      now,
      processImpl,
      event: "uncaught_exception",
      details: {
        origin: boundedText(origin, "uncaughtException"),
        error: errorDetails(error),
      },
    });

    void boundedFlush({
      flush,
      timeoutMs: Math.max(0, Number(flushTimeoutMs) || 0),
      setTimeoutImpl,
      clearTimeoutImpl,
    }).then(() => {
      if (exitCalled) return;
      exitCalled = true;
      try {
        exit(1);
      } catch (exitError) {
        void exitError;
      }
    });
  };

  processImpl.on("unhandledRejection", unhandledRejection);
  processImpl.on("uncaughtException", uncaughtException);

  const api = {
    installed: true,
    uninstall() {
      processImpl.removeListener?.("unhandledRejection", unhandledRejection);
      processImpl.removeListener?.("uncaughtException", uncaughtException);
      PROCESS_HANDLER_STATES.delete(processImpl);
    },
  };
  PROCESS_HANDLER_STATES.set(processImpl, { api });
  return api;
}

export function createCrashIsolatingTickRunner({
  name = "scheduled_tick",
  tick,
  intervalMs = 1000,
  maxBackoffMs = 60_000,
  backoffMultiplier = 2,
  logger = console,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => new Date(),
  unrefTimers = false,
} = {}) {
  if (typeof tick !== "function") {
    throw new TypeError("crash_isolating_tick_runner_requires_tick");
  }

  const intervalValue = Number(intervalMs);
  const maxBackoffValue = Number(maxBackoffMs);
  const multiplierValue = Number(backoffMultiplier);
  const baseIntervalMs = Number.isFinite(intervalValue) ? Math.max(0, intervalValue) : 0;
  const backoffCapMs = Number.isFinite(maxBackoffValue)
    ? Math.max(baseIntervalMs, maxBackoffValue)
    : Math.max(baseIntervalMs, 60_000);
  const multiplier = Number.isFinite(multiplierValue) ? Math.max(1, multiplierValue) : 2;
  const runnerName = boundedText(name, "scheduled_tick");

  let timer = null;
  let active = false;
  let running = false;
  let consecutiveFailures = 0;
  let tickCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let nextDelayMs = null;

  const state = () => ({
    name: runnerName,
    active,
    running,
    scheduled: timer !== null,
    consecutiveFailures,
    tickCount,
    successCount,
    failureCount,
    nextDelayMs,
  });

  const delayAfterTick = () => {
    if (consecutiveFailures === 0) return baseIntervalMs;
    return Math.min(backoffCapMs, baseIntervalMs * (multiplier ** consecutiveFailures));
  };

  const schedule = (delayMs) => {
    if (!active || timer !== null) return;
    nextDelayMs = Math.max(0, Number(delayMs) || 0);
    timer = setTimeoutImpl(() => {
      timer = null;
      void runTick({ reschedule: true });
    }, nextDelayMs);
    if (unrefTimers) timer?.unref?.();
  };

  const runTick = async ({ reschedule = false } = {}) => {
    if (running) {
      if (reschedule && active) schedule(delayAfterTick());
      return { ...state(), skipped: true };
    }

    running = true;
    tickCount += 1;
    let failed = false;
    try {
      await tick();
      consecutiveFailures = 0;
      successCount += 1;
      nextDelayMs = baseIntervalMs;
    } catch (error) {
      failed = true;
      consecutiveFailures += 1;
      failureCount += 1;
      nextDelayMs = delayAfterTick();
      emitStructuredRecord({
        logger,
        now,
        event: "scheduled_tick_failed",
        details: {
          runner: runnerName,
          consecutiveFailures,
          nextDelayMs,
          error: errorDetails(error),
        },
      });
    } finally {
      running = false;
      if (reschedule && active) schedule(delayAfterTick());
    }

    return { ...state(), failed };
  };

  const runner = {
    start({ immediate = false } = {}) {
      if (!active) {
        active = true;
        schedule(immediate ? 0 : baseIntervalMs);
      }
      return state();
    },
    stop() {
      active = false;
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
      nextDelayMs = null;
      return state();
    },
    runNow() {
      return runTick();
    },
    getState: state,
  };

  Object.defineProperty(runner, "state", { get: state });
  return runner;
}
