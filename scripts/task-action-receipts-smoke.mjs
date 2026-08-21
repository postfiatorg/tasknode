import assert from "node:assert/strict";

import {
  appendTaskActionReceipt,
  taskActionReceiptFromEvidenceResult,
  taskActionReceiptFromLifecycleResult,
} from "../src/features/tasks/task-action-receipts.js";
import { shouldForceTaskSyncNotice } from "../src/features/tasks/task-refresh-policy.js";
import {
  mergeTaskStateWithActionReceipts,
  pruneTaskActionReceiptsForTaskState,
  taskSyncNoticeForStatus,
} from "../src/features/tasks/task-visible-state.js";

const nowMs = Date.parse("2026-06-07T10:00:00.000Z");
const accountId = "acct_test";
const walletAddress = "rTestWallet";

const acceptedTask = {
  taskId: "task_submit_1",
  title: "Submit evidence",
  kind: "Personal",
  status: "Accepted",
  statusKey: "accepted",
  statusTab: "outstanding",
  ago: "5m ago",
  pft: 1.5,
};

const evidenceReceipt = taskActionReceiptFromEvidenceResult({
  accountId,
  walletAddress,
  result: {
    taskId: acceptedTask.taskId,
    txHash: "SUBMIT_TX",
    cid: "QmSubmitCid",
    submissionPayload: { schema: "pf.task.evidence.v1" },
  },
  task: acceptedTask,
});

assert.equal(evidenceReceipt.expectedStatusKey, "submitted");

const staleProjection = {
  outstanding: [acceptedTask],
  verification: [],
  refused: [],
  rewarded: [],
  sync: {
    status: "indexing_lag",
    indexingLagCount: 1,
    projectionCount: 5,
  },
};

const mergedStale = mergeTaskStateWithActionReceipts(staleProjection, [evidenceReceipt], {
  accountId,
  walletAddress,
  nowMs,
});

assert.equal(mergedStale.outstanding.length, 1);
assert.equal(mergedStale.outstanding[0].statusKey, "submitted");
assert.equal(mergedStale.outstanding[0].status, "Submitted");
assert.equal(mergedStale.outstanding[0].clientActionPending, true);
assert.equal(mergedStale.outstanding[0].clientSyncLabel, "syncing");
assert.equal(mergedStale.outstanding[0].metadata.optimisticLastTxHash, "SUBMIT_TX");
assert.equal(mergedStale.sync.requiresRefresh, true);
assert.equal(mergedStale.sync.nextPollMs, 2500);
assert.equal(mergedStale.sync.refreshReason, "task_action_receipt_pending");
assert.deepEqual(mergedStale.sync.optimisticSyncTaskIds, ["task_submit_1"]);

assert.equal(
  pruneTaskActionReceiptsForTaskState([evidenceReceipt], staleProjection, { accountId, walletAddress, nowMs }).length,
  1,
  "receipt must remain while canonical projection is stale"
);

const caughtUpProjection = {
  ...staleProjection,
  outstanding: [{
    ...acceptedTask,
    status: "Submitted",
    statusKey: "submitted",
  }],
};

assert.equal(
  pruneTaskActionReceiptsForTaskState([evidenceReceipt], caughtUpProjection, { accountId, walletAddress, nowMs }).length,
  0,
  "receipt should disappear once canonical state reaches the expected status"
);

const advancedProjection = {
  ...staleProjection,
  outstanding: [],
  verification: [{
    ...acceptedTask,
    status: "Verification requested",
    statusKey: "verification_requested",
  }],
};

assert.equal(
  pruneTaskActionReceiptsForTaskState([evidenceReceipt], advancedProjection, { accountId, walletAddress, nowMs }).length,
  0,
  "receipt should disappear once canonical state advances beyond the expected status"
);

const terminalProjection = {
  ...staleProjection,
  outstanding: [],
  rewarded: [{
    ...acceptedTask,
    status: "Rewarded",
    statusKey: "rewarded",
  }],
};
const mergedTerminal = mergeTaskStateWithActionReceipts(terminalProjection, [evidenceReceipt], {
  accountId,
  walletAddress,
  nowMs,
});
assert.equal(mergedTerminal.rewarded[0].statusKey, "rewarded");
assert.equal(mergedTerminal.rewarded[0].clientActionPending, undefined);
assert.equal(mergedTerminal.sync.requiresRefresh, false);

