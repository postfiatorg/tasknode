#!/usr/bin/env node

function parseArgs(argv = []) {
  const options = {
    types: [],
    force: false,
    mock: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      options.force = true;
    } else if (arg === "--mock") {
      options.mock = true;
    } else if (arg === "--type") {
      const value = argv[index + 1] || "";
      index += 1;
      if (value && value !== "all") options.types.push(value);
    } else if (arg.startsWith("--type=")) {
      const value = arg.slice("--type=".length);
      if (value && value !== "all") options.types.push(value);
    } else if (arg === "--all") {
      options.types = [];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run hive-reports-worker -- [--type rewarded_task|operative|kol|development|qa|executive|all] [--force] [--mock]

Generates due Hive v2 markdown reports once. Use --mock for local/prod smoke
verification without OpenRouter spend.`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
if (options.mock) {
  process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK = "true";
}

const [{ migrateDatabase }, { closePool }, { hiveReportTypeIds, runHiveReportsWorkerOnce }] = await Promise.all([
  import("../server/db/migrate.js"),
  import("../server/db/pool.js"),
  import("../server/hive-reports-worker.js"),
]);

try {
  await migrateDatabase();
  const result = await runHiveReportsWorkerOnce({
    types: options.types.length ? options.types : hiveReportTypeIds,
    force: options.force,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await closePool().catch(() => null);
}
