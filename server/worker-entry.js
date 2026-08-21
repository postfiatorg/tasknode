import { startBackgroundWorkerKeepalive, backgroundWorkerLivenessSelfCheck } from "./background-worker-liveness.js";
import { startBackgroundWorkers } from "./background-workers.js";
import { migrateDatabase } from "./db/migrate.js";
import { shouldStartBackgroundWorkers, shouldStartHttpServer, tasknodeProcessRole } from "./process-role.js";
import { installProcessHardening } from "./process-hardening.js";

installProcessHardening();

const role = tasknodeProcessRole();
if (!shouldStartBackgroundWorkers(role) || shouldStartHttpServer(role)) {
  throw new Error(`worker_entry_requires_split_worker_role:${role}`);
}

await migrateDatabase();
const startup = startBackgroundWorkers({ role });
const liveness = startBackgroundWorkerKeepalive();
console.log("tasknodeofficial worker started", JSON.stringify(backgroundWorkerLivenessSelfCheck({
  role,
  startup,
  liveness,
})));
