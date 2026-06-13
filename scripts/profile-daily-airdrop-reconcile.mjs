#!/usr/bin/env node
import { closePool, databaseEnabled } from "../server/db/pool.js";
import { reconcileDailyAirdropIssuance } from "../server/profile-daily-airdrop-issuance.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
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

const runId = argValue("--run-id", "");
const issuanceId = argValue("--issuance-id", "");
const allowDemote = hasFlag("--allow-demote");
const forceDemoteStaleSync = hasFlag("--force-demote-stale-sync");

if (!runId && !issuanceId) {
  console.error(
    "Usage: node scripts/profile-daily-airdrop-reconcile.mjs --run-id=<run_id> [--allow-demote] [--force-demote-stale-sync] [--json]"
  );
  process.exit(1);
}

try {
  if (!databaseEnabled()) throw new Error("database_not_configured");
  const result = await reconcileDailyAirdropIssuance({ runId, issuanceId, allowDemote, forceDemoteStaleSync });
  if (hasFlag("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ok=${result.ok}`);
    console.log(`found=${Boolean(result.found || result.alreadySubmitted)}`);
    console.log(`demoted=${Boolean(result.demoted)}`);
    console.log(`demote_blocked=${Boolean(result.demoteBlocked)}`);
    if (result.demoteBlockedReason) console.log(`demote_blocked_reason=${result.demoteBlockedReason}`);
    console.log(`status=${result.issuance?.status || result.status || ""}`);
    if (result.txHash) console.log(`tx_hash=${result.txHash}`);
    if (result.issuance?.id) console.log(`issuance_id=${result.issuance.id}`);
    if (result.issuance?.runId) console.log(`run_id=${result.issuance.runId}`);
    if (result.syncWatermarks) {
      console.log(`submission_attempted_at=${result.syncWatermarks.submissionAttemptedAt || ""}`);
      console.log(
        `source_wallet_last_hot_sync_at=${result.syncWatermarks.sourceWallet?.lastHotSyncAt || ""}` +
          ` stale_for_demote=${Boolean(result.syncWatermarks.sourceWallet?.staleForDemote)}`
      );
      console.log(
        `recipient_wallet_last_hot_sync_at=${result.syncWatermarks.recipientWallet?.lastHotSyncAt || ""}` +
          ` stale_for_demote=${Boolean(result.syncWatermarks.recipientWallet?.staleForDemote)}`
      );
    }
  }
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  await closePool().catch(() => null);
  process.exit(1);
}

await closePool().catch(() => null);
