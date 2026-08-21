#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.DATABASE_URL = "";

const {
  DEFAULT_WORKER_HEARTBEAT_STALE_AFTER_MS,
  WORKER_HEARTBEAT_GROUPS,
  inferWorkerGroup,
  readWorkerGroupHeartbeat,
  readWorkerGroupHeartbeats,
  recordWorkerGroupHeartbeat,
  resetBackgroundWorkerKeepaliveForTests,
  resetWorkerHeartbeatsForTests,
  startBackgroundWorkerKeepalive,
  stopBackgroundWorkerKeepalive,
  workerHeartbeatScope,
} = await import("../server/background-worker-liveness.js");
const {
  normalizeHeartbeatMap,
  reportViolations,
} = await import("./fleet-watch.mjs");

const selfGroup = "worker-hive";
let clock = 1_000_000;
const now = () => clock;
let intervalTick = null;

function fakeInterval(callback) {
  intervalTick = callback;
  return { constructor: { name: "FakeInterval" }, hasRef: () => true };
}

function startedMachine(group, id) {
  return {
    id,
    state: "started",
    config: {
      metadata: { fly_process_group: group },
      restart: { policy: "always" },
    },
  };
}

resetWorkerHeartbeatsForTests();
resetBackgroundWorkerKeepaliveForTests();

assert.equal(inferWorkerGroup({ TASKNODE_PROCESS_ROLE: "worker:memory-profile" }), "worker-memory-profile");
assert.equal(inferWorkerGroup({ TASKNODE_PROCESS_ROLE: "web" }), "app");
assert.deepEqual(workerHeartbeatScope({ selfGroup }), {
  scope: "this_process_only",
  selfGroup,
  crossProcessHeartbeats: "unavailable_round1",
});

const empty = readWorkerGroupHeartbeats({
  now,
  groups: [selfGroup, "worker-taskgen"],
  selfGroup,
});
assert.equal(empty[0].coverage, "self");
assert.equal(empty[0].availability, "missing");
assert.equal(empty[0].stale, true);
assert.equal(empty[1].coverage, "unobserved");
assert.equal(empty[1].availability, "missing");
assert.equal(empty[1].stale, true);
assert.equal(
  readWorkerGroupHeartbeat({ group: "worker-taskgen", now, groups: ["worker-taskgen"], selfGroup }).coverage,
  "unobserved"
);

startBackgroundWorkerKeepalive({
  setIntervalImpl: fakeInterval,
  clearIntervalImpl: () => {},
  group: selfGroup,
  now,
});
assert.equal(typeof intervalTick, "function", "keepalive schedules a real tick");
let heartbeat = readWorkerGroupHeartbeat({ group: selfGroup, now, groups: [selfGroup], selfGroup });
assert.equal(heartbeat.coverage, "self");
assert.equal(heartbeat.lastTickAt, new Date(clock).toISOString());
assert.equal(heartbeat.stale, false);

clock += 1000;
intervalTick();
heartbeat = readWorkerGroupHeartbeat({ group: selfGroup, now, groups: [selfGroup], selfGroup });
assert.equal(heartbeat.lastTickAt, new Date(clock).toISOString());
assert.equal(heartbeat.stale, false);

clock += 10 * 60_000 + 1;
heartbeat = readWorkerGroupHeartbeat({ group: selfGroup, now, groups: [selfGroup], selfGroup });
assert.equal(heartbeat.stale, true, "a stopped local keepalive becomes stale");
assert.ok(heartbeat.ageMs > DEFAULT_WORKER_HEARTBEAT_STALE_AFTER_MS);

stopBackgroundWorkerKeepalive();
resetBackgroundWorkerKeepaliveForTests();
resetWorkerHeartbeatsForTests();

clock = Date.now();
startBackgroundWorkerKeepalive({
  setIntervalImpl: fakeInterval,
  clearIntervalImpl: () => {},
  group: selfGroup,
  now,
});
clock += 1;
intervalTick();
const hiveTickIso = new Date(clock).toISOString();

