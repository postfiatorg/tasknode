import { startMemoryWorker } from "./chat-memory-worker.js";
import { startHiveSecretaryWorker } from "./hive-secretary-worker.js";
import { startHiveProjectWorker } from "./hive-project-worker.js";
import { startHiveReportsWorker } from "./hive-reports-worker.js";
import { startHiveTaskManagerWorker } from "./hive-task-manager-worker.js";
import { startTaskAccountingHarvesterWorker } from "./task-accounting-harvester-worker.js";
import { startBmNarratorWorker } from "./bm-narrator-worker.js";
import { startIpfsReplicationWorker } from "./ipfs-replication-worker.js";
import { startNetworkTaskGenerationWorker } from "./network-task-generation-worker.js";
import { startPftlCacheRetentionWorker } from "./pftl-cache-maintenance.js";
import { startPftlCacheReducerWorker } from "./pftl-cache-reducer.js";
import { startPftlArchiveWorker, startPftlCacheWorker } from "./pftl-cache-sync.js";
import { startPftlCacheWatcher } from "./pftl-cache-watcher.js";
import { startDailyAirdropWorker } from "./profile-daily-airdrop-worker.js";
import { startDailyProfileNftWorker } from "./profile-nft-daily-worker.js";
import { startProfileNftRenderWorker } from "./profile-nft-render-worker.js";
import { startPublicProfileSnapshotWorker } from "./public-profile-snapshot-worker.js";
import { startRecommendedConnectionsWorker } from "./recommended-connections-worker.js";
import { startContextRewriteWorker } from "./context-rewrite-worker.js";
import { startDataRetentionWorker } from "./data-retention.js";
import { startTaskGenerationWorker } from "./task-generation-worker.js";
import { startTaskReviewWorker } from "./task-review-worker.js";
import { isMonolithWorkerRole, tasknodeProcessRole } from "./process-role.js";

function productionMonolithBlocked(role = tasknodeProcessRole()) {
  const production = process.env.NODE_ENV === "production" || process.env.TASKNODE_ENV === "production";
  return production &&
    isMonolithWorkerRole(role) &&
    process.env.TASKNODE_ALLOW_MONOLITH_WORKER !== "true";
}

function startPftlWorkers(startOne) {
  startOne("ipfs_replication", startIpfsReplicationWorker);
  startOne("pftl_cache", startPftlCacheWorker);
  startOne("pftl_archive", startPftlArchiveWorker);
  startOne("pftl_cache_watcher", startPftlCacheWatcher);
  startOne("pftl_cache_reducer", startPftlCacheReducerWorker);
  startOne("pftl_cache_retention", startPftlCacheRetentionWorker);
}

function startTaskgenWorkers(startOne) {
  startOne("network_task_generation", startNetworkTaskGenerationWorker);
  startOne("task_generation", startTaskGenerationWorker);
}

function startTaskReviewWorkers(startOne) {
  startOne("task_review", startTaskReviewWorker);
}

function startContextRewriteWorkers(startOne) {
  startOne("context_rewrite", startContextRewriteWorker);
}

function startHiveWorkers(startOne) {
  startOne("hive_secretary", startHiveSecretaryWorker);
  startOne("hive_project", startHiveProjectWorker);
  startOne("hive_reports", startHiveReportsWorker);
  startOne("hive_task_manager", startHiveTaskManagerWorker);
  startOne("task_accounting_harvester", startTaskAccountingHarvesterWorker);
  startOne("bm_narrator", startBmNarratorWorker);
}

function startMemoryProfileWorkers(startOne) {
  startOne("data_retention", startDataRetentionWorker);
  startOne("chat_memory", startMemoryWorker);
  startOne("public_profile_snapshot", startPublicProfileSnapshotWorker);
  startOne("recommended_connections", startRecommendedConnectionsWorker);
}

function startAirdropWorkers(startOne) {
  startOne("daily_airdrop", startDailyAirdropWorker);
  startOne("daily_profile_nft", startDailyProfileNftWorker);
}

export function startBackgroundWorkers({ role = tasknodeProcessRole(), runWorker = (start) => start() } = {}) {
  const startedWorkerGroups = [];
  const startOne = (name, start) => {
    runWorker(start);
    startedWorkerGroups.push(name);
  };
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
    startPftlWorkers(startOne);
    startTaskgenWorkers(startOne);
    startTaskReviewWorkers(startOne);
    startContextRewriteWorkers(startOne);
    startHiveWorkers(startOne);
    startMemoryProfileWorkers(startOne);
    startAirdropWorkers(startOne);
    return { role, startedWorkerGroups };
  }
  if (role === "worker:pftl") startPftlWorkers(startOne);
  else if (role === "worker:taskgen") startTaskgenWorkers(startOne);
  else if (role === "worker:task-review") startTaskReviewWorkers(startOne);
  else if (role === "worker:context-rewrite") startContextRewriteWorkers(startOne);
  else if (role === "worker:hive") startHiveWorkers(startOne);
  else if (role === "worker:memory-profile") startMemoryProfileWorkers(startOne);
  else if (role === "worker:airdrop") startAirdropWorkers(startOne);
  else if (role === "worker:nft-renderer") startOne("profile_nft_renderer", startProfileNftRenderWorker);
  else throw new Error(`unknown_background_worker_role:${role}`);
  return { role, startedWorkerGroups };
}
