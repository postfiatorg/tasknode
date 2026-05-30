import assert from "node:assert/strict";

import {
  optimisticEvidenceStateFromSubmission,
  overlayTaskDetailWithOptimisticEvidence,
  shouldRetainOptimisticEvidenceState,
} from "../src/features/tasks/task-detail-optimistic-state.js";

const initialSubmission = optimisticEvidenceStateFromSubmission({
  txHash: "ABC123",
  submissionPayload: { schema: "pf.task.evidence.v1" },
});

assert.equal(initialSubmission.statusKey, "submitted");
assert.equal(
  shouldRetainOptimisticEvidenceState({ task: { statusKey: "accepted" } }, initialSubmission),
  true,
  "accepted detail refresh is stale after evidence submit"
);

const staleInitial = overlayTaskDetailWithOptimisticEvidence(
  {
    task: { taskId: "task_1", status: "Accepted", statusKey: "accepted", metadata: {} },
    actions: {
      browserSubmissionEnabled: true,
      canSubmitInitialEvidence: true,
      canSubmitVerificationEvidence: false,
    },
  },
  initialSubmission
);

assert.equal(staleInitial.task.statusKey, "submitted");
assert.equal(staleInitial.task.status, "Submitted");
assert.equal(staleInitial.task.metadata.optimisticLastTxHash, "ABC123");
assert.equal(staleInitial.actions.browserSubmissionEnabled, false);
assert.equal(staleInitial.actions.canSubmitInitialEvidence, false);

assert.equal(
  shouldRetainOptimisticEvidenceState({ task: { statusKey: "verification_requested" } }, initialSubmission),
  false,
  "review request is an advanced server state and should replace optimistic submitted"
);

const verificationResponse = optimisticEvidenceStateFromSubmission({
  txHash: "DEF456",
  submissionPayload: { schema: "pf.task.verification_response.v1" },
});

const staleVerification = overlayTaskDetailWithOptimisticEvidence(
  {
    task: { taskId: "task_1", status: "Verification requested", statusKey: "verification_requested" },
    actions: {
      browserSubmissionEnabled: true,
      canSubmitInitialEvidence: false,
      canSubmitVerificationEvidence: true,
    },
  },
  verificationResponse
);

assert.equal(verificationResponse.statusKey, "verification_response_submitted");
assert.equal(staleVerification.task.statusKey, "verification_response_submitted");
assert.equal(staleVerification.task.status, "Awaiting review");
assert.equal(staleVerification.actions.canSubmitVerificationEvidence, false);

assert.equal(
  shouldRetainOptimisticEvidenceState({ task: { statusKey: "rewarded" } }, verificationResponse),
  false,
  "terminal server state should always replace optimistic state"
);

console.log("task-detail-optimistic-state-smoke ok");
