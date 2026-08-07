#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/task-creation-read-timing.mjs [options]

Options:
  --iterations <n>   Measured rounds (default: 5)
  --concurrency <n>  Simultaneous task-packet builds per round (default: 2)
  --warmup <n>       Unmeasured warmup rounds (default: 1)
  --commit <sha>     Commit label when Git metadata is unavailable
  --json             Print a machine-readable timing packet
  --help             Show this help
`);
  process.exit(0);
}

function flagValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function positiveInteger(name, fallback) {
  const value = Number(flagValue(name, fallback));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rounded(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isTimeout(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  return code === "57014" || code === "ETIMEDOUT" || message.includes("query read timeout") || message.includes("statement timeout");
}

function hiveProjectsShape(document = {}) {
  return {
    projectIds: document.projectIds || [],
    projects: Object.fromEntries(
      (document.projectIds || []).map((projectId) => {
        const project = document.projects?.[projectId] || {};
        return [
          projectId,
          {
            status: project.status,
            contributorIds: (project.contributors || []).map((item) => item.id || item.accountId || item.walletAddress),
            taskIds: (project.tasks || []).map((item) => item.taskId || item.id),
            pendingGenerationCount: project.pendingGenerationCount,
          },
        ];
      })
    ),
  };
}

function networkTaskContentShape(snapshot = {}) {
  const compact = (items) =>
    (items || []).map((item) => ({
      taskId: item.taskId || item.task_id,
      requestId: item.requestId || item.request_id,
      projectId: item.projectId || item.project_id,
      state: item.state || item.status,
    }));
  return {
    counts: snapshot.counts || {},
    completed: compact(snapshot.completed),
    outstanding: compact(snapshot.outstanding),
    stopped: compact(snapshot.stopped),
    pendingGeneration: compact(snapshot.pendingGeneration),
  };
}

function recentRunsShape(runs = []) {
  return runs.map((run) => ({
    id: run.id,
    status: run.status,
    selectedAction: run.selectedAction,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  }));
}

function currentCommit() {
  const override = flagValue("--commit");
  if (override) return override;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

const iterations = positiveInteger("--iterations", 5);
const concurrency = positiveInteger("--concurrency", 2);
const warmup = Number(flagValue("--warmup", "1"));
if (!Number.isInteger(warmup) || warmup < 0) throw new Error("--warmup must be a non-negative integer");

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const [{ getHiveProjectsDocument }, networkTasks, boardManager, database] = await Promise.all([
  import("../server/repositories/hive-projects.js"),
  import("../server/repositories/network-tasks.js"),
  import("../server/repositories/board-manager.js"),
  import("../server/db/pool.js"),
]);

const reads = [
  {
    name: "getHiveProjectsDocument",
    run: () => getHiveProjectsDocument({ includeEmptyActive: true }),
    shape: hiveProjectsShape,
  },
  {
    name: "getNetworkTaskContentSnapshot",
    run: () =>
      networkTasks.getNetworkTaskContentSnapshot({
        completedLimit: 4,
        outstandingLimit: 8,
        stoppedLimit: 4,
        pendingLimit: 4,
      }),
    shape: networkTaskContentShape,
  },
  {
    name: "recentBoardManagerRuns",
    run: () => boardManager.recentBoardManagerRuns({ limit: 20 }),
    shape: recentRunsShape,
  },
];

const samples = new Map(reads.map((read) => [read.name, []]));
const digests = new Map(reads.map((read) => [read.name, new Set()]));
const errors = new Map(reads.map((read) => [read.name, []]));

async function measuredRead(read, record) {
  const startedAt = performance.now();
  try {
    const result = await read.run();
    if (record) {
      samples.get(read.name).push(performance.now() - startedAt);
      digests.get(read.name).add(digest(read.shape(result)));
    }
  } catch (error) {
    if (record) {
      samples.get(read.name).push(performance.now() - startedAt);
      errors.get(read.name).push({
        code: String(error?.code || ""),
        message: String(error?.message || "").slice(0, 300),
        timeout: isTimeout(error),
      });
    }
  }
}

async function packetBuild(record) {
  await Promise.all(reads.map((read) => measuredRead(read, record)));
}

try {
  for (let round = 0; round < warmup; round += 1) {
    await Promise.all(Array.from({ length: concurrency }, () => packetBuild(false)));
  }
  for (let round = 0; round < iterations; round += 1) {
    await Promise.all(Array.from({ length: concurrency }, () => packetBuild(true)));
  }

  const results = reads.map((read) => {
    const values = samples.get(read.name);
    const readErrors = errors.get(read.name);
    return {
      read: read.name,
      samples: values.length,
      median_ms: rounded(percentile(values, 0.5)),
      p95_ms: rounded(percentile(values, 0.95)),
      max_ms: rounded(Math.max(0, ...values)),
      timeout_count: readErrors.filter((error) => error.timeout).length,
      error_count: readErrors.length,
      result_digest_count: digests.get(read.name).size,
      result_digests: [...digests.get(read.name)],
      errors: readErrors,
    };
  });
  const packet = {
    schema: "pf.task_node.task_creation_read_timing.v1",
    commit: currentCommit(),
    settings: {
      iterations,
      simultaneous_packet_builds: concurrency,
      warmup_rounds: warmup,
      expected_samples_per_read: iterations * concurrency,
      database_statement_timeout_ms: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 5000),
      database: database.databaseStatus(),
    },
    results,
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(packet, null, 2));
  } else {
    console.log(
      `commit=${packet.commit} iterations=${iterations} simultaneous_packet_builds=${concurrency} warmup_rounds=${warmup}`
    );
    console.table(
      results.map(({ read, samples: count, median_ms, p95_ms, max_ms, timeout_count, error_count, result_digest_count }) => ({
        read,
        samples: count,
        median_ms,
        p95_ms,
        max_ms,
        timeout_count,
        error_count,
        result_digest_count,
      }))
    );
  }
} finally {
  await database.closePool();
}
