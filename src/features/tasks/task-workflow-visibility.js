import {
  normalizeTaskStatus,
  TASK_STATUS,
} from "../../../shared/task-lifecycle.js";

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function submissionPendingPhase(label = "") {
  const normalized = safeText(label, 120).toLowerCase();
  if (normalized.includes("reading") || normalized.includes("screenshot") || normalized.includes("file")) {
    return "evidence";
  }
  if (normalized.includes("configuring")) return "review";
  if (normalized) return "submit";
  return "";
}

export function taskAcceptanceConfirmation({ actions = {}, task = {} } = {}) {
  const statusKey = normalizeTaskStatus(task?.statusKey || task?.status);
  if (statusKey !== TASK_STATUS.accepted || actions?.canAccept) return null;

  const clientSyncLabel = safeText(task?.clientSyncLabel, 80);
  const clientSyncDetail = safeText(task?.clientSyncDetail, 240);
  const pending = Boolean(task?.clientActionPending || clientSyncLabel);
  return {
    actionLabel: actions?.canSubmitInitialEvidence ? "Submit evidence" : "",
    body: "This task is on your plate. Submit evidence when the work is ready.",
    detail: pending
      ? clientSyncDetail || "The confirmation stays visible while the task index catches up."
      : "Accepted status is indexed for this task.",
    title: "Task accepted",
    tone: pending ? "syncing" : "success",
  };
}

export function taskSubmissionProgressSteps({
  confirmed = false,
  pending = false,
  pendingLabel = "",
  readyEvidenceCount = 0,
  submitted = false,
} = {}) {
  const readyCount = Math.max(0, Number(readyEvidenceCount || 0));
  const complete = Boolean(submitted);
  const hasReadyEvidence = complete || readyCount > 0;
  const reviewed = complete || Boolean(confirmed);
  const phase = pending ? submissionPendingPhase(pendingLabel) : "";

  const stateFor = (key) => {
    if (complete) return "complete";
    if (pending) {
      if (phase === key) return "current";
      if (key === "evidence" && (phase === "review" || phase === "submit")) return "complete";
      if (key === "review" && phase === "submit") return "complete";
      return "pending";
    }
    if (key === "evidence") return hasReadyEvidence ? "complete" : "current";
    if (key === "review") return reviewed ? "complete" : hasReadyEvidence ? "current" : "pending";
    if (key === "submit") return reviewed ? "current" : "pending";
    return "pending";
  };

  return [
    {
      detail: hasReadyEvidence ? `${readyCount || 1} ready` : "Add evidence",
      key: "evidence",
      label: "Evidence",
      state: stateFor("evidence"),
    },
    {
      detail: reviewed ? "Marked ready" : hasReadyEvidence ? "Mark ready" : "Waiting",
      key: "review",
      label: "Review",
      state: stateFor("review"),
    },
    {
      detail: complete
        ? "Submitted"
        : pending && phase === "submit"
          ? safeText(pendingLabel, 80) || "Submitting"
          : reviewed
            ? "Ready"
            : "Waiting",
      key: "submit",
      label: "Submit",
      state: stateFor("submit"),
    },
  ];
}
