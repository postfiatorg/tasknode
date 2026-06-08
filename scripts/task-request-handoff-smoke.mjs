import assert from "node:assert/strict";

import { taskRequestHandoffState } from "../server/repositories/tasks.js";

const failed = taskRequestHandoffState({
  requests: {
    items: [{
      requestId: "req_rpc_broken",
      status: "failed",
      lastError: "RPC broken",
      needsAttention: true,
      isProcessing: false,
      updatedAt: "2026-06-08T01:00:15.000Z",
    }],
  },
  taskItems: [],
});

assert.equal(failed.requestHandoffState, "failed");
assert.equal(failed.generatedTaskVisible, false);
assert.equal(failed.needsAttention, true);

const pendingProjection = taskRequestHandoffState({
  requests: {
    items: [{
      requestId: "req_generated_pending",
      status: "proposed",
      generatedTaskId: "task_generated_pending",
      isTerminal: true,
      updatedAt: "2026-06-08T01:00:36.000Z",
    }],
  },
  taskItems: [],
});

assert.equal(pendingProjection.requestHandoffState, "generated_projection_pending");
assert.equal(pendingProjection.generatedTaskVisible, false);

const visibleProjection = taskRequestHandoffState({
  requests: {
    items: [{
      requestId: "req_generated_visible",
      status: "proposed",
      generatedTaskId: "task_generated_visible",
      isTerminal: true,
      updatedAt: "2026-06-08T01:00:36.000Z",
    }],
  },
  taskItems: [{
    taskId: "task_generated_visible",
    statusKey: "proposed",
    title: "Document RPC Failure Reproduction And Impact",
  }],
});

assert.equal(visibleProjection.requestHandoffState, "generated_visible");
assert.equal(visibleProjection.generatedTaskVisible, true);
assert.equal(visibleProjection.visibleTaskId, "task_generated_visible");

console.log("task request handoff smoke ok");
