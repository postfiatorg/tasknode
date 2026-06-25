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
  recoverStaleBoardManagerJobs,
  shouldSkipBoardManagerJobForRecentRun,
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
    "  --provider <provider>       Decision provider: openrouter or openai. Default: openrouter",
    "  --model <model>             Provider model. Default: z-ai/glm-5.2 for OpenRouter, gpt-5.5-pro for OpenAI",
    "  --reasoning <effort>        Provider reasoning effort. Default: high",
    "  --cadence-seconds <n>       Periodic scope cadence. Default: 300",
    "  --job-limit <n>             Due scope ticks to enqueue per pass. Default: 5",
    "  --max-actions-per-hour <n>  Scope action budget. Default: 60",
    "  --stale-job-seconds <n>     Recover running jobs older than this. Default: 900",
    "  --action-delay-ms <ms>      Follow-up delay after mutating action. Default: 5000",
    "  --error-delay-ms <ms>       Retry delay after failed job. Default: 300000",
    "  --force                     Run even when TASKNODE_BOARD_MANAGER_ENABLED is not true.",
    "  --force-legacy              Allow the retired Board Manager LLM loop while Hive Decision Agent is active.",
    "  --print-config              Print resolved config and exit before DB checks.",
  ].join("\n");
}

function normalizeProvider(value = "openrouter") {
  return String(value || "").toLowerCase() === "openai" ? "openai" : "openrouter";
}

function defaultBoardManagerModel(provider = "openrouter") {
  return provider === "openai" ? "gpt-5.5-pro" : "z-ai/glm-5.2";
}

function oldBoardManagerExecutionEnabled() {
  return process.env.TASKNODE_BOARD_MANAGER_EXECUTION_ENABLED !== "false" &&
    process.env.TASKNODE_HIVE_DECISION_AGENT_ACTIVE !== "true";
}

