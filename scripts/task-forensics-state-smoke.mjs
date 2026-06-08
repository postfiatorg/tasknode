import assert from "node:assert/strict";

import {
  shouldShowIndexedTaskEventsLoading,
} from "../src/features/tasks/task-forensics-state.js";

assert.equal(shouldShowIndexedTaskEventsLoading({ detail: null, loading: true }), true);
assert.equal(shouldShowIndexedTaskEventsLoading({ detail: null, loading: false }), false);
assert.equal(
  shouldShowIndexedTaskEventsLoading({
    detail: {
      task: { taskId: "task_forensics" },
      forensics: { timeline: [{ id: "event_1" }] },
    },
    loading: true,
  }),
  false,
  "background refresh must not blank an already-rendered forensics panel"
);

console.log("task-forensics-state-smoke ok");
