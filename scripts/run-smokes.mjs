#!/usr/bin/env node
// Runs a smoke suite from smoke-suites.json. Each file gets its own process and
// runtime store; the db suite also gets its own freshly migrated *_test
// database. `verify` fails when a smoke file is in no suite, so a test cannot
// silently stop running.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

const suites = JSON.parse(readFileSync(new URL("./smoke-suites.json", import.meta.url), "utf8"));
const [suite, ...only] = process.argv.slice(2);

if (suite === "verify") {
  const gate = JSON.stringify(JSON.parse(readFileSync("package.json", "utf8")).scripts) + readFileSync(".github/workflows/ci.yml", "utf8");
  const listed = [...suites.unit, ...suites.db, ...Object.keys(suites.manual)];
  const duplicates = listed.filter((file, index) => listed.indexOf(file) !== index);
  const unlisted = readdirSync("scripts")
    .filter((name) => /(-smoke|-regression|-check)\.mjs$|\.test\.mjs$/.test(name))
    .map((name) => `scripts/${name}`)
    .filter((file) => !listed.includes(file) && !gate.includes(file));
  const missing = listed.filter((file) => !readdirSync("scripts").includes(path.basename(file)));
  if (duplicates.length || unlisted.length || missing.length) {
    console.error(JSON.stringify({ duplicates, unlisted, missing }, null, 2));
    process.exit(1);
  }
  console.log(`smoke suites ok: ${suites.unit.length} unit, ${suites.db.length} db, ${Object.keys(suites.manual).length} manual`);
  process.exit(0);
}

if (!["unit", "db"].includes(suite)) throw new Error("usage: run-smokes.mjs unit|db|verify [file ...]");
const adminUrl = process.env.TASKNODE_TEST_ADMIN_URL || "";
if (suite === "db" && !adminUrl) throw new Error("TASKNODE_TEST_ADMIN_URL (a maintenance database URL) is required for the db suite");

const failures = [];
for (const [index, file] of (only.length ? only : suites[suite]).entries()) {
  const dir = mkdtempSync(path.join(tmpdir(), "tasknode-smoke-"));
  const env = { ...process.env, TASKNODE_STORE_PATH: path.join(dir, "runtime-store.json"), TASKNODE_DATABASE_ENABLED: "false" };
  try {
    if (suite === "db") {
      const name = `tn_smoke_${index}_test`;
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`CREATE DATABASE ${name}`);
      await admin.end();
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      Object.assign(env, { DATABASE_URL: url.href, TASKNODE_DATABASE_ENABLED: "true" });
      if (spawnSync(process.execPath, ["scripts/migrate-db.mjs"], { env, stdio: "ignore" }).status !== 0) throw new Error("migration_failed");
    }
    const args = suites.loader.includes(file) ? ["--no-warnings", "--loader", "./scripts/esm-extension-loader.mjs", file] : [file];
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
    if (result.status !== 0) throw new Error(`${result.error?.message || `exit ${result.status}`}\n${`${result.stdout}${result.stderr}`.slice(-4000)}`);
    console.log(`ok ${file} ${Date.now() - startedAt}ms`);
  } catch (error) {
    failures.push(file);
    console.error(`FAIL ${file}: ${error.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(" ")}`);
  process.exit(1);
}
console.log(`${suite} smokes passed`);