function legacyBoardManagerDecommissioned() {
  return process.env.TASKNODE_HIVE_DECISION_AGENT_ACTIVE === "true" &&
    process.env.TASKNODE_LEGACY_BOARD_MANAGER_ENABLED !== "true" &&
    !hasArg("--force-legacy");
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

async function runBoardManagerDecision({ job }) {
  const args = [
    path.join(repoRoot, "scripts", "board-manager-model-exec.mjs"),
    "--trigger",
    job.trigger || "board_manager_job",
    "--scope",
    job.scope || config.scope,
    "--provider",
    config.provider,
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
    const error = new Error(`board_manager_model_job_failed:${code}`);
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
  const recovered = await recoverStaleBoardManagerJobs({
    scope: config.scope,
    staleSeconds: config.staleJobSeconds,
    limit: config.jobLimit,
  });
  await enqueueDueBoardManagerTicks({ scope: config.scope, limit: config.jobLimit });
  const claimed = await claimBoardManagerJob({ scope: config.scope, managerId: config.managerId });
  if (!claimed.claimed || !claimed.job) {
    return { claimed: false, reason: claimed.reason || "", recovered: recovered.recovered || 0 };
  }

  const job = claimed.job;
  try {
    const recentRunSkip = await shouldSkipBoardManagerJobForRecentRun({ job });
    if (recentRunSkip.skip) {
      await completeBoardManagerJob({
        jobId: job.id,
        runId: "",
        result: {
          ok: true,
          skipped: true,
          reason: recentRunSkip.reason,
          recent_run_id: recentRunSkip.run?.id || "",
          since: recentRunSkip.since || "",
        },
      });
      return {
        claimed: true,
        ok: true,
        skipped: true,
        jobId: job.id,
        action: "skipped_recent_run",
        reason: recentRunSkip.reason,
        recovered: recovered.recovered || 0,
      };
    }

    const output = await runBoardManagerDecision({ job });
    const followup = config.execute ? await enqueueFollowupIfNeeded({ job, output }) : null;
    await completeBoardManagerJob({
      jobId: job.id,
      runId: output.runId || "",
      result: {
        ok: true,
        turn,
        dry_run: !config.execute,
        action: output?.decision?.action || "",
        source_packet_digest: output?.sourcePacketDigest || "",
        source_packet_bytes: output?.sourcePacketBytes || 0,
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
      recovered: recovered.recovered || 0,
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
      recovered: recovered.recovered || 0,
    };
  }
}

const config = {
  scope: argValue("--scope", process.env.TASKNODE_BOARD_MANAGER_SCOPE || "global_hive"),
  managerId: argValue("--manager-id", `board_worker_${randomUUID()}`),
  provider: normalizeProvider(argValue("--provider", process.env.TASKNODE_BOARD_MANAGER_PROVIDER || "openrouter")),
  model: "",
  reasoning: argValue("--reasoning", process.env.TASKNODE_BOARD_MANAGER_REASONING_EFFORT || "high"),
  pollMs: numberArg("--poll-ms", Number(process.env.TASKNODE_BOARD_MANAGER_WORKER_POLL_MS || 15000), { min: 1000 }),
  cadenceSeconds: numberArg(
    "--cadence-seconds",
    Number(process.env.TASKNODE_BOARD_MANAGER_CADENCE_SECONDS || 300),
    { min: 60, max: 86400 }
  ),
  actionDelayMs: numberArg("--action-delay-ms", Number(process.env.TASKNODE_BOARD_MANAGER_ACTION_DELAY_MS || 5000), { min: 0 }),
  errorDelayMs: numberArg("--error-delay-ms", Number(process.env.TASKNODE_BOARD_MANAGER_ERROR_DELAY_MS || 300000), { min: 5000 }),
  jobLimit: numberArg("--job-limit", Number(process.env.TASKNODE_BOARD_MANAGER_TICK_JOB_LIMIT || 5), { min: 1, max: 25 }),
  maxActionsPerHour: numberArg(
    "--max-actions-per-hour",
    Number(process.env.TASKNODE_BOARD_MANAGER_MAX_ACTIONS_PER_HOUR || 60),
    { min: 0, max: 200 }
  ),
  staleJobSeconds: numberArg(
    "--stale-job-seconds",
    Number(process.env.TASKNODE_BOARD_MANAGER_STALE_JOB_SECONDS || 900),
    { min: 60, max: 86400 }
  ),
  maxTurns: numberArg("--max-turns", Number(process.env.TASKNODE_BOARD_MANAGER_WORKER_MAX_TURNS || 0), { min: 0 }),
  execute: hasArg("--execute") && oldBoardManagerExecutionEnabled(),
  force: hasArg("--force"),
};
config.model = argValue("--model", process.env.TASKNODE_BOARD_MANAGER_MODEL || defaultBoardManagerModel(config.provider));

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

if (hasArg("--print-config")) {
  console.log(JSON.stringify({
    event: "board_manager_worker_config",
    scope: config.scope,
    provider: config.provider,
    model: config.model,
    reasoning: config.reasoning,
    pollMs: config.pollMs,
    cadenceSeconds: config.cadenceSeconds,
    maxActionsPerHour: config.maxActionsPerHour,
    staleJobSeconds: config.staleJobSeconds,
    execute: config.execute,
    executionRequested: hasArg("--execute"),
    decommissioned: legacyBoardManagerDecommissioned(),
    executionDisabledReason: hasArg("--execute") && !config.execute
      ? process.env.TASKNODE_HIVE_DECISION_AGENT_ACTIVE === "true"
        ? "hive_decision_agent_active"
        : "TASKNODE_BOARD_MANAGER_EXECUTION_ENABLED=false"
      : "",
  }, null, 2));
  process.exit(0);
}

if (legacyBoardManagerDecommissioned()) {
  console.log(JSON.stringify({
    event: "board_manager_worker_decommissioned",
    reason: "hive_decision_agent_active",
    replacement: "npm run start:board-manager",
  }, null, 2));
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
  await ensureBoardManagerScope({
    scope: config.scope,
    cadenceSeconds: config.cadenceSeconds,
    maxActionsPerHour: config.maxActionsPerHour,
  });

  console.log(JSON.stringify({
    event: "board_manager_worker_started",
    scope: config.scope,
    managerId: config.managerId,
    provider: config.provider,
    model: config.model,
    dryRun: !config.execute,
    pollMs: config.pollMs,
    cadenceSeconds: config.cadenceSeconds,
    maxActionsPerHour: config.maxActionsPerHour,
    staleJobSeconds: config.staleJobSeconds,
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
