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
assert.equal(userFailedRequest.canRetry, true);
assert.equal(userFailedRequest.lastError, "context_ipfs_fetch_failed");

console.log("task request public state smoke ok");
