#!/usr/bin/env node

import { runHiveTaskManagerOnce, startHiveTaskManagerWorker } from "../server/hive-task-manager-worker.js";

const args = new Set(process.argv.slice(2));

if (args.has("--once")) {
  const result = await runHiveTaskManagerOnce({ trigger: "manual_once" });
  console.log(JSON.stringify(result, null, 2));
} else {
  const started = startHiveTaskManagerWorker();
  console.log(`hive-task-manager-worker ${started ? "started" : "not_started"}`);
}
