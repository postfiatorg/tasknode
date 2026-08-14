import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.DATABASE_URL = "";
process.env.PFTL_CACHE_WORKER_ENABLED = "true";
process.env.PFTL_CACHE_ARCHIVE_WORKER_ENABLED = "true";
process.env.PFTL_CACHE_WSS_WATCHER_ENABLED = "true";
process.env.PFTL_CACHE_REDUCER_WORKER_ENABLED = "true";
process.env.PFTL_CACHE_RETENTION_WORKER_ENABLED = "true";
process.env.TASKNODE_TASK_GENERATION_WORKER_ENABLED = "true";
process.env.TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED = "true";
process.env.TASKNODE_TASK_REVIEW_WORKER_ENABLED = "true";
process.env.TASKNODE_DAILY_AIRDROP_WORKER_ENABLED = "true";
process.env.TASKNODE_SYSTEM_STATUS_LIVE_PRICING_ENABLED = "false";
process.env.AMBIENT_API_KEY = "system-status-ambient-key";
process.env.PFTL_RPC_URL = "https://user:pass@rpc.example.test/current?api_key=secret#frag";
process.env.PFTL_HISTORY_RPC_URL = "https://history.example.test/archive?token=secret";
process.env.ETH_DEPOSIT_XPUB = "xpub_status_smoke";
process.env.ETH_DEPOSIT_RPC_URL = "https://ethuser:ethpass@eth.example.test/jsonrpc?x=y";

const { handleSystemStatusRoute, readSystemStatus } = await import("../server/system-status.js");
const { routePolicyForPath } = await import("../server/route-policies.js");

const status = await readSystemStatus();
assert.equal(status.ok, true);
assert.equal(status.database.enabled, false);
assert.equal(status.summary.total, 24);
assert.equal(status.databasePool.enabled, false);
assert.equal(status.databasePool.role, "all");
assert.equal(status.databasePool.max, 6);
assert.equal(status.databasePool.maxSource, "role_default");
assert.equal(status.databasePool.waiting, 0);
assert.equal(status.chatPricing.live.enabled, false);
assert.equal(status.chatPricing.live.status, "disabled");
assert.equal(status.chatPricing.cacheEfficiency.enabled, false);
assert.equal(status.chatPricing.cacheEfficiency.status, "database_disabled");
assert.equal(status.networkTaskSpendByDay.enabled, false);
assert.equal(status.networkTaskSpendByDay.windowDays, 30);
assert.deepEqual(status.networkTaskSpendByDay.totals, { totalPft: 0, taskCount: 0 });
assert.equal(status.agentActivity.enabled, false);
assert.equal(status.agentActivity.reason, "database_disabled");
assert.deepEqual(status.agentActivity.summary, {
  agentCount: 0,
  activeAgentCount: 0,
  currentTaskCount: 0,
  recentActionCount: 0,
  rewardedTaskCount: 0,
  rewardActualPft: 0,
});
assert.equal(status.boardManagerDailyCost.enabled, false);
assert.equal(status.boardManagerDailyCost.windowDays, 30);
assert.deepEqual(status.boardManagerDailyCost.totals, {
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
});

const pricingModes = new Map(status.chatPricing.modes.map((mode) => [mode.mode, mode]));
assert.deepEqual([...pricingModes.keys()], ["Instant", "Thinking", "Help"]);
assert.equal(pricingModes.get("Instant")?.model, "deepseek/deepseek-v4-flash-0731");
assert.equal(pricingModes.get("Instant")?.maxOutputTokens, 16384);
assert.equal(pricingModes.get("Thinking")?.model, "z-ai/glm-5.2");
assert.equal(pricingModes.get("Thinking")?.reasoning, "xhigh");
assert.equal(pricingModes.get("Thinking")?.providerLabel, "Ambient");
assert.equal(pricingModes.get("Thinking")?.configuredPricing?.inputUsdPerMillion, 0.4725);
assert.equal(pricingModes.get("Thinking")?.configuredPricing?.inputCacheHitUsdPerMillion, 0.09);
assert.equal(pricingModes.get("Thinking")?.configuredPricing?.outputUsdPerMillion, 1.98);
assert.deepEqual(pricingModes.get("Thinking")?.providerOrder, []);
assert.match(pricingModes.get("Thinking")?.privacyPolicy || "", /Ambient inference/);
assert.equal(pricingModes.get("Help")?.model, "deepseek/deepseek-v4-flash-0731");
assert.equal(pricingModes.get("Help")?.providerLabel, "Ambient");
assert.equal(pricingModes.get("Help")?.reasoning, "");
assert.equal(pricingModes.get("Help")?.estimatedOutputTokens, 1200);
assert.equal(pricingModes.get("Help")?.maxOutputTokens, 1200);
assert.equal(pricingModes.get("Instant")?.configuredPricing?.inputUsdPerMillion, 0.063);
assert.equal(pricingModes.get("Instant")?.configuredPricing?.inputCacheHitUsdPerMillion, 0.0126);
assert.equal(pricingModes.get("Instant")?.configuredPricing?.outputUsdPerMillion, 0.126);
assert.match(pricingModes.get("Help")?.description || "", /plain-English Task Node product help/);

