import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    "Usage: npm run board-manager:loop -- [options]",
    "",
    "Options:",
    "  --scope <scope>             Manager scope. Default: global_hive",
    "  --trigger-prefix <name>     Trigger prefix for each tick. Default: board_manager_loop",
    "  --model <model>             OpenAI model. Default: gpt-5.5-pro",
    "  --reasoning <effort>        OpenAI reasoning effort. Default: high",
    "  --idle-delay-ms <ms>        Delay after do_nothing/no board change. Default: 120000",
    "  --action-delay-ms <ms>      Delay after a mutating action. Default: 5000",
    "  --error-delay-ms <ms>       Delay after an error. Default: 120000",
    "  --max-turns <n>             Stop after n turns. Default: unlimited",
    "  --dry-run                  Do not execute action hooks.",
    "  --no-lease                  Pass through to one-shot runs.",
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
  if (!trimmed) throw new Error("board_manager_loop_empty_output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("board_manager_loop_invalid_json_output");
  }
}

async function runOneTurn({ turn, firstTurn }) {
  const trigger = `${config.triggerPrefix}_${String(turn).padStart(4, "0")}_${Date.now()}`;
  const args = [
    path.join(repoRoot, "scripts", "board-manager-model-exec.mjs"),
    "--trigger",
    trigger,
    "--scope",
    config.scope,
    "--model",
    config.model,
    "--reasoning",
    config.reasoning,
    "--json",
  ];
  if (!config.dryRun) args.push("--execute");
  if (config.noLease) args.push("--no-lease");

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
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
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    const error = new Error(`board_manager_loop_turn_failed:${code}`);
    error.stderr = stderr;
    error.stdout = stdout;
    throw error;
  }
  const output = parseJsonOutput(stdout);
  return {
    trigger,
    output,
    action: output?.decision?.action || "unknown",
    runId: output?.runId || "",
    reason: output?.decision?.reason || "",
    executed: Boolean(output?.actionResult?.result?.executed),
  };
}

const config = {
  scope: argValue("--scope", "global_hive"),
  triggerPrefix: argValue("--trigger-prefix", process.env.TASKNODE_BOARD_MANAGER_LOOP_TRIGGER_PREFIX || "board_manager_loop"),
  model: argValue("--model", process.env.TASKNODE_BOARD_MANAGER_MODEL || "gpt-5.5-pro"),
  reasoning: argValue("--reasoning", process.env.TASKNODE_BOARD_MANAGER_REASONING_EFFORT || "high"),
  idleDelayMs: numberArg("--idle-delay-ms", Number(process.env.TASKNODE_BOARD_MANAGER_IDLE_DELAY_MS || 120000), { min: 1000 }),
  actionDelayMs: numberArg("--action-delay-ms", Number(process.env.TASKNODE_BOARD_MANAGER_ACTION_DELAY_MS || 5000), { min: 0 }),
  errorDelayMs: numberArg("--error-delay-ms", Number(process.env.TASKNODE_BOARD_MANAGER_ERROR_DELAY_MS || 120000), { min: 1000 }),
  maxTurns: numberArg("--max-turns", Number(process.env.TASKNODE_BOARD_MANAGER_MAX_TURNS || 0), { min: 0 }),
  dryRun: hasArg("--dry-run"),
  noLease: hasArg("--no-lease"),
};

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

let turn = 0;
console.log(JSON.stringify({
  event: "board_manager_loop_started",
  scope: config.scope,
  triggerPrefix: config.triggerPrefix,
  dryRun: config.dryRun,
  idleDelayMs: config.idleDelayMs,
  actionDelayMs: config.actionDelayMs,
  errorDelayMs: config.errorDelayMs,
  maxTurns: config.maxTurns || "unlimited",
}, null, 2));

while (!abort.signal.aborted && (!config.maxTurns || turn < config.maxTurns)) {
  turn += 1;
  try {
    const result = await runOneTurn({ turn, firstTurn: turn === 1 });
    const noAction = result.action === "do_nothing";
    const delayMs = noAction ? config.idleDelayMs : config.actionDelayMs;
    console.log(JSON.stringify({
      event: "board_manager_loop_turn_completed",
      turn,
      runId: result.runId,
      action: result.action,
      executed: result.executed,
      trigger: result.trigger,
      nextDelayMs: delayMs,
      reason: result.reason,
    }, null, 2));
    await sleep(delayMs, abort.signal);
  } catch (error) {
    console.error(JSON.stringify({
      event: "board_manager_loop_turn_failed",
      turn,
      error: error?.message || String(error),
      stderr: String(error?.stderr || "").slice(0, 2000),
    }, null, 2));
    await sleep(config.errorDelayMs, abort.signal);
  }
}

console.log(JSON.stringify({
  event: "board_manager_loop_stopped",
  turns: turn,
  reason: abort.signal.aborted ? "signal" : "max_turns",
}, null, 2));
