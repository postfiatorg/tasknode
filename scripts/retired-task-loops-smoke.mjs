import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runtimeGraph } from "./build-runtime-tree.mjs";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
// Old operator environments cannot restore any of the removed managers.
for (const name of [
  "TASKNODE_HIVE_TASK_MANAGER_ENABLED", "TASKNODE_HIVE_TASK_MANAGER_ACTIVE",
  "TASKNODE_BOARD_MANAGER_ENABLED", "TASKNODE_BOARD_MANAGER_EXECUTION_ENABLED",
  "TASKNODE_LEGACY_BOARD_MANAGER_ENABLED", "TASKNODE_HIVE_PROJECT_WORKER_ENABLED",
  "TASKNODE_TASK_ACCOUNTING_HARVESTER_ENABLED",
]) process.env[name] = "true";

const { startBackgroundWorkers } = await import("../server/background-workers.js");
const expected = {
  "worker:hive": ["hive_group_chat", "hive_secretary", "hive_reports", "bm_narrator"],
  "worker:taskgen": ["network_task_generation", "task_generation"],
  "worker:task-review": ["task_review"],
};
for (const [role, groups] of Object.entries(expected)) {
  assert.deepEqual(startBackgroundWorkers({ role, runWorker: () => {} }).startedWorkerGroups, groups);
}
const removed = [
  "server/hive-task-manager-worker.js", "server/hive-task-manager-provider.js",
  "server/repositories/hive-task-manager.js", "server/board-manager-decision-provider.js",
  "server/repositories/board-manager-scheduler.js", "server/repositories/network-task-reward-followup.js",
  "server/hive-project-worker.js", "server/task-accounting-harvester-worker.js",
  "server/task-accounting-harvester-provider.js",
  ...["worker", "loop", "model-exec", "codex-exec", "disabled", "ops"].map((name) => `scripts/board-manager-${name}.mjs`),
];
const commands = Object.values(JSON.parse(readFileSync("package.json", "utf8")).scripts);
for (const file of removed) {
  assert.equal(existsSync(file), false, `${file} must remain deleted`);
  assert.equal(commands.some((command) => command.includes(file)), false, `${file} must have no npm launcher`);
}
for (const entries of [
  ["server/index.js"], ["server/worker-entry.js", "scripts/hive-board-secretary-worker.mjs"], ["scripts/bm.mjs"],
]) {
  const graph = runtimeGraph(entries);
  assert.deepEqual(graph.missing, [], `Unresolved imports from ${entries.join(", ")}`);
  for (const file of removed) assert.equal(graph.files.includes(file), false);
}
const kimi = runtimeGraph(["scripts/bm.mjs"]);
assert.ok(kimi.files.includes("server/board-manager-actions.js"));
assert.ok(kimi.files.includes("server/repositories/network-task-generation-jobs.js"));
const fly = readFileSync("fly.toml", "utf8");
for (const prefix of ["TASKNODE_HIVE_TASK_MANAGER_", "TASKNODE_LEGACY_BOARD_MANAGER_", "TASKNODE_HIVE_PROJECT_", "TASKNODE_TASK_ACCOUNTING_HARVESTER_"]) {
  assert.equal(fly.includes(prefix), false, `${prefix} must have no deployment configuration`);
}
console.log("retired task loops smoke ok: Kimi, task generation, review, and advisory runtime closures intact");
