import assert from "node:assert/strict";

import {
  taskDetailControlsBlocked,
  taskDetailRefreshErrorState,
} from "../src/features/tasks/task-detail-loading-state.js";

assert.equal(
  taskDetailControlsBlocked({ loading: true, data: null }),
  true,
  "initial task detail load must block controls until data exists"
);

assert.equal(
  taskDetailControlsBlocked({ loading: true, data: { task: { taskId: "task_1", statusKey: "proposed" } } }),
  false,
  "background task detail refresh must leave existing task controls usable"
);

assert.equal(
  taskDetailControlsBlocked({ loading: false, data: { task: { taskId: "task_1", statusKey: "proposed" } } }),
  false,
  "loaded task detail must leave controls usable"
);

const staleDetail = {
  data: { task: { taskId: "task_1", statusKey: "proposed" }, actions: { canAccept: true } },
  error: "",
  loading: true,
};
const retainedOnRefreshError = taskDetailRefreshErrorState(staleDetail, "network_error");
assert.equal(
  retainedOnRefreshError.data,
  staleDetail.data,
  "background refresh errors must retain the last usable task detail"
);
assert.equal(retainedOnRefreshError.error, "network_error");
assert.equal(retainedOnRefreshError.loading, false);

assert.deepEqual(
  taskDetailRefreshErrorState({ data: null, error: "", loading: true }, "task_detail_unavailable"),
  { data: null, error: "task_detail_unavailable", loading: false },
  "initial load errors should not synthesize missing detail data"
);

console.log("task-detail-loading-state-smoke: ok");
