import assert from "node:assert/strict";

import {
  taskAcceptanceConfirmation,
  taskLifecycleStopDescriptor,
  taskSubmissionProgressSteps,
} from "../src/features/tasks/task-workflow-visibility.js";

const proposedActions = {
  canAccept: true,
  canRefuse: true,
  canStop: true,
  stopAction: "refuse",
  stopLabel: "Refuse task",
};
const acceptedActions = {
  canCancel: true,
  canRefuse: false,
  canStop: true,
  stopAction: "cancel",
  stopLabel: "Cancel task",
  canSubmitInitialEvidence: true,
};

assert.deepEqual(
  taskLifecycleStopDescriptor(proposedActions),
  { action: "refuse", label: "Refuse task" },
  "proposed lifecycle payloads should expose refuse as the visible stop action"
);
assert.deepEqual(
  taskLifecycleStopDescriptor(acceptedActions),
  { action: "cancel", label: "Cancel task" },
  "accepted lifecycle payloads should expose cancel as the visible stop action"
);
assert.equal(
  taskLifecycleStopDescriptor({ canStop: true, canCancel: false, stopAction: "cancel", stopLabel: "Cancel task" }),
  null,
  "inconsistent stop capabilities should fail closed"
);

assert.equal(
  taskAcceptanceConfirmation({
    actions: { canAccept: true, canSubmitInitialEvidence: false },
    task: { statusKey: "proposed" },
  }),
  null,
  "proposed tasks should keep the accept controls instead of showing an accepted notice"
);

const indexedNotice = taskAcceptanceConfirmation({
  actions: { canAccept: false, canSubmitInitialEvidence: true },
  task: { statusKey: "accepted" },
});

assert.equal(indexedNotice.title, "Task accepted");
assert.equal(indexedNotice.actionLabel, "Submit evidence");
assert.equal(indexedNotice.tone, "success");
assert.equal(indexedNotice.detail, "", "accepted notice should not repeat its next-step copy in the detail slot");

const acceptedNoticeCtas = [indexedNotice.actionLabel].filter(Boolean);
assert.deepEqual(acceptedNoticeCtas, ["Submit evidence"], "accepted overview should expose one submit CTA from the notice");

const syncingNotice = taskAcceptanceConfirmation({
  actions: { canAccept: false, canSubmitInitialEvidence: true },
  task: {
    clientActionPending: true,
    clientSyncDetail: "Task action was signed. Task state is updating.",
    statusKey: "accepted",
  },
});

assert.equal(syncingNotice.tone, "syncing");
assert.equal(syncingNotice.detail, "Task action was signed. Task state is updating.");

const emptyProgress = taskSubmissionProgressSteps({ readyEvidenceCount: 0 });
assert.deepEqual(
  emptyProgress.map((step) => [step.key, step.state, step.detail]),
  [
    ["evidence", "current", "Add evidence"],
    ["review", "pending", "Waiting"],
    ["submit", "pending", "Waiting"],
  ]
);

const readyProgress = taskSubmissionProgressSteps({ readyEvidenceCount: 2 });
assert.deepEqual(
  readyProgress.map((step) => [step.key, step.state, step.detail]),
  [
    ["evidence", "complete", "2 ready"],
    ["review", "current", "Mark ready"],
    ["submit", "pending", "Waiting"],
  ]
);

const processedFileProgress = taskSubmissionProgressSteps({ readyEvidenceCount: 1 });
assert.deepEqual(
  processedFileProgress.map((step) => [step.key, step.state, step.detail]),
  [
    ["evidence", "complete", "1 ready"],
    ["review", "current", "Mark ready"],
    ["submit", "pending", "Waiting"],
  ],
  "reading a file or screenshot should not mark evidence as submitted"
);

const confirmedProgress = taskSubmissionProgressSteps({ confirmed: true, readyEvidenceCount: 1 });
assert.deepEqual(
  confirmedProgress.map((step) => [step.key, step.state, step.detail]),
  [
    ["evidence", "complete", "1 ready"],
    ["review", "complete", "Marked ready"],
    ["submit", "current", "Ready"],
  ]
);

const submitPending = taskSubmissionProgressSteps({
  confirmed: true,
  pending: true,
  pendingLabel: "Pinning evidence",
  readyEvidenceCount: 1,
});
assert.equal(submitPending[0].state, "complete");
assert.equal(submitPending[1].state, "complete");
assert.equal(submitPending[2].state, "current");
assert.equal(submitPending[2].detail, "Pinning evidence");

const completeProgress = taskSubmissionProgressSteps({ submitted: true });
assert.deepEqual(
  completeProgress.map((step) => step.state),
  ["complete", "complete", "complete"]
);

console.log("task workflow visibility smoke ok");
