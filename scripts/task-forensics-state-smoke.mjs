import assert from "node:assert/strict";

import {
  shouldShowIndexedTaskEventsLoading,
  taskForensicsExpectedEventCount,
  taskForensicsIndexedEventCount,
  taskForensicsIndexedEventLabel,
  taskForensicsTimeline,
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

const mismatchedDetail = {
  task: { taskId: "task_forensics" },
  forensics: {
    eventCount: 2,
    timeline: [],
    reducerEvents: [],
    integrity: { expectedEventCount: 2, missingTimelineRows: true },
  },
};
assert.equal(taskForensicsTimeline(mismatchedDetail.forensics).length, 0);
assert.equal(taskForensicsExpectedEventCount(mismatchedDetail.forensics), 2);
assert.equal(
  taskForensicsIndexedEventLabel({ indexedCount: 0, expectedCount: 2 }),
  "0 / 2 indexed"
);
assert.equal(
  taskForensicsIndexedEventCount({ detail: mismatchedDetail, task: { metadata: { eventCount: 2 } } }),
  0,
  "loaded detail must not report projection event_count as indexed rows when no event rows returned"
);
assert.equal(
  taskForensicsIndexedEventCount({
    detail: { partial: true, forensics: { eventCount: 2, timeline: [] } },
    task: { metadata: { eventCount: 2 } },
  }),
  2,
  "partial list data may still show projection event_count until full forensics detail loads"
);

console.log("task-forensics-state-smoke ok");
