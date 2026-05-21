import { issueLatestDailyAirdrop } from "../server/profile-daily-airdrop-issuance.js";
import { closePool } from "../server/db/pool.js";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const entry = process.argv.find((item) => item.startsWith(prefix));
  return entry ? entry.slice(prefix.length).trim() : fallback;
}

const accountId = argValue("account-id", process.env.TASKNODE_DAILY_AIRDROP_ACCOUNT_ID || "");
const runId = argValue("run-id", process.env.TASKNODE_DAILY_AIRDROP_RUN_ID || "");

if (!accountId) {
  console.error("Usage: node scripts/profile-daily-airdrop-issue.mjs --account-id=<account_id> [--run-id=<run_id>]");
  process.exit(1);
}

try {
  const result = await issueLatestDailyAirdrop({ accountId, runId });
  console.log(JSON.stringify({
    ok: result.ok,
    alreadySubmitted: result.alreadySubmitted,
    runId: result.runId,
    issuance: result.issuance,
  }, null, 2));
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  await closePool().catch(() => null);
  process.exit(1);
}

await closePool().catch(() => null);
