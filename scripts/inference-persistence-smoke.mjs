import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
if (!process.env.DATABASE_URL) throw new Error("inference_persistence_smoke_database_required");
process.env.TASKNODE_DATABASE_ENABLED = "true";
delete process.env.TASKNODE_DATABASE_DISABLED;
delete process.env.TASKNODE_POSTGRES_DISABLED;
const { query, closePool } = await import("../server/db/pool.js");
const { completeDailyAirdropRun } = await import("../server/repositories/profile-daily-airdrop.js");
const { completePublicProfileSnapshot } = await import("../server/repositories/profile-public.js");
const id = `inference_fixture_${randomUUID()}`;
try {
  await query("INSERT INTO profile_daily_airdrop_runs (id, account_id, run_date, provider, model) VALUES ($1, $1, CURRENT_DATE, 'vercel', 'zai/glm-5.3')", [id]);
  await query("INSERT INTO profile_public_snapshots (snapshot_id, account_id, provider, model) VALUES ($1, $1, 'vercel', 'zai/glm-5.3')", [id]);
  await completeDailyAirdropRun({ id, provider: "ambient", model: "z-ai/glm-5.2", output: { fixture: true } });
  await completePublicProfileSnapshot({ snapshotId: id, provider: "ambient", model: "z-ai/glm-5.2", output: { role_title: "Fixture" } });
  for (const [table, column] of [["profile_daily_airdrop_runs", "id"], ["profile_public_snapshots", "snapshot_id"]]) {
    const { rows } = await query(`SELECT status, provider, model FROM ${table} WHERE ${column} = $1`, [id]);
    assert.deepEqual(rows[0], { status: "completed", provider: "ambient", model: "z-ai/glm-5.2" });
  }
  const defaults = await query("SELECT table_name, column_default FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'provider' AND table_name IN ('board_manager_secretary_packets', 'hive_decision_runs') ORDER BY table_name");
  assert.equal(defaults.rows.length, 2);
  defaults.rows.forEach((row) => assert.equal(row.column_default, "'vercel'::text"));
  const narrator = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'bm_activity_summaries' AND column_name = 'provider'");
  assert.equal(narrator.rows.length, 1);
  console.log(JSON.stringify({ ok: true, boundaries: ["airdrop actual provider", "public snapshot actual provider", "new row defaults", "narrator attribution"] }));
} finally {
  await query("DELETE FROM profile_daily_airdrop_runs WHERE id = $1", [id]);
  await query("DELETE FROM profile_public_snapshots WHERE snapshot_id = $1", [id]);
  await closePool();
}
