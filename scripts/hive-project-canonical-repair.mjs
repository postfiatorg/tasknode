import { Client } from "pg";
import { canonicalHiveProjectFor, canonicalHiveProjects } from "../server/hive-project-canonical.js";

const execute = process.argv.includes("--execute");

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function jsonValue(value = {}) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function intValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function dbUrl() {
  const value = process.env.TASKNODE_DATABASE_URL || process.env.DATABASE_URL;
  if (!value) throw new Error("TASKNODE_DATABASE_URL or DATABASE_URL is required");
  return value;
}

async function ensureCanonicalProject(client, canonical) {
  await client.query(
    `
      INSERT INTO network_projects (
        id, type, title, summary, objective, about, status, priority, origin,
        proposed_by, proposed_at, phase_label, phase_current, phase_total,
        pft_routed, task_count, contributor_count, metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, 'system_canonical', 'hive_repair',
        CURRENT_DATE, $8, $9, $10, 0, 0, 0, $11::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        objective = EXCLUDED.objective,
        about = EXCLUDED.about,
        status = 'active',
        priority = EXCLUDED.priority,
        phase_label = EXCLUDED.phase_label,
        phase_current = EXCLUDED.phase_current,
        phase_total = EXCLUDED.phase_total,
        metadata_json = (
          COALESCE(network_projects.metadata_json, '{}'::jsonb)
          - 'operator_archived'
          - 'archive_lock_source'
          - 'archive_lock_applied_at'
          - 'archive_lock_respected_at'
        ) || EXCLUDED.metadata_json,
        updated_at = now()
    `,
    [
      canonical.id,
      canonical.type,
      canonical.title,
      canonical.summary,
      canonical.objective,
      canonical.about,
      intValue(canonical.priority, 10),
      safeText(canonical.phase_label, 80),
      intValue(canonical.phase_current, 1),
      intValue(canonical.phase_total, 1),
      jsonValue({
        canonical_project: true,
        canonicalized_by: "hive-project-canonical-repair",
        canonicalized_at: new Date().toISOString(),
      }),
    ]
  );
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `
      SELECT to_regclass($1) AS table_name
    `,
    [`public.${tableName}`]
  );
  return Boolean(result.rows[0]?.table_name);
}