const { readSystemStatus } = await import("../server/system-status.js");
const status = await readSystemStatus({ workerHeartbeatGroup: selfGroup });
assert.equal(status.ok, true);
assert.deepEqual(status.workerHeartbeatScope, {
  scope: "this_process_only",
  selfGroup,
  crossProcessHeartbeats: "unavailable_round1",
});
assert.equal(status.workerHeartbeats.length, WORKER_HEARTBEAT_GROUPS.length);
assert.deepEqual(status.workerHeartbeats.map((entry) => entry.group), WORKER_HEARTBEAT_GROUPS);
const hiveLive = status.workerHeartbeats.find((entry) => entry.group === selfGroup);
assert.equal(hiveLive.coverage, "self");
assert.equal(hiveLive.lastTickAt, hiveTickIso);
assert.equal(hiveLive.stale, false);
const taskgenLive = status.workerHeartbeats.find((entry) => entry.group === "worker-taskgen");
assert.equal(taskgenLive.coverage, "unobserved");
assert.equal(taskgenLive.lastTickAt, null);
assert.equal(taskgenLive.stale, true);

const machines = WORKER_HEARTBEAT_GROUPS.map((group, index) => startedMachine(group, `machine-${index}`));
machines.push({
  id: "app-standby",
  state: "started",
  config: {
    metadata: { fly_process_group: "app" },
    restart: { policy: "always" },
    standbys: ["app"],
  },
});
const heartbeatSurfaceWithGap = status.workerHeartbeats.filter((entry) => entry.group !== "worker-taskgen");
const report = reportViolations({
  machines,
  heartbeatMap: normalizeHeartbeatMap(heartbeatSurfaceWithGap),
  heartbeatSurfacePresent: true,
});
assert.equal(report.violations.length, 1, "an expected group missing inside a claimed surface must violate");
assert.deepEqual(report.violations[0].group, "worker-taskgen");
assert.deepEqual(report.violations[0].violations, ["heartbeat_entry_missing"]);
assert.equal(report.inventory.find((row) => row.group === "app").standbyCount, 1);
assert.equal(report.crossProcessHeartbeats, "unavailable_round1");

recordWorkerGroupHeartbeat({ group: "worker-taskgen", nowMs: clock });
const unobservedReport = reportViolations({
  machines,
  heartbeatMap: normalizeHeartbeatMap([
    { group: selfGroup, coverage: "self", availability: "available", stale: false },
    { group: "worker-taskgen", coverage: "unobserved", availability: "missing", stale: true },
  ]),
  heartbeatSurfacePresent: true,
});
assert.equal(
  unobservedReport.violations.some((violation) => violation.group === "worker-taskgen"),
  false,
  "unobserved heartbeat values are informational, not fleet evidence"
);

stopBackgroundWorkerKeepalive();
resetBackgroundWorkerKeepaliveForTests();
resetWorkerHeartbeatsForTests();

const webGroup = inferWorkerGroup({ TASKNODE_PROCESS_ROLE: "web" });
clock = 7_000_000;
startBackgroundWorkerKeepalive({
  setIntervalImpl: fakeInterval,
  clearIntervalImpl: () => {},
  group: webGroup,
  now,
});
const webHeartbeat = readWorkerGroupHeartbeat({ group: "app", now, groups: ["app"], selfGroup: webGroup });
assert.equal(webHeartbeat.coverage, "self");
assert.equal(webHeartbeat.availability, "available");
assert.equal(webHeartbeat.stale, false);
const healthyAppReport = reportViolations({
  machines,
  heartbeatMap: normalizeHeartbeatMap(WORKER_HEARTBEAT_GROUPS.map((group) => (
    group === "app"
      ? { group, coverage: "self", availability: "available", stale: false, lastTickAt: webHeartbeat.lastTickAt }
      : { group, coverage: "unobserved", availability: "missing", stale: true, lastTickAt: null }
  ))),
  heartbeatSurfacePresent: true,
});
assert.equal(healthyAppReport.violations.length, 0, "a healthy app self-heartbeat must not create fleet violations");

stopBackgroundWorkerKeepalive();
resetBackgroundWorkerKeepaliveForTests();
resetWorkerHeartbeatsForTests();

console.log("fleet-heartbeat-smoke ok");
