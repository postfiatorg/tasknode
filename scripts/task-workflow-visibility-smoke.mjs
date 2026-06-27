import assert from "node:assert/strict";

import {
  taskAcceptanceConfirmation,
  taskSubmissionProgressSteps,
} from "../src/features/tasks/task-workflow-visibility.js";

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

const completeProgress = taskSubmissionProgressSteps({ result: "Published ABC123" });
assert.deepEqual(
  completeProgress.map((step) => step.state),
  ["complete", "complete", "complete"]
);

console.log("task workflow visibility smoke ok");
