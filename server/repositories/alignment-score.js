import { databaseEnabled, query } from "../db/pool.js";
import { nonFixtureAirdropRunSql } from "./task-projection-integrity.js";

// Alignment is the daily airdrop model's own 0-100 assessment of a member's
// rewarded work (retention_value_score), averaged over the eligible production
// runs in a trailing window. It is not the payout share: alignment_score_7d
// divides airdrop PFT by a 10,000 PFT/day cap the scoring model almost never
// approaches, so it read near zero for everyone and swung with model changes.
export const ALIGNMENT_WINDOW_DAYS = Math.max(1, Number(process.env.TASKNODE_ALIGNMENT_WINDOW_DAYS || 30));

// One row per account: alignment_score (0-100 numeric text or NULL),
// alignment_scored_days, alignment_last_run_date, alignment_completed_at.
// `accountIdsParam` is the SQL placeholder holding a text[] of account ids.
export function alignmentByAccountSql(accountIdsParam = "$1") {
  return `
    SELECT run.account_id,
           ROUND(AVG(run.retention_value_score)::numeric, 2)::text AS alignment_score,
           COUNT(*)::integer AS alignment_scored_days,
           MAX(run.run_date) AS alignment_last_run_date,
           MAX(run.completed_at) AS alignment_completed_at
      FROM profile_daily_airdrop_runs run
     WHERE run.account_id = ANY(${accountIdsParam}::text[])
       AND run.status = 'completed'
       AND run.run_mode = 'production'
       AND run.eligibility_status = 'eligible'
       AND run.run_date >= (now() AT TIME ZONE 'UTC')::date - ${ALIGNMENT_WINDOW_DAYS}
       AND ${nonFixtureAirdropRunSql("run")}
     GROUP BY run.account_id`;
}

export function alignmentScore0To100(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function dateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export async function getAccountAlignment({ accountId = "", queryImpl = query, databaseReady = databaseEnabled() } = {}) {
  const id = String(accountId || "").trim().slice(0, 180);
  const empty = { score0To100: null, scoredDays: 0, windowDays: ALIGNMENT_WINDOW_DAYS, lastRunDate: "", completedAt: null };
  if (!id || !databaseReady) return empty;
  const result = await queryImpl(alignmentByAccountSql("$1"), [[id]]);
  const row = result.rows?.[0];
  if (!row) return empty;
  return {
    score0To100: alignmentScore0To100(row.alignment_score),
    scoredDays: Number(row.alignment_scored_days || 0),
    windowDays: ALIGNMENT_WINDOW_DAYS,
    lastRunDate: dateOnly(row.alignment_last_run_date),
    completedAt: row.alignment_completed_at ? new Date(row.alignment_completed_at).toISOString() : null,
  };
}
