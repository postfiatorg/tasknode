#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const migrationsDir = path.join(repoRoot, "server", "db", "migrations");
const migratePath = path.join(repoRoot, "server", "db", "migrate.js");

function extractRegisteredMigrations(source) {
  const declaration = source.match(/const\s+migrations\s*=\s*\[([\s\S]*?)\];/);
  if (!declaration) {
    throw new Error("could_not_find_migrations_array");
  }
  return Array.from(declaration[1].matchAll(/["']([^"']+\.sql)["']/g), (match) => match[1]);
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return Array.from(repeated).sort();
}

const [dirEntries, migrateSource] = await Promise.all([
  readdir(migrationsDir, { withFileTypes: true }),
  readFile(migratePath, "utf8"),
]);

const migrationFiles = dirEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();
const registeredMigrations = extractRegisteredMigrations(migrateSource);
const registeredSet = new Set(registeredMigrations);
const fileSet = new Set(migrationFiles);

const missingRegistrations = migrationFiles.filter((name) => !registeredSet.has(name));
const staleRegistrations = registeredMigrations.filter((name) => !fileSet.has(name));
const duplicateRegistrations = duplicates(registeredMigrations);

if (missingRegistrations.length || staleRegistrations.length || duplicateRegistrations.length) {
  console.error("migration registration smoke failed:");
  if (missingRegistrations.length) {
    console.error("  SQL files missing from server/db/migrate.js:");
    for (const name of missingRegistrations) console.error(`    - ${name}`);
  }
  if (staleRegistrations.length) {
    console.error("  server/db/migrate.js entries with no SQL file:");
    for (const name of staleRegistrations) console.error(`    - ${name}`);
  }
  if (duplicateRegistrations.length) {
    console.error("  duplicate server/db/migrate.js entries:");
    for (const name of duplicateRegistrations) console.error(`    - ${name}`);
  }
  process.exit(1);
}

console.log(
  `migration registration smoke ok: ${migrationFiles.length} migration files are registered in server/db/migrate.js`
);
