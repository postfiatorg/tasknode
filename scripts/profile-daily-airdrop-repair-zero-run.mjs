#!/usr/bin/env node
import { closePool, databaseEnabled, query } from "../server/db/pool.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1] || fallback;
  return fallback;
}

function dateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

const accountId = argValue("--account-id", process.env.TASKNODE_DAILY_AIRDROP_ACCOUNT_ID || "");
const runDate = dateOnly(argValue("--run-date", new Date().toISOString()));
const reason = argValue(
  "--reason",
  "Superseded: production run scored with empty worker wallet cloud before DB-backed wallet-cloud fix."
);

if (!accountId) {
  console.error("Usage: node scripts/profile-daily-airdrop-repair-zero-run.mjs --account-id <account_id> [--run-date yyyy-mm-dd]");
  process.exit(1);
}

try {
  if (!databaseEnabled()) throw new Error("database_not_configured");
  const result = await query(
    `WITH target AS (
       SELECT r.id
         FROM profile_daily_airdrop_runs r
        WHERE r.account_id = $1
          AND r.run_date = $2::date
          AND r.run_mode = 'production'
          AND r.status = 'completed'
          AND r.daily_airdrop_pft = 0
          AND COALESCE(NULLIF(r.input_snapshot->'identity_cloud'->>'eligible_wallet_count', '')::int, 0) = 0
          AND COALESCE(NULLIF(r.input_snapshot->'reward_totals'->>'rewarded_task_count', '')::int, 0) = 0
          AND NOT EXISTS (
            SELECT 1
              FROM profile_daily_airdrop_issuances i
             WHERE i.run_id = r.id
          )
        ORDER BY r.created_at DESC
        LIMIT 1
     )
     UPDATE profile_daily_airdrop_runs r
        SET run_mode = 'dry_run',
            is_canonical = false,
            scenario_id = CASE
              WHEN scenario_id LIKE 'operator_repair_bad_empty_packet:%' THEN scenario_id
              ELSE 'operator_repair_bad_empty_packet:' || COALESCE(NULLIF(scenario_id, ''), r.id)
            END,
            error_message = COALESCE(NULLIF(error_message, ''), $3),
            updated_at = now()
       FROM target
      WHERE r.id = target.id
      RETURNING r.id,
                r.account_id,
                r.run_date::text,
                r.run_mode,
                r.status,
                r.daily_airdrop_pft::text,
                r.scenario_id,
                r.error_message`,
    [accountId, runDate, reason]
  );
  if (result.rowCount !== 1) {
    throw new Error("daily_airdrop_zero_run_repair_no_guarded_row");
  }
  console.log(JSON.stringify({ ok: true, demoted: result.rows[0] }, null, 2));
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool().catch(() => null);
}
