import { databaseEnabled, databaseStatus, poolMetrics } from "./db/pool.js";
import {
  intEnv,
  summarizeCategories,
  tableMap,
  workerHeartbeatStatus,
} from "./system-status-base.js";
import { chatPricingStatus } from "./model-pricing-status.js";
import {
  WORKER_HEARTBEAT_GROUPS,
  inferWorkerGroup,
  readWorkerGroupHeartbeats,
  workerHeartbeatScope as workerHeartbeatScopeMetadata,
} from "./background-worker-liveness.js";
import {
  DEFAULT_BOARD_MANAGER_COST_DAYS,
  DEFAULT_NETWORK_TASK_SPEND_DAYS,
  agentActivityUnavailable,
  boardManagerDailyCostUnavailable,
  readAgentActivity,
  readBoardManagerDailyCost,
  readNetworkTaskSpendByDay,
  networkTaskSpendUnavailable,
  safeStatusRead,
} from "./system-status-readers.js";
import {
  boardManagerItem,
  boardManagerSecretaryPacketItem,
  contextRewriteItem,
  hiveBoardSecretaryMemoItem,
  hiveQueueItem,
  networkTaskGenerationItem,
  taskGenerationItem,
  taskReviewItem,
} from "./system-status-task-workers.js";
import {
  pftlReducerItem,
  pftlRetentionItem,
  pftlSyncItems,
  pftlWatcherItem,
  rpcItems,
} from "./system-status-pftl.js";
import {
  dailyAirdropItem,
  dailyProfileNftItem,
  jobsPgvectorCorpusItem,
  memoryQueueItem,
} from "./system-status-aux-workers.js";

export { evaluateDailyProfileNftWorkerState } from "./system-status-profile-nft.js";
export {
  boardManagerCostWindowDays,
  networkTaskSpendWindowDays,
  readAgentActivity,
  readBoardManagerDailyCost,
  readNetworkTaskSpendByDay,
} from "./system-status-readers.js";
export {
  DAILY_AIRDROP_DEBT_SUMMARY_SQL,
  dailyAirdropDebtStaleThresholds,
} from "./system-status-aux-workers.js";

