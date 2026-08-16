import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseEnabled, query, transaction } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");
const migrationsTable = "tasknode_schema_migrations";

export async function discoverMigrationNames() {
  const names = (await readdir(migrationsDir))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  const prefixes = names.map((name) => name.slice(0, 3));
  if (new Set(prefixes).size !== prefixes.length) throw new Error("duplicate_database_migration_prefix");
  return names;
}

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

  for (const name of await discoverMigrationNames()) {
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
