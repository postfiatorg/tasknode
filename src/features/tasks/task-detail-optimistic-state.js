import {
  normalizeTaskStatus,
  TASK_STATUS,
  taskIsTerminal,
} from "../../../shared/task-lifecycle.js";

const TASK_STATUS_PROGRESS = Object.freeze({
  [TASK_STATUS.unknown]: 0,
  [TASK_STATUS.proposed]: 10,
  [TASK_STATUS.accepted]: 20,
  [TASK_STATUS.submitted]: 30,
  [TASK_STATUS.verificationRequested]: 40,
  [TASK_STATUS.verificationResponseSubmitted]: 50,
  [TASK_STATUS.rewardDecided]: 60,
  [TASK_STATUS.rewarded]: 70,
  [TASK_STATUS.refused]: 70,
  [TASK_STATUS.rejected]: 70,
  [TASK_STATUS.cancelled]: 70,
  [TASK_STATUS.expired]: 70,
});

function statusProgress(status = "") {
  return TASK_STATUS_PROGRESS[normalizeTaskStatus(status)] ?? TASK_STATUS_PROGRESS[TASK_STATUS.unknown];
}

export function optimisticEvidenceStateFromSubmission(result = {}) {
  const schema = String(result?.submissionPayload?.schema || "");
  const verificationResponse = schema === "pf.task.verification_response.v1";
  return {
    schema,
    status: verificationResponse ? "Awaiting review" : "Submitted",
    statusKey: verificationResponse
      ? TASK_STATUS.verificationResponseSubmitted
      : TASK_STATUS.submitted,
    txHash: String(result?.txHash || "").trim(),
  };
}

export function shouldRetainOptimisticEvidenceState(detail = null, optimistic = null) {
  if (!optimistic?.statusKey) return false;
  const incomingTask = detail?.task;
  if (!incomingTask) return true;

  const incomingStatus = normalizeTaskStatus(incomingTask.statusKey || incomingTask.status);
  if (taskIsTerminal(incomingStatus)) return false;

  return statusProgress(incomingStatus) < statusProgress(optimistic.statusKey);
}

export function overlayTaskDetailWithOptimisticEvidence(detail = null, optimistic = null) {
  if (!detail?.task || !shouldRetainOptimisticEvidenceState(detail, optimistic)) return detail;

  return {
    ...detail,
    task: {
      ...detail.task,
      status: optimistic.status,
      statusKey: optimistic.statusKey,
      metadata: {
        ...(detail.task.metadata || {}),
        optimisticLastTxHash: optimistic.txHash || "",
      },
    },
    actions: {
      ...(detail.actions || {}),
      browserSubmissionEnabled: false,
      canSubmitInitialEvidence: false,
      canSubmitVerificationEvidence: false,
    },
  };
}