const categories = new Map(status.categories.map((category) => [category.id, category]));
assert.deepEqual([...categories.keys()], ["hive", "task_engine", "pftl", "memory"]);

const itemIds = new Set(status.categories.flatMap((category) => category.items.map((entry) => entry.id)));
for (const id of [
  "board_manager",
  "hive_board_secretary",
  "board_manager_secretary_packets",
  "hive_secretary",
  "hive_active_projects",
  "network_task_generation",
  "task_generation",
  "task_review",
  "pftl_current_rpc",
  "pftl_history_rpc",
  "ethereum_deposit_rpc",
  "jobs_pgvector_corpus",
  "chat_turn_memory",
  "rewarded_task_memory",
  "deep_memory",
  "network_task_profile",
  "daily_airdrop_worker",
  "daily_profile_nft_worker",
]) {
  assert.equal(itemIds.has(id), true, `missing status item ${id}`);
}

const pftlDetails = categories
  .get("pftl")
  .items.flatMap((entry) => entry.details || [])
  .join("\n");
const ethereumRpc = categories.get("pftl").items.find((entry) => entry.id === "ethereum_deposit_rpc");
assert.equal(ethereumRpc.status, "ok");
assert.match(pftlDetails, /https:\/\/rpc\.example\.test\/current/);
assert.match(pftlDetails, /https:\/\/history\.example\.test\/archive/);
assert.match(pftlDetails, /https:\/\/eth\.example\.test\/jsonrpc/);
assert.doesNotMatch(pftlDetails, /pass|api_key|secret|token|ethuser|ethpass/);

const policy = routePolicyForPath("/api/system/status");
assert.equal(policy?.id, "system_status");
assert.equal(policy?.auth, "none");

let captured = null;
const handled = await handleSystemStatusRoute({
  url: new URL("http://localhost/api/system/status"),
  res: {},
  json: (_res, responseStatus, body) => {
    captured = { responseStatus, body };
  },
});
assert.equal(handled, true);
assert.equal(captured.responseStatus, 200);
assert.equal(captured.body.ok, true);

const ignored = await handleSystemStatusRoute({
  url: new URL("http://localhost/api/not-system-status"),
  res: {},
  json: () => {
    throw new Error("unexpected json response");
  },
});
assert.equal(ignored, false);


const {
  evaluateDailyProfileNftWorkerState,
} = await import("../server/system-status.js");

const nowMs = Date.parse("2026-07-14T20:00:00.000Z");
const disabled = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: false,
  awardsQueryOk: true,
  counts: {},
});
assert.equal(disabled.workerState, "disabled");
assert.equal(disabled.status, "disabled");
assert.equal(disabled.reason, "worker_disabled");

const failingAuth = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
  latestAward: { status: "failed", error: "401 Incorrect API key provided: sk-test" },
  permanentFailedCount: 2,
  recentFailedCount: 2,
  counts: { failed: 2 },
});
assert.equal(failingAuth.workerState, "failing");
assert.equal(failingAuth.status, "critical");
assert.equal(failingAuth.lastErrorCode, "provider_auth_failed");
assert.match(failingAuth.reason, /provider_auth_failed|openai|auth/);

const queryFail = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: false,
  awardsQueryError: "relation profile_nft_daily_awards does not exist",
});
assert.equal(queryFail.workerState, "failing");
assert.equal(queryFail.status, "critical");
assert.equal(queryFail.reason, "database_query_failed");
assert.notEqual(queryFail.status, "ok");

