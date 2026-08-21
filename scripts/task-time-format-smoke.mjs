import assert from "node:assert/strict";
import {
  formatTaskDeadline,
  formatTaskTimestamp,
  taskDeadlineHasExplicitTime,
} from "../shared/task-time-format.js";

const midnightDeadline = formatTaskDeadline("2026-05-20T00:00:00.000Z", {
  locale: "en-US",
  timeZone: "UTC",
});
assert.equal(midnightDeadline, "May 20");
assert.equal(taskDeadlineHasExplicitTime("2026-05-20T00:00:00.000Z"), false);
assert.equal(midnightDeadline.includes("12:00"), false);

const explicitDeadline = formatTaskDeadline("2026-05-20T15:30:00.000Z", {
  locale: "en-US",
  timeZone: "UTC",
});
assert.match(explicitDeadline, /May 20/);
assert.match(explicitDeadline, /3:30/);
assert.match(explicitDeadline, /UTC/);
assert.equal(taskDeadlineHasExplicitTime("2026-05-20T15:30:00.000Z"), true);

const reviewTimestamp = formatTaskTimestamp("2026-05-19T15:42:18.748Z", {
  locale: "en-US",
  timeZone: "UTC",
});
assert.match(reviewTimestamp, /May 19/);
assert.match(reviewTimestamp, /3:42/);
assert.match(reviewTimestamp, /UTC/);

console.log("task time format smoke ok");
