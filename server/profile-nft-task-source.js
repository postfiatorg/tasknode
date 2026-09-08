import { query } from "./db/pool.js";
import { nonFixtureTaskProjectionSql, completedTaskProjectionSql } from "./repositories/task-projection-integrity.js";

export async function profileNftTaskSource({ accountId, style = "", queryImpl = query, now = new Date() } = {}) {
  if (!accountId) throw new Error("profile_nft_account_required");
  const cutoff = now instanceof Date ? now : new Date(now);
  const [history, counts] = await Promise.all([
    queryImpl(`SELECT status,title,description,task_kind,reward_actual_pft,created_at,last_event_at
      FROM task_projections p WHERE account_id=$1 AND ${nonFixtureTaskProjectionSql("p")}
      ORDER BY last_event_at DESC,task_id DESC LIMIT 201`, [accountId]),
    queryImpl(`SELECT count(*)::int AS total_tasks,
      count(*) FILTER (WHERE ${completedTaskProjectionSql("p")})::int AS completed_tasks,
      count(*) FILTER (WHERE ${completedTaskProjectionSql("p")} AND last_event_at >= $2::timestamptz-interval '7 days')::int AS completed_last_7_days,
      count(*) FILTER (WHERE ${completedTaskProjectionSql("p")} AND last_event_at >= $2::timestamptz-interval '14 days' AND last_event_at < $2::timestamptz-interval '7 days')::int AS completed_previous_7_days,
      count(*) FILTER (WHERE ${completedTaskProjectionSql("p")} AND last_event_at >= $2::timestamptz-interval '30 days')::int AS completed_last_30_days
      FROM task_projections p WHERE account_id=$1 AND ${nonFixtureTaskProjectionSql("p")}`, [accountId, cutoff.toISOString()]),
  ]);
  const ageDays = (date) => date ? Math.max(0, Math.floor((cutoff.getTime()-new Date(date).getTime())/86400000)) : null;
  return {
    schema: "tasknode.nft.task_evidence.v2",
    metrics: counts.rows[0] || {},
    history_truncated: history.rows.length > 200,
    tasks: history.rows.slice(0,200).map((row,index) => ({
      ref: `work_${index+1}`, status: row.status, kind: row.task_kind,
      title: String(row.title || "").slice(0,240), description: String(row.description || "").slice(0,1800),
      days_since_creation: ageDays(row.created_at), days_since_activity: ageDays(row.last_event_at),
      rewarded: Number(row.reward_actual_pft || 0)>0,
    })),
    untrusted_style_preference: String(style || "").trim().slice(0,1200),
  };
}