const noTick = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
  counts: {},
});
assert.equal(noTick.workerState, "stale");
assert.notEqual(noTick.status, "ok");
assert.equal(noTick.reason, "no_tick_or_success");

const staleRunning = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
  oldestRunningAt: "2026-07-11T02:20:51.133Z",
  runningCount: 1,
  counts: { running: 1 },
  latestSuccessAt: "2026-07-11T02:17:45.852Z",
  heartbeat: { lastTickAt: "2026-07-11T02:20:00.000Z" },
  staleRunningMs: 10 * 60 * 1000,
});
assert.equal(staleRunning.workerState, "stale");
assert.equal(staleRunning.reason, "stale_running_award");
assert.ok(staleRunning.counts.staleRunning >= 1);

const healthy = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
  generationGated: false,
  heartbeat: {
    worker_key: "profile_nft_daily",
    last_tick_started_at: "2026-07-14T19:54:50.000Z",
    last_tick_finished_at: "2026-07-14T19:55:00.000Z",
    last_success_at: "2026-07-14T19:50:00.000Z",
    retryable_count: 0,
    permanent_count: 0,
    candidate_count: 0,
    generation_gated: false,
  },
  latestSuccessAt: "2026-07-14T19:50:00.000Z",
  counts: { generated: 10, pending: 0 },
});
assert.equal(healthy.workerState, "healthy");
assert.equal(healthy.status, "ok");
assert.equal(healthy.reason, "fresh_tick");

const gated = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  generationGated: true,
  awardsQueryOk: true,
  heartbeat: {
    worker_key: "profile_nft_daily",
    last_tick_started_at: "2026-07-14T19:54:50.000Z",
    last_tick_finished_at: "2026-07-14T19:55:00.000Z",
    generation_gated: true,
    retryable_count: 0,
    permanent_count: 0,
    candidate_count: 1,
  },
  latestSuccessAt: "2026-07-10T00:00:00.000Z",
});
assert.equal(gated.generationGated, true);
assert.equal(gated.reason, "generation_gated");
assert.notEqual(gated.reason, "fresh_tick");

const enabledOnlyNotHealthy = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
});
assert.notEqual(enabledOnlyNotHealthy.workerState, "healthy");

const nftItem = status.categories
  .flatMap((category) => category.items)
  .find((entry) => entry.id === "daily_profile_nft_worker");
assert.ok(nftItem, "daily_profile_nft_worker missing from live status");
assert.equal(nftItem.status, "disabled");
assert.match((nftItem.details || []).join("\n"), /workerState=disabled|enabled=false/i);



// Ghash exact heartbeat row shape (worker_key PK; no generic id/finished_at columns).
const ghashHeartbeatRow = {
  worker_key: "profile_nft_daily",
  last_tick_started_at: "2026-07-14T19:54:50.000Z",
  last_tick_finished_at: "2026-07-14T19:55:00.000Z",
  last_success_at: "2026-07-14T19:50:00.000Z",
  last_error_code: "",
  last_error_message: "",
  retryable_count: 2,
  permanent_count: 0,
  current_retry_award_id: "daily_nft_retry_fixture",
  next_retry_at: "2026-07-14T20:10:00.000Z",
  candidate_count: 5,
  generation_gated: false,
};
const healthyFromSnake = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
  heartbeat: ghashHeartbeatRow,
  retryableFailedCount: 0,
  permanentFailedCount: 0,
});
assert.equal(healthyFromSnake.workerState, "healthy");
assert.equal(healthyFromSnake.lastTickStartedAt, "2026-07-14T19:54:50.000Z");
assert.equal(healthyFromSnake.lastTickEndedAt, "2026-07-14T19:55:00.000Z");
assert.equal(healthyFromSnake.counts.retryableFailed, 2);
assert.equal(healthyFromSnake.currentRetryAwardId, "daily_nft_retry_fixture");
assert.equal(healthyFromSnake.nextRetryAt, "2026-07-14T20:10:00.000Z");
assert.equal(healthyFromSnake.candidateCount, 5);
assert.equal(healthyFromSnake.reason, "fresh_tick");

