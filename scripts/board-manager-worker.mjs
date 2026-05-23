import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, databaseEnabled } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  claimBoardManagerJob,
  completeBoardManagerJob,
  deferOrFailBoardManagerJob,
  enqueueBoardManagerJob,
  enqueueDueBoardManagerTicks,
  ensureBoardManagerScope,
} from "../server/repositories/board-manager-scheduler.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function numberArg(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = argValue(name, "");
  const parsed = raw === "" ? Number(fallback) : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function usage() {
  return [
    "Usage: npm run board-manager:worker -- [options]",
    "",
    "Options:",
    "  --scope <scope>             Manager scope. Default: global_hive",
    "  --execute                   Execute supported action hooks. Default is dry-run.",
    "  --poll-ms <ms>              Delay between polls. Default: 15000",
    "  --max-turns <n>             Stop after n worker turns. Default: unlimited",
    "  --model <model>             Codex model. Default: gpt-5.5",
    "  --reasoning <effort>        Codex reasoning effort. Default: xhigh",
    "  --job-limit <n>             Due scope ticks to enqueue per pass. Default: 5",
    "  --action-delay-ms <ms>      Follow-up delay after mutating action. Default: 5000",
    "  --error-delay-ms <ms>       Retry delay after failed job. Default: 300000",
    "  --force                     Run even when TASKNODE_BOARD_MANAGER_ENABLED is not true.",
  ].join("\n");
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function parseJsonOutput(stdout = "") {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) throw new Error("board_manager_worker_empty_exec_output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("board_manager_worker_invalid_exec_json");
  }
}

async function runCodexOneShot({ job }) {
  const args = [
    path.join(repoRoot, "scripts", "board-manager-codex-exec.mjs"),
    "--trigger",
    job.trigger || "board_manager_job",
    "--scope",
    job.scope || config.scope,
    "--model",
    config.model,
    "--reasoning",
    config.reasoning,
    "--json",
  ];
  if (config.execute) args.push("--execute");

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      TASKNODE_PROCESS_ROLE: "board-manager",
      TASKNODE_BOARD_MANAGER_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    const error = new Error(`board_manager_codex_job_failed:${code}`);
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return parseJsonOutput(stdout);
}

async function enqueueFollowupIfNeeded({ job, output }) {
  const action = output?.decision?.action || "";
  if (!action || action === "do_nothing") return null;
  return enqueueBoardManagerJob({
    scope: job.scope,
    trigger: "post_action_followup",
    reason: `Observe Board Manager action ${action} from run ${output.runId || "unknown"}.`,
    idempotencyKey: `post_action_followup:${job.scope}:${output.runId || job.id}`,
    runAfter: new Date(Date.now() + config.actionDelayMs),
    maxAttempts: 3,
    metadata: {
      source_job_id: job.id,
      source_run_id: output.runId || "",
      source_action: action,
    },
  });
}

async function processOneJob({ turn }) {
  await enqueueDueBoardManagerTicks({ scope: config.scope, limit: config.jobLimit });
  const claimed = await claimBoardManagerJob({ scope: config.scope, managerId: config.managerId });
  if (!claimed.claimed || !claimed.job) {
    return { claimed: false, reason: claimed.reason || "" };
  }

  const job = claimed.job;
  try {
    const output = await runCodexOneShot({ job });
    const followup = await enqueueFollowupIfNeeded({ job, output });
    await completeBoardManagerJob({
      jobId: job.id,
      runId: output.runId || "",
      result: {
        ok: true,
        turn,
        dry_run: !config.execute,
        action: output?.decision?.action || "",
        source_packet_digest: output?.sourcePacketDigest || "",
        followup_job_id: followup?.job?.id || "",
      },
    });
    return {
      claimed: true,
      ok: true,
      jobId: job.id,
      runId: output.runId || "",
      action: output?.decision?.action || "",
      followupQueued: Boolean(followup?.queued),
    };
  } catch (error) {
    const message = [
      error?.message || String(error),
      String(error?.stderr || "").slice(0, 1500),
    ].filter(Boolean).join("\n");
    const deferred = await deferOrFailBoardManagerJob({
      jobId: job.id,
      error: message,
      retryDelaySeconds: Math.ceil(config.errorDelayMs / 1000),
    }).catch(() => null);
    return {
      claimed: true,
      ok: false,
      jobId: job.id,
      status: deferred?.job?.status || "unknown",
      error: message.slice(0, 2000),
    };
  }
}

const config = {
  scope: argValue("--scope", process.env.TASKNODE_BOARD_MANAGER_SCOPE || "global_hive"),
  managerId: argValue("--manager-id", `board_worker_${randomUUID()}`),
  model: argValue("--model", process.env.TASKNODE_BOARD_MANAGER_CODEX_MODEL || "gpt-5.5"),
  reasoning: argValue("--reasoning", process.env.TASKNODE_BOARD_MANAGER_CODEX_REASONING || "xhigh"),
  pollMs: numberArg("--poll-ms", Number(process.env.TASKNODE_BOARD_MANAGER_WORKER_POLL_MS || 15000), { min: 1000 }),
  actionDelayMs: numberArg("--action-delay-ms", Number(process.env.TASKNODE_BOARD_MANAGER_ACTION_DELAY_MS || 5000), { min: 0 }),
  errorDelayMs: numberArg("--error-delay-ms", Number(process.env.TASKNODE_BOARD_MANAGER_ERROR_DELAY_MS || 300000), { min: 5000 }),
  jobLimit: numberArg("--job-limit", Number(process.env.TASKNODE_BOARD_MANAGER_TICK_JOB_LIMIT || 5), { min: 1, max: 25 }),
  maxTurns: numberArg("--max-turns", Number(process.env.TASKNODE_BOARD_MANAGER_WORKER_MAX_TURNS || 0), { min: 0 }),
  execute: hasArg("--execute"),
  force: hasArg("--force"),
};

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

const enabled = config.force || process.env.TASKNODE_BOARD_MANAGER_ENABLED === "true";
if (!enabled) {
  console.log(JSON.stringify({
    event: "board_manager_worker_disabled",
    reason: "TASKNODE_BOARD_MANAGER_ENABLED is not true",
  }, null, 2));
  process.exit(0);
}

if (!databaseEnabled()) {
  console.error("board_manager_worker_requires_postgres");
  process.exit(1);
}

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

try {
  await migrateDatabase();
  await ensureBoardManagerScope({ scope: config.scope });

  console.log(JSON.stringify({
    event: "board_manager_worker_started",
    scope: config.scope,
    managerId: config.managerId,
    dryRun: !config.execute,
    pollMs: config.pollMs,
    maxTurns: config.maxTurns || "unlimited",
  }, null, 2));

  let turn = 0;
  while (!abort.signal.aborted && (!config.maxTurns || turn < config.maxTurns)) {
    turn += 1;
    const result = await processOneJob({ turn });
    console.log(JSON.stringify({
      event: result.claimed ? "board_manager_worker_job_processed" : "board_manager_worker_idle",
      turn,
      ...result,
    }, null, 2));
    if (!result.claimed || result.ok === false) await sleep(config.pollMs, abort.signal);
  }

  console.log(JSON.stringify({
    event: "board_manager_worker_stopped",
    turns: turn,
    reason: abort.signal.aborted ? "signal" : "max_turns",
  }, null, 2));
} finally {
  await closePool();
}
