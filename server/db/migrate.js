import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseEnabled, query, transaction } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");
const migrationsTable = "tasknode_schema_migrations";

const migrations = [
  "001_chat_billing.sql",
  "002_chat_attachments.sql",
  "003_context_cache.sql",
  "004_chat_memory.sql",
  "005_deep_chat_memory.sql",
  "006_task_projections.sql",
  "007_pftl_transaction_cache.sql",
  "008_pftl_cache_watcher.sql",
  "009_pftl_cache_reducer_dedupe_key.sql",
  "010_pftl_cache_operations.sql",
  "011_context_history_projection_source.sql",
  "012_task_requests.sql",
  "013_deep_memory_snapshots.sql",
  "014_jobs_corpus_pgvector.sql",
  "015_context_edit_proposals.sql",
  "016_context_current_draft_only.sql",
  "017_context_prune_non_current_drafts.sql",
  "018_profile_nfts.sql",
  "019_profile_daily_airdrop.sql",
  "020_profile_daily_airdrop_issuance.sql",
  "021_profile_public_snapshots.sql",
  "022_profile_public_snapshot_prompt_uniqueness.sql",
  "023_pftl_pointer_observations.sql",
  "024_network_task_profiles.sql",
  "025_prune_orphan_task_projection_garbage.sql",
  "026_network_task_profile_prompt_v2_default.sql",
  "027_hive_context_entries.sql",
  "028_hive_secretary_reports.sql",
  "029_hive_network_projects.sql",
  "030_hive_project_seed_cleanup.sql",
  "031_hive_project_planning.sql",
  "032_archive_rejected_hive_scoping_projects.sql",
  "033_board_manager_v0.sql",
  "034_lock_operator_archived_hive_projects.sql",
  "035_board_manager_action_hooks.sql",
  "036_board_manager_persistent_sessions.sql",
  "037_hive_input_ack_copy.sql",
  "038_network_project_product_docs.sql",
  "039_network_task_allocations.sql",
  "040_network_task_idempotency_and_status.sql",
  "041_board_manager_run_micro_summaries.sql",
  "042_board_manager_scheduler.sql",
  "043_board_manager_secretary_packets.sql",
  "044_board_manager_action_budget.sql",
  "045_profile_daily_airdrop_processing_status.sql",
  "046_wallet_initiation_grants.sql",
  "047_telegram_bot_events.sql",
  "048_account_deletion_audit.sql",
  "049_board_manager_message_dedupe_index.sql",
  "050_board_manager_state_guardrails.sql",
  "051_task_review_publication_locks.sql",
  "052_taskgen_split_prompt_versions.sql",
  "053_recommended_connections.sql",
  "054_ipfs_replication_jobs.sql",
  "055_user_observability_events.sql",
  "056_user_identity_vectors.sql",
  "057_profile_daily_airdrop_remediation.sql",
  "058_board_manager_capability_profiles.sql",
  "059_board_manager_evidence_evaluation_packets.sql",
  "060_taskgen_replay_cache.sql",
  "061_projection_fixture_cleanup.sql",
  "062_orc_agents_and_activity.sql",
  "063_orc_task_reviews.sql",
  "064_orc_review_queue_public_items.sql",
];

let migrated = false;

export async function migrateDatabase({ force = false } = {}) {
  if (!databaseEnabled()) {
    return { ok: true, skipped: true, reason: "database_not_configured" };
  }
  if (migrated && !force) {
    return { ok: true, skipped: true, reason: "already_migrated" };
  }

  await query(`
    CREATE TABLE IF NOT EXISTS ${migrationsTable} (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = await query(`SELECT name FROM ${migrationsTable}`);
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  const appliedNow = [];

  for (const name of migrations) {
    if (appliedNames.has(name)) continue;
    const sql = await readFile(path.join(migrationsDir, name), "utf8");
    await transaction(async (client) => {
      await client.query(sql);
      await client.query(`INSERT INTO ${migrationsTable} (name) VALUES ($1)`, [name]);
    });
    appliedNow.push(name);
  }

  migrated = true;
  return { ok: true, applied: appliedNow };
}
