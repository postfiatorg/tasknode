import { startMemoryWorker } from "./chat-memory-worker.js";
import { startHiveSecretaryWorker } from "./hive-secretary-worker.js";
import { startHiveProjectWorker } from "./hive-project-worker.js";
import { startHiveReportsWorker } from "./hive-reports-worker.js";
import { startIpfsReplicationWorker } from "./ipfs-replication-worker.js";
import { startNetworkTaskGenerationWorker } from "./network-task-generation-worker.js";
import { startPftlCacheRetentionWorker } from "./pftl-cache-maintenance.js";
import { startPftlCacheReducerWorker } from "./pftl-cache-reducer.js";
import { startPftlArchiveWorker, startPftlCacheWorker } from "./pftl-cache-sync.js";
import { startPftlCacheWatcher } from "./pftl-cache-watcher.js";
import { startDailyAirdropWorker } from "./profile-daily-airdrop-worker.js";
import { startRecommendedConnectionsWorker } from "./recommended-connections-worker.js";
import { startContextRewriteWorker } from "./context-rewrite-worker.js";
import { startTaskGenerationWorker } from "./task-generation-worker.js";
import { startTaskReviewWorker } from "./task-review-worker.js";

export function startBackgroundWorkers() {
  startMemoryWorker();
  startHiveSecretaryWorker();
  startHiveProjectWorker();
  startHiveReportsWorker();
  startIpfsReplicationWorker();
  startNetworkTaskGenerationWorker();
  startPftlCacheWorker();
  startPftlArchiveWorker();
  startPftlCacheWatcher();
  startPftlCacheReducerWorker();
  startPftlCacheRetentionWorker();
  startDailyAirdropWorker();
  startRecommendedConnectionsWorker();
  startContextRewriteWorker();
  startTaskGenerationWorker();
  startTaskReviewWorker();
}