async function categoryItems(tables, nowMs) {
  const hiveItems = [
    await boardManagerItem(tables, nowMs),
    await hiveBoardSecretaryMemoItem(tables, nowMs),
    await boardManagerSecretaryPacketItem(tables, nowMs),
    await hiveQueueItem({
      tables,
      id: "hive_secretary",
      title: "Hive Secretary Worker",
      description: "Builds the network context report from validated Hive inputs.",
      owner: "worker process",
      jobTable: "hive_secretary_jobs",
      resultTable: "hive_secretary_reports",
      resultTimeColumn: "completed_at",
      enabled: process.env.TASKNODE_HIVE_SECRETARY_ENABLED !== "false",
      trigger: "validated Hive Context input",
      cadence: `${intEnv(process.env.TASKNODE_HIVE_SECRETARY_INTERVAL_MS, 15000, { min: 1000 })}ms`,
      nowMs,
    }),
    await hiveQueueItem({
      tables,
      id: "hive_active_projects",
      title: "Hive Active Projects Helper",
      description: "Refreshes the active project registry after Secretary reports.",
      owner: "worker process",
      jobTable: "hive_project_planning_jobs",
      resultTable: "hive_project_generations",
      resultTimeColumn: "completed_at",
      enabled: process.env.TASKNODE_HIVE_PROJECT_WORKER_ENABLED !== "false",
      trigger: "Hive Secretary completion",
      cadence: `${intEnv(process.env.TASKNODE_HIVE_PROJECT_INTERVAL_MS, 60000, { min: 15000 })}ms`,
      nowMs,
    }),
  ];

  const taskItems = [
    await contextRewriteItem(tables),
    await networkTaskGenerationItem(tables, nowMs),
    await taskGenerationItem(tables, nowMs),
    await taskReviewItem(tables, nowMs),
  ];

  const syncItems = await pftlSyncItems(tables, nowMs);
  const pftlItems = [
    ...syncItems,
    await pftlWatcherItem(tables, nowMs),
    await pftlReducerItem(tables, nowMs),
    await pftlRetentionItem(tables, nowMs),
    ...rpcItems(syncItems),
  ];

  const memoryItems = [
    await jobsPgvectorCorpusItem(tables),
    await memoryQueueItem({
      tables,
      id: "chat_turn_memory",
      title: "Turn Memory Worker",
      description: "Summarizes individual user/assistant chat turns.",
      jobTable: "chat_memory_jobs",
      entryKind: "turn_memory",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "assistant chat message",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await memoryQueueItem({
      tables,
      id: "rewarded_task_memory",
      title: "Rewarded Task Memory Worker",
      description: "Persists each positive rewarded task as durable user memory using DeepSeek Flash.",
      jobTable: "task_reward_memory_jobs",
      entryKind: "rewarded_task_memory",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "canonical positive task reward",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await memoryQueueItem({
      tables,
      id: "deep_memory",
      title: "Deep Memory Worker",
      description: "Compresses batches of turn memory into account-level memory.",
      jobTable: "chat_deep_memory_jobs",
      entryKind: "deep_memory",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "turn memory block threshold",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await memoryQueueItem({
      tables,
      id: "network_task_profile",
      title: "Network Task Profile Worker",
      description: "Builds compact routing profiles for future Network Tasks.",
      jobTable: "network_task_profile_jobs",
      resultTable: "network_task_profiles",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "profile refresh request or prompt version change",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await dailyAirdropItem(tables, nowMs),
    await dailyProfileNftItem(tables, nowMs),
  ];

  return [
    {
      id: "hive",
      title: "Hive And Board Agents",
      summary: "Board Manager, Secretary, project planning, and board compression jobs.",
      items: hiveItems,
    },
    {
      id: "task_engine",
      title: "Task Systems",
      summary: "Network Task generation, task offer generation, and verification/reward review.",
      items: taskItems,
    },
    {
      id: "pftl",
      title: "PFTL And RPCs",
      summary: "Current and archive RPC paths, websocket watcher, wallet sync, reducer, and retention.",
      items: pftlItems,
    },
    {
      id: "memory",
      title: "Memory, Retrieval, Profiles, And Airdrops",
      summary: "Jobs pgvector retrieval, chat memory, routing profiles, and daily airdrop scoring/issuance.",
      items: memoryItems,
    },
  ];
}

export async function readSystemStatus({
  networkSpendDays = DEFAULT_NETWORK_TASK_SPEND_DAYS,
  boardManagerCostDays = DEFAULT_BOARD_MANAGER_COST_DAYS,
  workerHeartbeatGroup = null,
} = {}) {
  const generatedAt = new Date();
  const nowMs = generatedAt.getTime();
  const selfGroup = workerHeartbeatGroup || inferWorkerGroup();
  const workerHeartbeatScope = workerHeartbeatScopeMetadata({ selfGroup });
  const workerHeartbeats = workerHeartbeatStatus(
    readWorkerGroupHeartbeats({
      now: nowMs,
      groups: WORKER_HEARTBEAT_GROUPS,
      selfGroup,
    }),
    WORKER_HEARTBEAT_GROUPS,
    { selfGroup }
  );
  const database = databaseStatus();
  const databasePool = poolMetrics();
  if (!databaseEnabled()) {
    const [categories, chatPricing, networkTaskSpendByDay, boardManagerDailyCost, agentActivity] = await Promise.all([
      categoryItems(new Map(), nowMs),
      chatPricingStatus(),
      readNetworkTaskSpendByDay({ tables: new Map(), days: networkSpendDays }),
      readBoardManagerDailyCost({ tables: new Map(), days: boardManagerCostDays }),
      readAgentActivity({ tables: new Map(), databaseReady: false }),
    ]);
    return {
      ok: true,
      generatedAt: generatedAt.toISOString(),
      database,
      databasePool,
      workerHeartbeats,
      workerHeartbeatScope,
      summary: summarizeCategories(categories),
      chatPricing,
      networkTaskSpendByDay,
      boardManagerDailyCost,
      agentActivity,
      categories,
    };
  }
  const tables = await tableMap();
  const [categories, chatPricing, networkTaskSpendByDay, boardManagerDailyCost, agentActivity] = await Promise.all([
    safeStatusRead(categoryItems(tables, nowMs), []),
    safeStatusRead(chatPricingStatus(), { ok: false, modes: [], live: { enabled: false, status: "unknown" } }),
    safeStatusRead(
      readNetworkTaskSpendByDay({ tables, days: networkSpendDays }),
      () => networkTaskSpendUnavailable({ days: networkSpendDays })
    ),
    safeStatusRead(
      readBoardManagerDailyCost({ tables, days: boardManagerCostDays }),
      () => boardManagerDailyCostUnavailable({ days: boardManagerCostDays })
    ),
    safeStatusRead(
      readAgentActivity({ tables }),
      () => agentActivityUnavailable({ reason: "query_failed" })
    ),
  ]);
  return {
    ok: true,
    generatedAt: generatedAt.toISOString(),
    database,
    databasePool,
    workerHeartbeats,
    workerHeartbeatScope,
    summary: summarizeCategories(categories),
    chatPricing,
    networkTaskSpendByDay,
    boardManagerDailyCost,
    agentActivity,
    categories,
  };
}

export async function handleSystemStatusRoute({ json, res, url } = {}) {
  if (url.pathname !== "/api/system/status") return false;
  const status = await readSystemStatus({
    networkSpendDays: url.searchParams.get("networkSpendDays") || DEFAULT_NETWORK_TASK_SPEND_DAYS,
    boardManagerCostDays: url.searchParams.get("boardManagerCostDays") || DEFAULT_BOARD_MANAGER_COST_DAYS,
  });
  json(res, 200, status);
  return true;
}
