import {
  normalizeTaskStatus,
  TASK_STATUS,
  taskIsTerminal,
} from "../../../shared/task-lifecycle.js";
import { taskStatusProgress } from "./task-visible-state.js";

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

  return taskStatusProgress(incomingStatus) < taskStatusProgress(optimistic.statusKey);
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
