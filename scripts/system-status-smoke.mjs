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
process.env.PFTL_RPC_URL = "https://user:pass@rpc.example.test/current?api_key=secret#frag";
process.env.PFTL_HISTORY_RPC_URL = "https://history.example.test/archive?token=secret";
process.env.ETH_DEPOSIT_XPUB = "xpub_status_smoke";
process.env.ETH_DEPOSIT_RPC_URL = "https://ethuser:ethpass@eth.example.test/jsonrpc?x=y";

const { handleSystemStatusRoute, readSystemStatus } = await import("../server/system-status.js");
const { routePolicyForPath } = await import("../server/route-policies.js");

const status = await readSystemStatus();
assert.equal(status.ok, true);
assert.equal(status.database.enabled, false);
assert.equal(status.summary.total, 19);

const categories = new Map(status.categories.map((category) => [category.id, category]));
assert.deepEqual([...categories.keys()], ["hive", "task_engine", "pftl", "memory"]);

const itemIds = new Set(status.categories.flatMap((category) => category.items.map((entry) => entry.id)));
for (const id of [
  "board_manager",
  "board_manager_secretary_packets",
  "hive_secretary",
  "hive_active_projects",
  "network_task_generation",
  "task_generation",
  "task_review",
  "pftl_current_rpc",
  "pftl_history_rpc",
  "ethereum_deposit_rpc",
  "chat_turn_memory",
  "deep_memory",
  "network_task_profile",
  "daily_airdrop_worker",
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

console.log("system status smoke ok");
