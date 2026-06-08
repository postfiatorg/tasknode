import assert from "node:assert/strict";
import {
  isOperatorAuditOnlyTaskRequest,
  publicTaskRequest,
} from "../server/repositories/task-requests.js";

const now = new Date().toISOString();

const operatorRepairRequest = {
  request_id: "req_operator_repair_hidden",
  status: "failed",
  last_error: "Wrong Hive-routed work should stay operator-only.",
  created_at: now,
  updated_at: now,
  metadata_json: {
    keepPublic: "safe-context",
    last_error: "internal repair detail",
    operator_repair: {
      action: "fail_network_task_generation_chain",
      public_visibility: "hidden",
      user_visible: false,
      reason: "internal operator repair reason",
    },
  },
};

assert.equal(isOperatorAuditOnlyTaskRequest(operatorRepairRequest), true);

const hidden = publicTaskRequest(operatorRepairRequest);
assert.equal(hidden.statusLabel, "Closed");
assert.equal(hidden.isActive, false);
assert.equal(hidden.canRetry, false);
assert.equal(hidden.lastError, "");
assert.equal(hidden.metadata.keepPublic, "safe-context");
assert.equal(hidden.metadata.operator_repair, undefined);
assert.equal(hidden.metadata.last_error, undefined);

const autoHiddenNetworkFailure = publicTaskRequest({
  request_id: "req_network_generation_failed_before_offer",
  source: "network_task",
  requested_task_kind: "network",
  status: "failed",
  last_error: "context_ipfs_fetch_failed",
  created_at: now,
  updated_at: now,
  metadata_json: {
    operator_repair: {
      action: "fail_network_task_generation_chain",
      operator: "task_generation_worker",
      public_visibility: "hidden",
      user_visible: false,
      reason: "context_ipfs_fetch_failed",
    },
  },
});

assert.equal(autoHiddenNetworkFailure.statusLabel, "Closed");
assert.equal(autoHiddenNetworkFailure.isActive, false);
assert.equal(autoHiddenNetworkFailure.canRetry, false);
assert.equal(autoHiddenNetworkFailure.lastError, "");

const userFailedRequest = publicTaskRequest({
  request_id: "req_user_failed_visible",
  status: "failed",
  last_error: "context_ipfs_fetch_failed",
  created_at: now,
  updated_at: now,
  metadata_json: {},
});

assert.equal(userFailedRequest.statusLabel, "Needs attention");
assert.equal(userFailedRequest.isActive, true);
assert.equal(userFailedRequest.isProcessing, false);
assert.equal(userFailedRequest.needsAttention, true);
assert.equal(userFailedRequest.canRetry, true);
assert.equal(userFailedRequest.lastError, "context_ipfs_fetch_failed");

const failedWithGeneratedTask = publicTaskRequest({
  request_id: "req_failed_after_generated",
  status: "failed",
  generated_task_id: "task_generated_after_rpc_recovery",
  last_error: "RPC broken",
  created_at: now,
  updated_at: now,
  metadata_json: {},
});

assert.equal(failedWithGeneratedTask.isActive, false);
assert.equal(failedWithGeneratedTask.isProcessing, false);
assert.equal(failedWithGeneratedTask.needsAttention, false);
assert.equal(failedWithGeneratedTask.isTerminal, true);
assert.equal(failedWithGeneratedTask.canRetry, false);

console.log("task request public state smoke ok");
