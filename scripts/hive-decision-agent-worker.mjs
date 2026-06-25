#!/usr/bin/env node

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function usage() {
  return `Usage: npm run hive-decision-agent-worker -- [--mock] [--trigger name]

Runs the Hive v2 Decision Agent once in shadow mode. It records an auditable
hive_decision_runs row and never executes board mutations.`;
}

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

if (hasArg("--mock")) {
  process.env.TASKNODE_HIVE_DECISION_AGENT_PROVIDER_MOCK = "true";
}

const [{ migrateDatabase }, { closePool }, { runHiveDecisionAgentOnce }] = await Promise.all([
  import("../server/db/migrate.js"),
  import("../server/db/pool.js"),
  import("../server/hive-decision-agent-worker.js"),
]);

try {
  await migrateDatabase();
  const result = await runHiveDecisionAgentOnce({
    trigger: argValue("--trigger", "manual_shadow_cli"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await closePool().catch(() => null);
}
