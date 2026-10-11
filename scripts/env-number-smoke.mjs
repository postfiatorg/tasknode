#!/usr/bin/env node

// Guards the NaN-safe numeric env helpers and keeps the unsafe
// `Math.max(..., Number(process.env.X || default))` idiom out of server/.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { envNumber, envNumberAtLeast, envNumberBetween } from "../server/env-number.js";

const NAME = "ENV_NUMBER_SMOKE_VALUE";

function withEnv(value, fn) {
  const previous = process.env[NAME];
  if (value === undefined) delete process.env[NAME];
  else process.env[NAME] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[NAME];
    else process.env[NAME] = previous;
  }
}

// Unset, empty and blank keep the fallback.
for (const value of [undefined, "", "   "]) {
  assert.equal(withEnv(value, () => envNumber(NAME, 15000)), 15000, `value ${JSON.stringify(value)}`);
}

// Non-numeric and non-finite spellings keep the fallback instead of NaN/Infinity.
for (const value of ["15s", "3m", "abc", "NaN", "Infinity", "-Infinity", "1e999", "12,000"]) {
  const parsed = withEnv(value, () => envNumber(NAME, 15000));
  assert.equal(parsed, 15000, `value ${JSON.stringify(value)} -> ${parsed}`);
  assert.equal(withEnv(value, () => envNumberAtLeast(NAME, 15000, 5000)), 15000);
  assert.equal(withEnv(value, () => envNumberBetween(NAME, 3, 1, 25)), 3);
}

// Numeric spellings Number() understands still load, including exponent and padding.
assert.equal(withEnv("7000", () => envNumber(NAME, 15000)), 7000);
assert.equal(withEnv("5e3", () => envNumber(NAME, 15000)), 5000);
assert.equal(withEnv(" 7000 ", () => envNumber(NAME, 15000)), 7000);
assert.equal(withEnv("0.5", () => envNumber(NAME, 15000)), 0.5);

// Minimum and maximum clamp exactly as the inline Math.max/Math.min did.
assert.equal(withEnv("0", () => envNumberAtLeast(NAME, 15000, 5000)), 5000);
assert.equal(withEnv("-1", () => envNumberAtLeast(NAME, 15000, 5000)), 5000);
assert.equal(withEnv("9000", () => envNumberAtLeast(NAME, 15000, 5000)), 9000);
assert.equal(withEnv("0", () => envNumberBetween(NAME, 3, 1, 25)), 1);
assert.equal(withEnv("40", () => envNumberBetween(NAME, 3, 1, 25)), 25);
assert.equal(withEnv("12", () => envNumberBetween(NAME, 3, 1, 25)), 12);
// A fallback below the minimum is clamped too, as before.
assert.equal(withEnv(undefined, () => envNumberAtLeast(NAME, 100, 5000)), 5000);

// The inline idiom produced NaN; the helper never does.
const inline = withEnv("15s", () => Math.max(5000, Number(process.env[NAME] || 15000)));
assert.ok(Number.isNaN(inline), "the inline idiom is expected to yield NaN for a mistyped value");
assert.equal(withEnv("15s", () => envNumberAtLeast(NAME, 15000, 5000)), 15000);

