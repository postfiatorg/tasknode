#!/usr/bin/env node
import { closePool } from "../server/db/pool.js";
import { runDailyAirdropScore } from "../server/profile-daily-airdrop.js";

if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const accountId = argValue("--account-id", process.env.TASKNODE_DAILY_AIRDROP_ACCOUNT_ID || "");
const runMode = argValue("--run-mode", "dry_run");
const scenarioId = argValue("--scenario-id", `cli_${Date.now()}`);
const lookbackDays = Number(argValue("--lookback-days", "7"));
const maxDailyPft = Number(argValue("--max-daily-pft", process.env.TASKNODE_DAILY_AIRDROP_MAX_PFT || "10000"));
const model = argValue("--model", process.env.TASKNODE_DAILY_AIRDROP_MODEL || "z-ai/glm-5.2");
const json = hasFlag("--json");

if (!accountId) {
  console.error("Usage: node scripts/profile-daily-airdrop-score.mjs --account-id <account_id> [--run-mode dry_run] [--json]");
  process.exit(1);
}

try {
  const result = await runDailyAirdropScore({
    accountId,
    runMode,
    scenarioId,
    lookbackDays,
    maxDailyPft,
    model,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("daily_airdrop_score_complete");
    console.log(`run_id=${result.run.id}`);
    console.log(`account_id=${result.run.account_id}`);
    console.log(`run_mode=${result.run.run_mode}`);
    console.log(`scenario_id=${result.run.scenario_id}`);
    console.log(`model=${result.model}`);
    console.log(`input_hash=${result.inputHash}`);
    console.log(`rewarded_task_count=${result.packet.reward_totals.rewarded_task_count}`);
    console.log(`reward_paid_7d=${result.packet.reward_totals.total_reward_paid_pft}`);
    console.log(`daily_airdrop_pft=${result.output.daily_airdrop_pft}`);
    console.log(`retention_value_score=${result.output.retention_value_score}`);
    console.log(`alignment_score_7d=${Number(result.run.alignment_score_7d || 0)}`);
    console.log(`what_raised_today=${result.output.what_raised_today}`);
    console.log(`what_kept_it_lower=${result.output.what_kept_it_lower}`);
    console.log(`to_improve_tomorrow=${result.output.to_improve_tomorrow}`);
    console.log(`reasoning_text=${result.output.reasoning_text}`);
  }
} finally {
  await closePool().catch(() => null);
}