async function repairGroup(client, canonical, duplicateIds) {
  if (!duplicateIds.length) {
    return { canonicalProjectId: canonical.id, duplicateIds, updates: {} };
  }
  await ensureCanonicalProject(client, canonical);
  const updates = {};
  updates.taskRefs = (await client.query(
    `
      UPDATE network_project_task_refs
      SET project_id = $1,
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
      WHERE project_id = ANY($2::text[])
    `,
    [canonical.id, duplicateIds, jsonValue({ canonical_project_id: canonical.id })]
  )).rowCount || 0;
  updates.activity = (await client.query(
    `
      UPDATE network_project_activity
      SET project_id = $1,
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
      WHERE project_id = ANY($2::text[])
    `,
    [canonical.id, duplicateIds, jsonValue({ canonical_project_id: canonical.id })]
  )).rowCount || 0;
  await client.query(
    `
      INSERT INTO network_project_contributors (
        project_id, wallet_address, codename, archetype, badge_variant, allotted, cap,
        load, status, task_count, pft_earned, last_active_label, role_label,
        sort_order, metadata_json
      )
      SELECT $1,
        wallet_address,
        max(codename),
        max(archetype),
        max(badge_variant),
        bool_or(allotted),
        max(cap),
        max(load),
        max(status),
        sum(task_count)::int,
        sum(pft_earned),
        max(last_active_label),
        max(role_label),
        min(sort_order),
        jsonb_object_agg(project_id, COALESCE(metadata_json, '{}'::jsonb)) || $3::jsonb
      FROM network_project_contributors
      WHERE project_id = ANY($2::text[])
      GROUP BY wallet_address
      ON CONFLICT (project_id, wallet_address) DO UPDATE SET
        allotted = network_project_contributors.allotted OR EXCLUDED.allotted,
        cap = GREATEST(network_project_contributors.cap, EXCLUDED.cap),
        load = GREATEST(network_project_contributors.load, EXCLUDED.load),
        task_count = network_project_contributors.task_count + EXCLUDED.task_count,
        pft_earned = network_project_contributors.pft_earned + EXCLUDED.pft_earned,
        metadata_json = COALESCE(network_project_contributors.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
        updated_at = now()
    `,
    [canonical.id, duplicateIds, jsonValue({ canonical_project_id: canonical.id })]
  );
  updates.contributorsDeleted = (await client.query(
    "DELETE FROM network_project_contributors WHERE project_id = ANY($1::text[])",
    [duplicateIds]
  )).rowCount || 0;
  updates.allocations = (await client.query(
    `
      UPDATE network_task_allocations
      SET project_id = $1,
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
      WHERE project_id = ANY($2::text[])
    `,
    [canonical.id, duplicateIds, jsonValue({ canonical_project_id: canonical.id })]
  )).rowCount || 0;
  updates.generationJobs = (await client.query(
    `
      UPDATE network_task_generation_jobs
      SET project_id = $1,
          source_payload_json = COALESCE(source_payload_json, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
      WHERE project_id = ANY($2::text[])
    `,
    [canonical.id, duplicateIds, jsonValue({ canonical_project_id: canonical.id })]
  )).rowCount || 0;
  if (await tableExists(client, "network_task_intents")) {
    updates.intents = (await client.query(
      `
        UPDATE network_task_intents
        SET project_id = $1,
            metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
        WHERE project_id = ANY($2::text[])
      `,
      [canonical.id, duplicateIds, jsonValue({ canonical_project_id: canonical.id })]
    )).rowCount || 0;
  }
  if (await tableExists(client, "board_manager_followups")) {
    updates.followups = (await client.query(
      `
        UPDATE board_manager_followups
        SET project_id = $1,
            metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
        WHERE project_id = ANY($2::text[])
      `,
      [canonical.id, duplicateIds, jsonValue({ canonical_project_id: canonical.id })]
    )).rowCount || 0;
  }
  if (await tableExists(client, "network_project_product_docs")) {
    updates.productDocsArchived = (await client.query(
      `
        UPDATE network_project_product_docs
        SET status = 'archived',
            superseded_at = COALESCE(superseded_at, now()),
            source_refs_json = COALESCE(source_refs_json, '{}'::jsonb) || $2::jsonb
        WHERE project_id = ANY($1::text[])
          AND status = 'current'
          AND superseded_at IS NULL
      `,
      [duplicateIds, jsonValue({ canonical_project_id: canonical.id })]
    )).rowCount || 0;
  }
  updates.duplicatesArchived = (await client.query(
    `
      UPDATE network_projects
      SET status = 'archived',
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
      WHERE id = ANY($1::text[])
        AND id <> $2
    `,
    [
      duplicateIds,
      canonical.id,
      jsonValue({
        canonical_project_id: canonical.id,
        canonicalized_by: "hive-project-canonical-repair",
        canonicalized_at: new Date().toISOString(),
      }),
    ]
  )).rowCount || 0;
  const rollupIds = [canonical.id, ...duplicateIds];
  updates.rollups = (await client.query(
    `
      UPDATE network_projects project
      SET task_count = (
            SELECT count(*)::int
            FROM network_project_task_refs refs
            WHERE refs.project_id = project.id
          ),
          contributor_count = (
            SELECT count(*)::int
            FROM network_project_contributors contributor
            WHERE contributor.project_id = project.id
              AND contributor.status <> 'archived'
          ),
          pft_routed = (
            SELECT COALESCE(sum(refs.reward_pft), 0)
            FROM network_project_task_refs refs
            WHERE refs.project_id = project.id
          ),
          updated_at = now()
      WHERE project.id = ANY($1::text[])
    `,
    [rollupIds]
  )).rowCount || 0;
  return { canonicalProjectId: canonical.id, duplicateIds, updates };
}

async function main() {
  const client = new Client({ connectionString: dbUrl() });
  await client.connect();
  try {
    const projects = (await client.query(
      `
        SELECT id, type, title, summary, objective, about, status, metadata_json
        FROM network_projects
        ORDER BY id ASC
      `
    )).rows;
    const groups = new Map();
    for (const project of projects) {
      const canonical = canonicalHiveProjectFor(project);
      if (!canonical) continue;
      if (!groups.has(canonical.id)) groups.set(canonical.id, { canonical, duplicates: [] });
      if (project.id !== canonical.id) groups.get(canonical.id).duplicates.push(project.id);
    }
    const plan = [...groups.values()].map((group) => ({
      canonicalProjectId: group.canonical.id,
      duplicateIds: group.duplicates,
    })).filter((group) => group.duplicateIds.length);
    if (!execute) {
      console.log(JSON.stringify({ ok: true, dryRun: true, plan }, null, 2));
      return;
    }
    const results = await client.query("BEGIN").then(async () => {
      const repaired = [];
      for (const group of groups.values()) {
        repaired.push(await repairGroup(client, group.canonical, group.duplicates));
      }
      await client.query("COMMIT");
      return repaired.filter((item) => item.duplicateIds.length);
    }).catch(async (error) => {
      await client.query("ROLLBACK").catch(() => null);
      throw error;
    });
    console.log(JSON.stringify({ ok: true, dryRun: false, results }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
