import { startMemoryWorker } from "./chat-memory-worker.js";
import { startHiveSecretaryWorker } from "./hive-secretary-worker.js";
import { startHiveProjectWorker } from "./hive-project-worker.js";
import { startHiveDecisionAgentWorker } from "./hive-decision-agent-worker.js";
import { startHiveReportsWorker } from "./hive-reports-worker.js";
import { startHiveTaskManagerWorker } from "./hive-task-manager-worker.js";
import { startTaskAccountingHarvesterWorker } from "./task-accounting-harvester-worker.js";
import { startIpfsReplicationWorker } from "./ipfs-replication-worker.js";
import { startNetworkTaskGenerationWorker } from "./network-task-generation-worker.js";
import { startPftlCacheRetentionWorker } from "./pftl-cache-maintenance.js";
import { startPftlCacheReducerWorker } from "./pftl-cache-reducer.js";
import { startPftlArchiveWorker, startPftlCacheWorker } from "./pftl-cache-sync.js";
import { startPftlCacheWatcher } from "./pftl-cache-watcher.js";
import { startDailyAirdropWorker } from "./profile-daily-airdrop-worker.js";
import { startDailyProfileNftWorker } from "./profile-nft-daily-worker.js";
import { startPublicProfileSnapshotWorker } from "./public-profile-snapshot-worker.js";
import { startRecommendedConnectionsWorker } from "./recommended-connections-worker.js";
import { startContextRewriteWorker } from "./context-rewrite-worker.js";
import { startTaskGenerationWorker } from "./task-generation-worker.js";
import { startTaskReviewWorker } from "./task-review-worker.js";
import { isMonolithWorkerRole, tasknodeProcessRole } from "./process-role.js";

function shouldStartHiveDecisionAgentInBackground() {
  const role = String(process.env.TASKNODE_PROCESS_ROLE || process.env.FLY_PROCESS_GROUP || "all").trim().toLowerCase();
  return role === "all" || process.env.TASKNODE_HIVE_DECISION_AGENT_RUN_IN_WORKER === "true";
}

function productionMonolithBlocked(role = tasknodeProcessRole()) {
  const production = process.env.NODE_ENV === "production" || process.env.TASKNODE_ENV === "production";
  return production &&
    isMonolithWorkerRole(role) &&
    process.env.TASKNODE_ALLOW_MONOLITH_WORKER !== "true";
}

function startPftlWorkers() {
  startIpfsReplicationWorker();
  startPftlCacheWorker();
  startPftlArchiveWorker();
  startPftlCacheWatcher();
  startPftlCacheReducerWorker();
  startPftlCacheRetentionWorker();
}

function startTaskgenWorkers() {
  startNetworkTaskGenerationWorker();
  startTaskGenerationWorker();
}

function startTaskReviewWorkers() {
  startTaskReviewWorker();
}

function startContextRewriteWorkers() {
  startContextRewriteWorker();
}

function startHiveWorkers() {
  startHiveSecretaryWorker();
  startHiveProjectWorker();
  startHiveReportsWorker();
  startHiveTaskManagerWorker();
  startTaskAccountingHarvesterWorker();
  if (shouldStartHiveDecisionAgentInBackground()) startHiveDecisionAgentWorker();
}

function startMemoryProfileWorkers() {
  startMemoryWorker();
  startPublicProfileSnapshotWorker();
  startRecommendedConnectionsWorker();
}

function startAirdropWorkers() {
  startDailyAirdropWorker();
  startDailyProfileNftWorker();
}

export function startBackgroundWorkers() {
  const role = tasknodeProcessRole();
  if (productionMonolithBlocked(role)) {
    throw new Error(
      `monolith_background_worker_disabled_in_production:${role}. ` +
        "Use split worker roles or set TASKNODE_ALLOW_MONOLITH_WORKER=true for an explicit compatibility run."
    );
  }
  if (isMonolithWorkerRole(role)) {
    console.warn("monolith_background_worker_role", {
      role,
      note: "Starting all background workers in one process. Production should use split worker roles.",
    });
    startPftlWorkers();
    startTaskgenWorkers();
    startTaskReviewWorkers();
    startContextRewriteWorkers();
    startHiveWorkers();
    startMemoryProfileWorkers();
    startAirdropWorkers();
    return;
  }
  if (role === "worker:pftl") startPftlWorkers();
  else if (role === "worker:taskgen") startTaskgenWorkers();
  else if (role === "worker:task-review") startTaskReviewWorkers();
  else if (role === "worker:context-rewrite") startContextRewriteWorkers();
  else if (role === "worker:hive") startHiveWorkers();
  else if (role === "worker:memory-profile") startMemoryProfileWorkers();
  else if (role === "worker:airdrop") startAirdropWorkers();
  else throw new Error(`unknown_background_worker_role:${role}`);
}
