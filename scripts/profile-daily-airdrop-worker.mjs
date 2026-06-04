#!/usr/bin/env node
import { closePool } from "../server/db/pool.js";
import { runDailyAirdropWorkerOnce } from "../server/profile-daily-airdrop-worker.js";

if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const json = hasFlag("--json");

try {
  const result = await runDailyAirdropWorkerOnce({
    runDate: argValue("--run-date", undefined),
    lookbackDays: Number(argValue("--lookback-days", process.env.TASKNODE_DAILY_AIRDROP_LOOKBACK_DAYS || "7")),
    batchLimit: Number(argValue("--batch-limit", process.env.TASKNODE_DAILY_AIRDROP_WORKER_BATCH_LIMIT || "10")),
    maxDailyPft: Number(argValue("--max-daily-pft", process.env.TASKNODE_DAILY_AIRDROP_MAX_PFT || "10000")),
    model: argValue("--model", process.env.TASKNODE_DAILY_AIRDROP_MODEL || "deepseek/deepseek-v4-pro"),
    runMode: argValue("--run-mode", process.env.TASKNODE_DAILY_AIRDROP_WORKER_RUN_MODE || "production"),
    trigger: argValue("--trigger", "manual_daily_airdrop_worker"),
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.summary || result.reason || "daily_airdrop_worker_complete");
    console.log(`candidate_count=${result.candidateCount || 0}`);
    console.log(`scored_count=${result.scoredCount || 0}`);
    console.log(`issued_count=${result.issuedCount || 0}`);
    console.log(`failed_count=${result.failedCount || 0}`);
    console.log(`total_pft=${result.totalPft || 0}`);
    if (result.agentRun?.runId) console.log(`agent_run_id=${result.agentRun.runId}`);
  }
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  await closePool().catch(() => null);
  process.exit(1);
}

await closePool().catch(() => null);