const verificationResponseReceipt = taskActionReceiptFromEvidenceResult({
  accountId,
  walletAddress,
  result: {
    taskId: "task_verify_1",
    txHash: "VERIFY_TX",
    submissionPayload: { schema: "pf.task.verification_response.v1" },
  },
  task: { taskId: "task_verify_1" },
});
assert.equal(verificationResponseReceipt.expectedStatusKey, "verification_response_submitted");

const acceptedReceipt = taskActionReceiptFromLifecycleResult({
  accountId,
  walletAddress,
  result: { taskId: "task_accept_1", txHash: "ACCEPT_TX" },
  task: { taskId: "task_accept_1" },
  taskAction: "accept",
});
assert.equal(acceptedReceipt.expectedStatusKey, "accepted");

const receiptList = appendTaskActionReceipt([], evidenceReceipt, nowMs);
assert.equal(receiptList.length, 1);

const duplicateEvidenceReceipt = {
  ...evidenceReceipt,
  createdAt: new Date(nowMs + 60 * 1000).toISOString(),
  expiresAt: new Date(nowMs + 60 * 1000 + 10 * 60 * 1000).toISOString(),
};
const dedupedList = appendTaskActionReceipt(receiptList, duplicateEvidenceReceipt, nowMs + 60 * 1000);
assert.equal(
  dedupedList,
  receiptList,
  "an identical receipt (same taskId, status, txHash) must return the same array reference"
);
assert.equal(
  dedupedList[0].expiresAt,
  evidenceReceipt.expiresAt,
  "a duplicate receipt must not extend the existing receipt expiry"
);

const advancingReceipt = taskActionReceiptFromEvidenceResult({
  accountId,
  walletAddress,
  result: {
    taskId: acceptedTask.taskId,
    txHash: "SUBMIT_TX",
    cid: "QmSubmitCid",
    submissionPayload: { schema: "pf.task.verification_response.v1" },
  },
  task: acceptedTask,
});
const advancedList = appendTaskActionReceipt(receiptList, advancingReceipt, nowMs);
assert.notEqual(advancedList, receiptList, "a status-advancing receipt must produce a new array");
assert.equal(advancedList.length, 1, "a status-advancing receipt must replace the same taskId+txHash receipt");
assert.equal(advancedList[0].expectedStatusKey, "verification_response_submitted");

const retryReceipt = taskActionReceiptFromEvidenceResult({
  accountId,
  walletAddress,
  result: {
    taskId: acceptedTask.taskId,
    txHash: "SUBMIT_TX_RETRY",
    cid: "QmSubmitCidRetry",
    submissionPayload: { schema: "pf.task.evidence.v1" },
  },
  task: acceptedTask,
});
const retriedList = appendTaskActionReceipt(receiptList, retryReceipt, nowMs);
assert.notEqual(retriedList, receiptList, "a different-txHash receipt must produce a new array");
assert.equal(retriedList.length, 2, "a different-txHash receipt must append alongside the existing receipt");
assert.equal(retriedList[0].txHash, "SUBMIT_TX_RETRY");
assert.equal(retriedList[1].txHash, "SUBMIT_TX");

const expiredNowMs = Date.parse(evidenceReceipt.expiresAt) + 1;
const remintedList = appendTaskActionReceipt(receiptList, duplicateEvidenceReceipt, expiredNowMs);
assert.notEqual(remintedList, receiptList, "an expired receipt must be re-mintable instead of deduped");
assert.equal(remintedList.length, 1);

assert.equal(taskSyncNoticeForStatus({ status: "indexing_lag", indexingLagCount: 1 }), null);
assert.equal(shouldForceTaskSyncNotice({ status: "indexing_lag", indexingLagCount: 1 }), false);
assert.equal(shouldForceTaskSyncNotice({ status: "indexing_lag", indexingLagCount: 4 }), true);
assert.equal(taskSyncNoticeForStatus({ status: "indexing_lag", indexingLagCount: 4 }).label, "Task list is updating");
assert.equal(
  shouldForceTaskSyncNotice({ status: "indexing_lag", indexingLagCount: 4 }, { directOffchain: true }),
  false
);
assert.equal(taskSyncNoticeForStatus({ status: "indexing_lag", indexingLagCount: 4 }, { directOffchain: true }), null);
assert.equal(taskSyncNoticeForStatus({ status: "reducer_attention", failedReducerCount: 1 }).label, "Task sync needs attention");

console.log("task action receipts smoke ok");
