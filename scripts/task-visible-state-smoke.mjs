import assert from "node:assert/strict";

import {
  taskActionReceiptFromEvidenceResult,
  taskActionReceiptFromLifecycleResult,
} from "../src/features/tasks/task-action-receipts.js";
import {
  findTaskById,
  reconcileTaskVisibleState,
} from "../src/features/tasks/task-visible-state.js";

const nowMs = Date.parse("2026-06-07T12:00:00.000Z");
const accountId = "acct_visible_state";
const walletAddress = "rVisibleWallet";

function task(statusKey, extra = {}) {
  const labels = {
    accepted: "Accepted",
    proposed: "Proposed",
    rewarded: "Rewarded",
    submitted: "Submitted",
    verification_requested: "Verification requested",
    verification_response_submitted: "Awaiting review",
  };
  return {
    taskId: "task_visible_state",
    title: "Visible state regression",
    kind: "Personal",
    status: labels[statusKey] || statusKey,
    statusKey,
    pft: 1.5,
    ago: "just now",
    ...extra,
  };
}

function tasksWith(bucket, row, sync = {}) {
  return {
    outstanding: bucket === "outstanding" ? [row] : [],
    verification: bucket === "verification" ? [row] : [],
    refused: [],
    rewarded: bucket === "rewarded" ? [row] : [],
    requests: { items: [] },
    sync: {
      status: "ready",
      projectionCount: 1,
      requiresRefresh: false,
      ...sync,
    },
  };
}

function reconcile(tasks, receipts = []) {
  return reconcileTaskVisibleState({
    accountId,
    linkedWalletAddress: walletAddress,
    nowMs,
    receipts,
    selectedTaskId: "task_visible_state",
    tasks,
  });
}

const proposed = task("proposed");
const acceptReceipt = taskActionReceiptFromLifecycleResult({
  accountId,
  walletAddress,
  result: { taskId: proposed.taskId, txHash: "ACCEPT_TX" },
  task: proposed,
  taskAction: "accept",
});
const acceptedVisible = reconcile(tasksWith("outstanding", proposed), [acceptReceipt]);
assert.equal(acceptedVisible.outstanding[0].statusKey, "accepted");
assert.equal(acceptedVisible.counts.outstanding, 1);
assert.equal(acceptedVisible.totalPftInFlight, 1.5);
assert.equal(acceptedVisible.sync.requiresRefresh, true);
assert.equal(acceptedVisible.polling.shouldRefreshTaskState, true);
assert.equal(acceptedVisible.selectedTask.statusKey, "accepted");

const accepted = task("accepted");
const submitReceipt = taskActionReceiptFromEvidenceResult({
  accountId,
  walletAddress,
  result: {
    taskId: accepted.taskId,
    txHash: "SUBMIT_TX",
    submissionPayload: { schema: "pf.task.evidence.v1" },
  },
  task: accepted,
});
const submittedVisible = reconcile(tasksWith("outstanding", accepted), [submitReceipt]);
assert.equal(submittedVisible.outstanding[0].statusKey, "submitted");
assert.equal(submittedVisible.sync.refreshReason, "task_action_receipt_pending");

const verificationRequested = task("verification_requested");
const afterReviewRequest = reconcile(tasksWith("verification", verificationRequested), [submitReceipt]);
assert.equal(afterReviewRequest.verification[0].statusKey, "verification_requested");
assert.equal(afterReviewRequest.prunedReceipts.length, 0);
assert.equal(afterReviewRequest.sync.requiresRefresh, true, "review loop still polls from server metadata");

const verificationReceipt = taskActionReceiptFromEvidenceResult({
  accountId,
  walletAddress,
  result: {
    taskId: verificationRequested.taskId,
    txHash: "VERIFY_TX",
    submissionPayload: { schema: "pf.task.verification_response.v1" },
  },
  task: verificationRequested,
});
const awaitingReview = reconcile(tasksWith("verification", verificationRequested), [verificationReceipt]);
assert.equal(awaitingReview.verification[0].statusKey, "verification_response_submitted");
assert.equal(awaitingReview.counts.verification, 1);
assert.equal(awaitingReview.totalPftInFlight, 1.5);
assert.equal(awaitingReview.sync.requiresRefresh, true);

const rewarded = task("rewarded", { pft: 1.5 });
const noHardRefresh = reconcile(tasksWith("rewarded", rewarded), [verificationReceipt]);
assert.equal(noHardRefresh.rewarded[0].statusKey, "rewarded");
assert.equal(noHardRefresh.rewarded[0].clientSyncLabel, undefined);
assert.equal(noHardRefresh.counts.rewarded, 1);
assert.equal(noHardRefresh.counts.verification, 0);
assert.equal(noHardRefresh.totalPftInFlight, 0);
assert.equal(noHardRefresh.prunedReceipts.length, 0);
assert.equal(noHardRefresh.polling.shouldRefreshTaskState, false);

const hardRefresh = reconcile(tasksWith("rewarded", rewarded), []);
assert.deepEqual(
  {
    counts: noHardRefresh.counts,
    selectedStatus: noHardRefresh.selectedTask.statusKey,
    totalPftInFlight: noHardRefresh.totalPftInFlight,
  },
  {
    counts: hardRefresh.counts,
    selectedStatus: hardRefresh.selectedTask.statusKey,
    totalPftInFlight: hardRefresh.totalPftInFlight,
  },
  "terminal rewarded state must be identical with or without stale receipts"
);

assert.equal(findTaskById(noHardRefresh.tasks, "task_visible_state").statusKey, "rewarded");

console.log("task-visible-state-smoke ok");
