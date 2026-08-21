import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

if (!databaseEnabled()) {
  console.error("repair_hive_project_rollups_requires_postgres");
  process.exit(1);
}

try {
  await migrateDatabase();
  const before = await query(
    `
      SELECT id, title, task_count, contributor_count, pft_routed
      FROM network_projects
      WHERE status = 'active'
      ORDER BY priority ASC, title ASC
    `
  );
  const repaired = await query(
    `
      WITH task_rollup AS (
        SELECT
          refs.project_id,
          count(*)::int AS task_count,
          COALESCE(sum(
            CASE
              WHEN projection.status = 'rewarded' THEN projection.reward_actual_pft
              ELSE projection.reward_offer_pft
            END
          ), 0)::numeric AS pft_routed,
          count(DISTINCT NULLIF(COALESCE(NULLIF(projection.subject_wallet, ''), refs.assignee_wallet), ''))::int AS task_contributor_count
        FROM network_project_task_refs refs
        JOIN task_projections projection
          ON projection.task_id = refs.task_id
        WHERE refs.task_id <> ''
        GROUP BY refs.project_id
      ), contributor_rollup AS (
        SELECT
          project_id,
          count(DISTINCT NULLIF(wallet_address, ''))::int AS contributor_count
        FROM network_project_contributors
        WHERE status <> 'archived'
        GROUP BY project_id
      )
      UPDATE network_projects project
      SET task_count = COALESCE(task_rollup.task_count, 0),
          pft_routed = COALESCE(task_rollup.pft_routed, 0),
          contributor_count = GREATEST(
            COALESCE(task_rollup.task_contributor_count, 0),
            COALESCE(contributor_rollup.contributor_count, 0)
          ),
          updated_at = now()
      FROM network_projects target
      LEFT JOIN task_rollup ON task_rollup.project_id = target.id
      LEFT JOIN contributor_rollup ON contributor_rollup.project_id = target.id
      WHERE project.id = target.id
        AND project.status = 'active'
      RETURNING project.id, project.title, project.task_count, project.contributor_count, project.pft_routed
    `
  );
  console.log(JSON.stringify({ ok: true, before: before.rows, after: repaired.rows }, null, 2));
} finally {
  await closePool();
}
