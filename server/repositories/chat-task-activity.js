import { databaseEnabled, query } from "../db/pool.js";
import { nonFixtureTaskProjectionSql } from "./task-projection-integrity.js";

export const CHAT_TASK_ACTIVITY_LIMITS = Object.freeze({ members: 20, tasks: 20, events: 40, hours: 48 });

// Re-evaluate directional grants and the personal-context preference in the same
// SQL snapshot as the data. Never cache another account's permission to appear.
export async function readChatTaskActivity({
  accountId = "",
  now = new Date(),
  queryFn = query,
  enabled = databaseEnabled(),
  teamEnabled = process.env.TASKNODE_TEAM_ENABLED !== "false",
} = {}) {
  if (!accountId || !enabled) return null;
  const capturedAt = new Date(now).toISOString();
  const since = new Date(new Date(now).getTime() - CHAT_TASK_ACTIVITY_LIMITS.hours * 3600000).toISOString();
  const result = await queryFn(`
    WITH authorized AS (
      SELECT $1::text AS account_id
      UNION
      SELECT g.subject_account_id FROM task_history_grants g
      WHERE g.viewer_account_id = $1 AND g.status = 'active' AND g.scope = 'task_history_v1'
        AND $3::boolean
        AND EXISTS (SELECT 1 FROM team_context_preferences pref
                    WHERE pref.account_id = $1 AND pref.include_in_personal_context = true)
    ), members AS (
      SELECT account_id, count(*) OVER () AS authorized_count FROM authorized
      ORDER BY (account_id = $1) DESC, account_id LIMIT $4
    ), candidate_tasks AS MATERIALIZED (
      -- Filter small scalar state/time fields before detoasting fixture metadata
      -- or descriptions from older completed tasks. Keep this bounded to members.
      SELECT p.account_id, p.task_id, p.title, p.status, p.description,
             p.subject_wallet, p.reward_actual_pft, p.updated_at, p.last_event_at,
             p.deadline_at, p.accept_by, p.source, p.metadata_json
      FROM task_projections p JOIN members m ON m.account_id = p.account_id
      WHERE p.status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted')
         OR p.last_event_at >= $2::timestamptz
    )
    SELECT m.account_id, m.authorized_count, a.hive_handle,
      COALESCE(tasks.items, '[]'::jsonb) AS tasks,
      COALESCE(events.items, '[]'::jsonb) AS events
    FROM members m LEFT JOIN app_accounts a ON a.account_id = m.account_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(t ORDER BY t.updated_at DESC, t.task_id) AS items FROM (
        SELECT p.task_id, p.title, p.status, left(p.description, 700) AS description,
               p.subject_wallet, p.reward_actual_pft, p.updated_at, p.last_event_at,
               p.deadline_at, p.accept_by, count(*) OVER () AS matching_count
        FROM candidate_tasks p
        WHERE p.account_id = m.account_id AND ${nonFixtureTaskProjectionSql("p")}
        ORDER BY p.updated_at DESC, p.task_id LIMIT $5
      ) t
    ) tasks ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(e ORDER BY e.occurred_at DESC, e.id) AS items FROM (
        SELECT e.id, e.task_id, p.title, e.event_type, e.occurred_at,
               e.payload_json->>'transition' AS transition,
               e.payload_json->>'task_action' AS task_action,
               p.status AS current_task_status, count(*) OVER () AS matching_count
        FROM task_events e JOIN task_projections p ON p.task_id = e.task_id
          AND p.account_id = e.account_id AND p.subject_wallet = e.wallet_address
        WHERE e.account_id = m.account_id AND e.occurred_at >= $2::timestamptz
          AND ${nonFixtureTaskProjectionSql("p")}
        ORDER BY e.occurred_at DESC, e.id DESC LIMIT $6
      ) e
    ) events ON true
    ORDER BY (m.account_id = $1) DESC, m.account_id
  `, [accountId, since, teamEnabled, CHAT_TASK_ACTIVITY_LIMITS.members,
    CHAT_TASK_ACTIVITY_LIMITS.tasks, CHAT_TASK_ACTIVITY_LIMITS.events]);
  return {
    schema: "tasknode.chat_task_activity.v1",
    capturedAt,
    since,
    timezone: "UTC",
    source: "task_projections and task_events",
    authorizedMemberCount: Number(result.rows[0]?.authorized_count || 0),
    limits: CHAT_TASK_ACTIVITY_LIMITS,
    members: result.rows.map((row) => ({
      accountId: row.account_id,
      handle: row.hive_handle || "",
      self: row.account_id === accountId,
      matchingTaskCount: Number(row.tasks[0]?.matching_count || 0),
      recentEventCount: Number(row.events[0]?.matching_count || 0),
      tasks: row.tasks.map(({ matching_count: _count, ...task }) => task),
      events: row.events.map(({ matching_count: _count, ...event }) => event),
    })),
  };
}
