#!/usr/bin/env node

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const [{ migrateDatabase }, { closePool }, { startHiveDecisionAgentWorker }] = await Promise.all([
  import("../server/db/migrate.js"),
  import("../server/db/pool.js"),
  import("../server/hive-decision-agent-worker.js"),
]);

let keepAlive = null;

async function shutdown(signal) {
  if (keepAlive) clearInterval(keepAlive);
  await closePool().catch(() => null);
  console.log(`[hive-decision-agent-loop] stopped signal=${signal}`);
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});

await migrateDatabase();
const started = startHiveDecisionAgentWorker();
if (!started) {
  console.error("[hive-decision-agent-loop] not started; check TASKNODE_HIVE_DECISION_AGENT_ENABLED, database, and provider credentials");
  await closePool().catch(() => null);
  process.exit(1);
}

console.log("[hive-decision-agent-loop] started");
keepAlive = setInterval(() => {}, 60 * 60 * 1000);
