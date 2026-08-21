const subscribers = new Set();
const runStates = new Map();
let latestRunId = "";

function safeText(value = "", max = 1000000) {
  return String(value || "").slice(0, max);
}

function isoNow() {
  return new Date().toISOString();
}

function emit(event = "message", payload = {}) {
  const body = {
    ...payload,
    emittedAt: payload.emittedAt || isoNow(),
  };
  for (const send of [...subscribers]) {
    try {
      send(event, body);
    } catch {
      subscribers.delete(send);
    }
  }
}

function stateForRun(runId = "") {
  const normalizedRunId = safeText(runId, 180).trim();
  if (!normalizedRunId) return null;
  const existing = runStates.get(normalizedRunId);
  if (existing) return existing;
  const next = {
    runId: normalizedRunId,
    status: "running",
    outputText: "",
    startedAt: isoNow(),
    updatedAt: isoNow(),
    metadata: {},
  };
  runStates.set(normalizedRunId, next);
  latestRunId = normalizedRunId;
  return next;
}

export function startHiveBrainRunLive({ runId = "", metadata = {} } = {}) {
  const state = stateForRun(runId);
  if (!state) return;
  state.status = "running";
  state.metadata = metadata && typeof metadata === "object" ? metadata : {};
  state.updatedAt = isoNow();
  latestRunId = state.runId;
  emit("run_started", { run: snapshotHiveBrainLiveRun(state) });
}

export function appendHiveBrainRunOutput({ runId = "", delta = "" } = {}) {
  const text = safeText(delta, 1000000);
  if (!text) return;
  const state = stateForRun(runId);
  if (!state) return;
  state.outputText = safeText(`${state.outputText || ""}${text}`, 1000000);
  state.updatedAt = isoNow();
  latestRunId = state.runId;
  emit("output_delta", {
    runId: state.runId,
    delta: text,
    outputBytes: Buffer.byteLength(state.outputText),
    updatedAt: state.updatedAt,
  });
}

export function completeHiveBrainRunLive({
  runId = "",
  status = "completed",
  outputText = "",
  error = "",
  usage = {},
} = {}) {
  const state = stateForRun(runId);
  if (!state) return;
  state.status = status === "failed" ? "failed" : "completed";
  if (outputText) state.outputText = safeText(outputText, 1000000);
  state.error = safeText(error, 2000);
  state.usage = usage && typeof usage === "object" ? usage : {};
  state.completedAt = isoNow();
  state.updatedAt = state.completedAt;
  latestRunId = state.runId;
  emit(state.status === "failed" ? "run_failed" : "run_completed", {
    run: snapshotHiveBrainLiveRun(state),
  });
}

export function snapshotHiveBrainLiveRun(state = null) {
  const source = state && typeof state === "object" ? state : runStates.get(latestRunId) || null;
  if (!source) {
    return {
      runId: "",
      status: "idle",
      outputText: "",
      outputBytes: 0,
      updatedAt: isoNow(),
      metadata: {},
    };
  }
  return {
    runId: source.runId || "",
    status: source.status || "running",
    outputText: source.outputText || "",
    outputBytes: Buffer.byteLength(source.outputText || ""),
    startedAt: source.startedAt || "",
    completedAt: source.completedAt || "",
    updatedAt: source.updatedAt || "",
    error: source.error || "",
    usage: source.usage || {},
    metadata: source.metadata || {},
  };
}

export function hiveBrainLiveSnapshot() {
  return {
    ok: true,
    latestRunId,
    run: snapshotHiveBrainLiveRun(),
  };
}

export function subscribeHiveBrainLive(send) {
  if (typeof send !== "function") return () => {};
  subscribers.add(send);
  send("snapshot", hiveBrainLiveSnapshot());
  return () => {
    subscribers.delete(send);
  };
}
