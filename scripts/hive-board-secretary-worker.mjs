#!/usr/bin/env node

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

if (!process.env.DATABASE_STATEMENT_TIMEOUT_MS) {
  process.env.DATABASE_STATEMENT_TIMEOUT_MS =
    process.env.TASKNODE_HIVE_BOARD_SECRETARY_DB_STATEMENT_TIMEOUT_MS || "60000";
}

const [{ migrateDatabase }, { closePool }, worker] = await Promise.all([
  import("../server/db/migrate.js"),
  import("../server/db/pool.js"),
  import("../server/hive-board-secretary-worker.js"),
]);

function hasArg(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    "Usage: npm run hive-board-secretary-worker -- [--once] [--dry-run] [--json]",
    "",
    "Runs the GLM 5.2 Hive board secretary memo worker.",
    "The worker writes advisory Project Status memos only; it does not execute Board Manager actions.",
  ].join("\n");
}

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

await migrateDatabase();

if (hasArg("--once") || hasArg("--dry-run")) {
  const result = await worker.runHiveBoardSecretaryOnce({
    dryRun: hasArg("--dry-run"),
    logger: hasArg("--json") ? { log() {}, warn() {} } : console,
  });
  console.log(JSON.stringify(result, null, 2));
  await closePool().catch(() => null);
  process.exit(result.ok ? 0 : 1);
}

let keepAlive = null;

async function shutdown(signal) {
  if (keepAlive) clearInterval(keepAlive);
  await worker.stopHiveBoardSecretaryWorker().catch(() => null);
  await closePool().catch(() => null);
  console.log(`[hive-board-secretary-worker] stopped signal=${signal}`);
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});

const started = worker.startHiveBoardSecretaryWorker();
if (!started) {
  console.error("[hive-board-secretary-worker] not started; check TASKNODE_HIVE_BOARD_SECRETARY_ENABLED, database, and OpenRouter credentials");
  await closePool().catch(() => null);
  process.exit(1);
}

console.log("[hive-board-secretary-worker] started");
keepAlive = setInterval(() => {}, 60 * 60 * 1000);