// No server module may read a numeric env through the NaN-propagating idiom.
const UNSAFE = /Math\.(?:max|min)\([^\n]*Number\(process\.env\.[A-Z0-9_]+ \|\|/;
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".js")) out.push(path);
  }
  return out;
}
const offenders = [];
for (const file of walk("server")) {
  if (file.endsWith("env-number.js")) continue; // the helper documents the idiom it replaces
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (UNSAFE.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}
assert.deepEqual(offenders, [], `NaN-propagating numeric env reads:\n${offenders.join("\n")}`);

// Worker/job parameters whose bare `Number(process.env.X || default)` read had
// no NaN guard before use in its own module. They must go through envNumber;
// the guarded bare reads elsewhere (`intervalMs || 15000`, clampInteger) are
// outside this list on purpose, and non-worker settings are listed below.
const WORKER_PARAMETER_VARS = [
  "TASKNODE_MEMORY_BATCH_SIZE",
  "TASKNODE_HIVE_SECRETARY_BATCH_SIZE",
  "TASKNODE_TEAM_CONTEXT_MAX_TOKENS",
  "TASKNODE_TEAM_CONTEXT_PROVIDER_TIMEOUT_MS",
  "TASKNODE_TEAM_CONTEXT_BATCH_SIZE",
  "TASKNODE_NETWORK_TASK_GENERATION_STALE_MINUTES",
  "PFTL_CACHE_HOT_STALE_MS",
  "TASKNODE_SHUTDOWN_TIMEOUT_MS",
  "TASKNODE_WORK_HANG_MS",
  "TASKNODE_DAILY_AIRDROP_LOOKBACK_DAYS",
  "TASKNODE_DAILY_AIRDROP_SCORE_STALE_MINUTES",
  "TASKNODE_DAILY_AIRDROP_PRE_SUBMIT_STALE_MINUTES",
  "TASKNODE_DAILY_AIRDROP_SUBMITTING_STALE_MINUTES",
  "TASKNODE_DAILY_AIRDROP_MAX_PFT",
  "TASKNODE_PROFILE_NFT_DAILY_PERSONAL_TASK_THRESHOLD",
  "TASKNODE_PROFILE_NFT_DAILY_NETWORK_TASK_THRESHOLD",
  "TASK_PROJECTION_REFRESH_MIN_INTERVAL_MS",
];
// Settings (attempt limit, rank weights, token floor, quoted scorer runs) whose
// bare read had no NaN guard before use: a NaN attempt limit never marks a
// memory job final, a NaN rank weight makes every leaderboard score NaN, a NaN
// token floor is sent as max_tokens: null and a NaN run count is quoted as null.
const ROUTED_SETTING_VARS = [
  "TASKNODE_MEMORY_MAX_ATTEMPTS",
  "DIRECTORY_LEADERBOARD_NETWORK_TASK_WEIGHT",
  "DIRECTORY_LEADERBOARD_PERSONAL_TASK_WEIGHT",
  "DIRECTORY_LEADERBOARD_REWARD_DIVISOR",
  "DIRECTORY_LEADERBOARD_ALIGNMENT_WEIGHT",
  "TASKNODE_BOARD_MANAGER_PLANNING_REPORT_MAX_TOKENS",
  "CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL",
];
// Bare reads of a listed name that are finite-guarded on the next line stay as
// they are; they are pinned by file so a new unguarded read still fails.
const GUARDED_BARE_READS = new Set([
  "server/context-rewrite-worker.js:CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL", // Number.isFinite(parsed) ? ... : 3
]);
const BARE = new RegExp(
  `Number\\(\\s*process\\.env\\.(${[...WORKER_PARAMETER_VARS, ...ROUTED_SETTING_VARS].join("|")})\\b`
);
const problems = [];
const bareOffenders = [];
for (const file of walk("server")) {
  readFileSync(file, "utf8").split("\n").forEach((line, index) => {
    const match = BARE.exec(line);
    if (match && !GUARDED_BARE_READS.has(`${file}:${match[1]}`)) {
      bareOffenders.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  });
}
if (bareOffenders.length) problems.push(`bare Number(process.env.X || default) worker reads:\n${bareOffenders.join("\n")}`);

// A mistyped shutdown timeout must not skip the drain: setTimeout(fn, NaN)
// fires at once, so the old NaN timeout exited before in-flight work drained.
const shutdownProbe = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    [
      'import { EventEmitter } from "node:events";',
      'const { installGracefulShutdown } = await import("./server/process-hardening.js");',
      "const processImpl = new EventEmitter();",
      "let drained = false;",
      "const exited = new Promise((resolve) => installGracefulShutdown({",
      "  drain: () => new Promise((done) => setTimeout(() => { drained = true; done(); }, 200)),",
      "  processImpl,",
      "  exit: resolve,",
      "}));",
      'processImpl.emit("SIGTERM");',
      "const code = await exited;",
      "console.log(JSON.stringify({ code, drained }));",
      "process.exit(0);",
    ].join("\n"),
  ],
  { env: { ...process.env, TASKNODE_SHUTDOWN_TIMEOUT_MS: "40s" }, encoding: "utf8", timeout: 30000 }
);
const shutdownLine = String(shutdownProbe.stdout || "").trim().split("\n").pop();
if (shutdownProbe.status !== 0 || shutdownLine !== JSON.stringify({ code: 0, drained: true })) {
  problems.push(`TASKNODE_SHUTDOWN_TIMEOUT_MS=40s skipped the drain: ${shutdownLine} ${shutdownProbe.stderr}`);
}

