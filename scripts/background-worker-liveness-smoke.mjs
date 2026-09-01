import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { startBackgroundWorkers } from "../server/background-workers.js";
import {
  backgroundWorkerLivenessStatus,
  backgroundWorkerLivenessSelfCheck,
  resetBackgroundWorkerKeepaliveForTests,
  startBackgroundWorkerKeepalive,
} from "../server/background-worker-liveness.js";

const noOpWorker = () => {};
const airdrop = startBackgroundWorkers({ role: "worker:airdrop", runWorker: noOpWorker });
assert.deepEqual(airdrop, {
  role: "worker:airdrop",
  startedWorkerGroups: ["daily_airdrop", "daily_profile_nft"],
});

const hive = startBackgroundWorkers({ role: "worker:hive", runWorker: noOpWorker });
assert.deepEqual(hive.startedWorkerGroups, [
  "hive_secretary",
  "hive_project",
  "hive_reports",
  "hive_task_manager",
  "task_accounting_harvester",
  "bm_narrator",
]);
const taskgen = startBackgroundWorkers({ role: "worker:taskgen", runWorker: noOpWorker });
assert.deepEqual(taskgen.startedWorkerGroups, ["network_task_generation", "task_generation"]);
const memoryProfile = startBackgroundWorkers({ role: "worker:memory-profile", runWorker: noOpWorker });
assert.deepEqual(memoryProfile.startedWorkerGroups, [
  "data_retention",
  "chat_memory",
  "team_context",
  "public_profile_snapshot",
  "recommended_connections",
]);

let clearCount = 0;
const fakeHandle = { constructor: { name: "FakeInterval" }, hasRef: () => true };
const injected = startBackgroundWorkerKeepalive({
  setIntervalImpl: () => fakeHandle,
  clearIntervalImpl: () => { clearCount += 1; },
});
assert.equal(injected.heldHandle.name, "background_worker_liveness_keepalive");
assert.equal(injected.heldHandle.type, "FakeInterval");
assert.equal(injected.heldHandle.referenced, true);
assert.equal(backgroundWorkerLivenessStatus().active, true);
assert.deepEqual(backgroundWorkerLivenessSelfCheck({
  role: airdrop.role,
  startup: airdrop,
  liveness: injected,
}), {
  role: "worker:airdrop",
  heldHandle: injected.heldHandle,
  startedWorkerGroups: ["daily_airdrop", "daily_profile_nft"],
});
assert.equal(resetBackgroundWorkerKeepaliveForTests().active, false);
assert.equal(clearCount, 1);

const helperUrl = new URL("../server/background-worker-liveness.js", import.meta.url).href;
const child = spawn(process.execPath, [
  "--input-type=module",
  "-e",
  `import { startBackgroundWorkerKeepalive, backgroundWorkerLivenessStatus } from ${JSON.stringify(helperUrl)}; console.log(JSON.stringify(startBackgroundWorkerKeepalive()));`,
], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.setEncoding("utf8");
const output = await Promise.race([
  once(child.stdout, "data").then(([data]) => String(data)),
  new Promise((_, reject) => setTimeout(() => reject(new Error("liveness_child_start_timeout")), 3000)),
]);
assert.match(output, /background_worker_liveness_keepalive/);
await new Promise((resolve) => setTimeout(resolve, 150));
assert.equal(child.exitCode, null, "referenced keepalive must keep a worker-only process alive");
child.kill("SIGTERM");
await once(child, "exit");

console.log("background-worker-liveness-smoke ok");
