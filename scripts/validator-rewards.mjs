#!/usr/bin/env node
import { runValidatorRewards } from "../server/validator-rewards.js";
import { closePool } from "../server/db/pool.js";
const args = process.argv.slice(2);
const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (args.includes("--help")) {
  console.log("Usage: node scripts/validator-rewards.mjs [--month YYYY-MM] [--account ACCOUNT_ID] [--run]\nDefault: dry run. YYYY-MM is payout month; reports cover 30 complete days before its first UTC day.\n--run also requires TASKNODE_VALIDATOR_REWARDS_ENABLED=true. Production grants require operator approval.");
} else {
  try { console.log(JSON.stringify(await runValidatorRewards({ month: value("--month"), accountId: value("--account"), dryRun: !args.includes("--run") }), null, 2)); }
  finally { await closePool(); }
}
