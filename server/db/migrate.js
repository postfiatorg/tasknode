import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseEnabled, query, transaction } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");

const migrations = [
  "001_chat_billing.sql",
  "002_chat_attachments.sql",
  "003_context_cache.sql",
  "004_chat_memory.sql",
  "005_deep_chat_memory.sql",
  "006_task_projections.sql",
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
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = await query("SELECT name FROM schema_migrations");
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  const appliedNow = [];

  for (const name of migrations) {
    if (appliedNames.has(name)) continue;
    const sql = await readFile(path.join(migrationsDir, name), "utf8");
    await transaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    });
    appliedNow.push(name);
  }

  migrated = true;
  return { ok: true, applied: appliedNow };
}