const permanentFromSnake = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
  heartbeat: {
    ...ghashHeartbeatRow,
    last_error_code: "openai_not_configured",
    last_error_message: "OPENAI_API_KEY missing",
    permanent_count: 3,
    retryable_count: 0,
    last_tick_finished_at: "2026-07-14T19:00:00.000Z",
  },
  permanentFailedCount: 3,
});
assert.equal(permanentFromSnake.workerState, "failing");
assert.equal(permanentFromSnake.lastErrorCode, "openai_not_configured");

// Dynamic-column regression: exact query must not request nonexistent generic columns.
const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("../server/system-status.js", import.meta.url), "utf8"));
assert.match(source, /FROM profile_nft_daily_worker_heartbeats/);
assert.match(source, /WHERE worker_key = \$1/);
assert.doesNotMatch(source, /profile_nft_daily_worker_runs/);
assert.doesNotMatch(source, /ORDER BY COALESCE\(finished_at, completed_at, heartbeat_at/);
assert.match(source, /failed_permanent/);
assert.match(source, /retry_wait/);
assert.match(source, /last_tick_started_at/);
assert.match(source, /last_tick_finished_at/);
assert.match(source, /current_retry_award_id/);
assert.match(source, /next_retry_at/);
assert.match(source, /candidate_count/);

// Top-level state/reason must not be stripped by item().
assert.equal(typeof item, "undefined");
const { item: statusItem } = await import("../server/system-status-base.js");
const shaped = statusItem({
  id: "daily_profile_nft_worker",
  category: "memory",
  title: "Daily Profile NFT Worker",
  description: "test",
  owner: "test",
  trigger: "test",
  cadence: "1ms",
  status: "ok",
  statusLabel: "Healthy",
  state: "healthy",
  reason: "fresh_tick",
});
assert.equal(shaped.state, "healthy");
assert.equal(shaped.reason, "fresh_tick");



// Durable award-table counts must not be zeroed by a fresh heartbeat that
// reports retryable_count/permanent_count 0 after a successful tick with empty
// failure list.
const durableRetryNotHidden = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
  retryableFailedCount: 2,
  permanentFailedCount: 0,
  heartbeat: {
    worker_key: "profile_nft_daily",
    last_tick_started_at: "2026-07-14T19:54:50.000Z",
    last_tick_finished_at: "2026-07-14T19:55:00.000Z",
    last_success_at: "2026-07-14T19:55:00.000Z",
    retryable_count: 0,
    permanent_count: 0,
    candidate_count: 0,
    generation_gated: false,
  },
});
assert.equal(durableRetryNotHidden.counts.retryableFailed, 2, "award retry queue must remain visible when heartbeat is 0");
assert.equal(durableRetryNotHidden.workerState, "healthy");

const durablePermanentNotHidden = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
  retryableFailedCount: 0,
  permanentFailedCount: 1,
  latestAward: { status: "failed_permanent", error: "401 Incorrect API key provided" },
  heartbeat: {
    worker_key: "profile_nft_daily",
    last_tick_started_at: "2026-07-14T19:54:50.000Z",
    last_tick_finished_at: "2026-07-14T19:55:00.000Z",
    last_success_at: "2026-07-14T19:50:00.000Z",
    last_error_code: "provider_auth_failed",
    last_error_message: "401 Incorrect API key provided",
    retryable_count: 0,
    permanent_count: 0,
    candidate_count: 0,
    generation_gated: false,
  },
});
assert.equal(durablePermanentNotHidden.counts.permanentFailed, 1);
assert.equal(durablePermanentNotHidden.workerState, "failing");
assert.equal(durablePermanentNotHidden.status, "critical");

const heartbeatHigherThanDbVisible = evaluateDailyProfileNftWorkerState({
  nowMs,
  enabled: true,
  awardsQueryOk: true,
  retryableFailedCount: 1,
  permanentFailedCount: 0,
  heartbeat: {
    worker_key: "profile_nft_daily",
    last_tick_started_at: "2026-07-14T19:54:50.000Z",
    last_tick_finished_at: "2026-07-14T19:55:00.000Z",
    last_success_at: "2026-07-14T19:50:00.000Z",
    retryable_count: 4,
    permanent_count: 0,
    candidate_count: 2,
    generation_gated: false,
  },
});
assert.equal(heartbeatHigherThanDbVisible.counts.retryableFailed, 4, "higher heartbeat count remains visible");
assert.equal(heartbeatHigherThanDbVisible.candidateCount, 2);


console.log("system status smoke ok");