// A mistyped rank weight must not turn every leaderboard score into NaN (which
// the directory then published as null); numeric values must still apply.
function leaderboardProbe(env) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'const { directoryLeaderboardScore, DIRECTORY_LEADERBOARD_RANK_FORMULA: f } = await import("./server/repositories/directory-leaderboard.js");',
        "const score = directoryLeaderboardScore({ networkTasks: 2, personalTasks: 1, rewards: 50000, alignment: 0.5 });",
        "console.log(JSON.stringify({ score, formula: [f.networkTaskWeight, f.personalTaskWeight, f.rewardDivisor, f.alignmentWeight] }));",
        "process.exit(0);",
      ].join("\n"),
    ],
    { env: { ...process.env, ...env }, encoding: "utf8", timeout: 30000 }
  );
  return `${String(result.stdout || "").trim().split("\n").pop()}${result.status === 0 ? "" : ` ${result.stderr}`}`;
}
const leaderboardJunk = leaderboardProbe({
  DIRECTORY_LEADERBOARD_NETWORK_TASK_WEIGHT: "three",
  DIRECTORY_LEADERBOARD_PERSONAL_TASK_WEIGHT: "one",
  DIRECTORY_LEADERBOARD_REWARD_DIVISOR: "25k",
  DIRECTORY_LEADERBOARD_ALIGNMENT_WEIGHT: "1x",
});
if (leaderboardJunk !== JSON.stringify({ score: 9.5, formula: [3, 1, 25000, 1] })) {
  problems.push(`junk DIRECTORY_LEADERBOARD_* weights did not fall back to the defaults: ${leaderboardJunk}`);
}
const leaderboardNumeric = leaderboardProbe({
  DIRECTORY_LEADERBOARD_NETWORK_TASK_WEIGHT: "5",
  DIRECTORY_LEADERBOARD_PERSONAL_TASK_WEIGHT: "2",
  DIRECTORY_LEADERBOARD_REWARD_DIVISOR: "1e4",
  DIRECTORY_LEADERBOARD_ALIGNMENT_WEIGHT: "0",
});
if (leaderboardNumeric !== JSON.stringify({ score: 17, formula: [5, 2, 10000, 0] })) {
  problems.push(`numeric DIRECTORY_LEADERBOARD_* weights were not applied: ${leaderboardNumeric}`);
}
assert.deepEqual(problems, [], problems.join("\n"));

// Every module that routes a setting through the helper must still load with
// junk values set: the module-level constants are computed at import time.
const JUNK = {
  TASKNODE_MEMORY_INTERVAL_MS: "15s",
  TASKNODE_BM_NARRATOR_INTERVAL_MS: "3m",
  DATABASE_STATEMENT_TIMEOUT_MS: "5000ms",
  TASKNODE_REALTIME_MAX_STREAMS_PER_ACCOUNT: "four",
  TASKNODE_AGENT_HIVE_CHAT_RATE_LIMIT_MAX: "six",
  TASKNODE_HIVE_SECRETARY_PROVIDER_TIMEOUT_MS: "4m",
  TASKNODE_MEMORY_BATCH_SIZE: "three",
  TASKNODE_TEAM_CONTEXT_PROVIDER_TIMEOUT_MS: "4m",
  PFTL_CACHE_WORKER_INTERVAL_MS: "1m",
  PFTL_CACHE_HOT_STALE_MS: "2m",
  TASKNODE_SHUTDOWN_TIMEOUT_MS: "40s",
  TASKNODE_WORK_HANG_MS: "20m",
  TASKNODE_DAILY_AIRDROP_MAX_PFT: "ten",
  TASKNODE_PROFILE_NFT_DAILY_PERSONAL_TASK_THRESHOLD: "three",
  TASKNODE_TASK_REVIEW_WORKER_INTERVAL_MS: "20s",
  TASK_PROJECTION_REFRESH_MIN_INTERVAL_MS: "5s",
  TASKNODE_MEMORY_MAX_ATTEMPTS: "five",
  DIRECTORY_LEADERBOARD_NETWORK_TASK_WEIGHT: "three",
  TASKNODE_BOARD_MANAGER_PLANNING_REPORT_MAX_TOKENS: "14k",
  CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL: "three",
};
const routed = walk("server").filter((file) =>
  /from "(?:\.\.\/)*(?:\.\/)?env-number\.js"/.test(readFileSync(file, "utf8"))
);
assert.ok(routed.length >= 28, `expected the routed modules to import env-number.js, found ${routed.length}`);
for (const file of routed) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify("./" + file)}); process.exit(0);`],
    { env: { ...process.env, ...JUNK }, encoding: "utf8", timeout: 30000 }
  );
  assert.equal(result.status, 0, `${file} failed to load with junk numeric env values:\n${result.stderr}`);
}

console.log(`env-number smoke passed (${routed.length} routed modules load with junk values)`);
