#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverMigrationNames } from "../server/db/migrate.js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(scriptsDir, "..", "server", "db", "migrations");
const files = (await readdir(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort((left, right) => left.localeCompare(right));
const discovered = await discoverMigrationNames();

assert.deepEqual(discovered, files, "every SQL migration must be discovered without manual registration");
assert.equal(new Set(discovered.map((name) => name.slice(0, 3))).size, discovered.length, "migration prefixes must be unique");
assert.ok(discovered.every((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)), "migration names must be deterministic and portable");
const migrateSource = await readFile(path.resolve(migrationsDir, "..", "migrate.js"), "utf8");
assert.match(migrateSource, /pg_advisory_xact_lock/, "concurrent process startup must serialize migrations");
assert.match(migrateSource, /SELECT 1 FROM \$\{migrationsTable\} WHERE name = \$1/, "migration ownership must be re-checked while holding the lock");
console.log(`migration discovery smoke ok: ${discovered.length} migration files are ordered, unique, and concurrency-guarded`);
