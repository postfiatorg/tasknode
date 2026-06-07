import assert from "node:assert/strict";

import {
  optimisticEvidenceStateFromSubmission,
  optimisticTaskStateFromActionReceipt,
  optimisticTaskStateFromTask,
  overlayTaskDetailWithOptimisticEvidence,
  overlayTaskDetailWithOptimisticTaskState,
  shouldRetainOptimisticEvidenceState,
  shouldRetainOptimisticTaskState,
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

const acceptedReceipt = optimisticTaskStateFromActionReceipt({
  actionType: "accept",
  expectedStatusKey: "accepted",
  expectedStatus: "Accepted",
  txHash: "ACCEPT_TX",
  createdAt: "2026-06-07T11:53:46.088Z",
});

assert.equal(
  shouldRetainOptimisticTaskState({ task: { statusKey: "proposed" } }, acceptedReceipt),
  true,
  "proposed detail refresh is stale after accept"
);

const staleAcceptedDetail = overlayTaskDetailWithOptimisticTaskState(
  {
    task: { taskId: "task_accepted_1", status: "Proposed", statusKey: "proposed", metadata: {} },
    actions: {
      canAccept: true,
      canStop: true,
      stopAction: "refuse",
    },
  },
  acceptedReceipt
);

assert.equal(staleAcceptedDetail.task.statusKey, "accepted");
assert.equal(staleAcceptedDetail.task.status, "Accepted");
assert.equal(staleAcceptedDetail.task.metadata.optimisticLastTxHash, "ACCEPT_TX");
assert.equal(staleAcceptedDetail.actions.canAccept, false);
assert.equal(staleAcceptedDetail.actions.canSubmitInitialEvidence, true);

const acceptedRowState = optimisticTaskStateFromTask({
  taskId: "task_accepted_1",
  status: "Accepted",
  statusKey: "accepted",
  txHash: "ACCEPT_TX",
  clientActionPending: true,
  clientSyncLabel: "syncing",
});

const staleDetailFromAdvancedRow = overlayTaskDetailWithOptimisticTaskState(
  {
    task: { taskId: "task_accepted_1", status: "Proposed", statusKey: "proposed", metadata: {} },
    actions: { canAccept: true },
  },
  acceptedRowState
);

assert.equal(staleDetailFromAdvancedRow.task.statusKey, "accepted");
assert.equal(staleDetailFromAdvancedRow.task.clientSyncLabel, "syncing");
assert.equal(staleDetailFromAdvancedRow.actions.canSubmitInitialEvidence, true);

assert.equal(
  shouldRetainOptimisticTaskState({ task: { statusKey: "accepted" } }, optimisticTaskStateFromTask({ statusKey: "proposed" })),
  false,
  "older row state must not downgrade advanced detail"
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
