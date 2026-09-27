import { startBackgroundWorkerKeepalive, backgroundWorkerLivenessSelfCheck } from "./background-worker-liveness.js";
import { startBackgroundWorkers } from "./background-workers.js";
import { waitForDatabase } from "./db/migrate.js";
import { closePool } from "./db/pool.js";
import { shouldStartBackgroundWorkers, shouldStartHttpServer, tasknodeProcessRole } from "./process-role.js";
import { installGracefulShutdown, installProcessHardening } from "./process-hardening.js";

installProcessHardening();

const role = tasknodeProcessRole();
if (!shouldStartBackgroundWorkers(role) || shouldStartHttpServer(role)) {
  throw new Error(`worker_entry_requires_split_worker_role:${role}`);
}

installGracefulShutdown({ drain: () => closePool() });
await waitForDatabase();
const startup = startBackgroundWorkers({ role });
const liveness = startBackgroundWorkerKeepalive();
console.log("tasknodeofficial worker started", JSON.stringify(backgroundWorkerLivenessSelfCheck({
  role,
  startup,
  liveness,
})));
