#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const safeDatabasePrefix = "tasknode_recovery_";
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

export function databaseConfig(input, { requireLoopback = true } = {}) {
  const parsed = new URL(String(input || ""));
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("recovery_database_url_invalid");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) throw new Error("recovery_database_name_invalid");
  if (requireLoopback && !loopbackHosts.has(parsed.hostname)) throw new Error("recovery_remote_database_refused");
  const env = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username || ""),
    PGPASSWORD: decodeURIComponent(parsed.password || ""),
    PGDATABASE: database,
  };
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return {
    database,
    env,
    fingerprint: createHash("sha256")
      .update(`${parsed.hostname}:${env.PGPORT}/${database}`)
      .digest("hex")
      .slice(0, 20),
  };
}

function run(command, args, { env = process.env, capture = false, tolerateFailure = false } = {}) {
  try {
    return execFileSync(command, args, {
      cwd: repoRoot,
      env,
      encoding: capture ? "utf8" : undefined,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (error) {
    if (tolerateFailure) return null;
    const failure = new Error(`recovery_command_failed:${command}`);
    failure.cause = error;
    throw failure;
  }
}

function query(config, sql) {
  return String(run("psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--command", sql], {
    env: config.env,
    capture: true,
  })).trim();
}

function fileDigest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function validateRuntimeStore(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Number.isInteger(parsed.version)) {
    throw new Error("runtime_store_backup_invalid");
  }
  return parsed;
}

export function requireEmptyDirectory(directory) {
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root || resolved === repoRoot || resolved === path.resolve(tmpdir())) {
    throw new Error("recovery_output_directory_unsafe");
  }
  if (existsSync(resolved) && readdirSync(resolved).length) throw new Error("recovery_output_directory_not_empty");
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  chmodSync(resolved, 0o700);
  return resolved;
}

export function backup({ databaseUrl, runtimeStore = "", outputDirectory }) {
  const config = databaseConfig(databaseUrl);
  const output = requireEmptyDirectory(outputDirectory);
  const databaseFile = path.join(output, "postgres.dump");
  run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--file=${databaseFile}`], { env: config.env });
  chmodSync(databaseFile, 0o600);
  run("pg_restore", ["--list", databaseFile], { capture: true });

  let runtime = null;
  if (runtimeStore) {
    const source = path.resolve(runtimeStore);
    validateRuntimeStore(source);
    const destination = path.join(output, "runtime-store.json");
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
    validateRuntimeStore(destination);
    runtime = { file: path.basename(destination), bytes: statSync(destination).size, sha256: fileDigest(destination) };
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceFingerprint: config.fingerprint,
    postgres: { file: path.basename(databaseFile), bytes: statSync(databaseFile).size, sha256: fileDigest(databaseFile) },
    runtime,
  };
  const manifestFile = path.join(output, "MANIFEST.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { output, manifest, manifestFile };
}

export function verifyBackup(directory) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(readFileSync(path.join(root, "MANIFEST.json"), "utf8"));
  for (const entry of [manifest.postgres, manifest.runtime].filter(Boolean)) {
    const file = path.join(root, entry.file);
    if (!existsSync(file) || statSync(file).size !== entry.bytes || fileDigest(file) !== entry.sha256) {
      throw new Error(`recovery_backup_integrity_failed:${entry.file}`);
    }
  }
  run("pg_restore", ["--list", path.join(root, manifest.postgres.file)], { capture: true });
  if (manifest.runtime) validateRuntimeStore(path.join(root, manifest.runtime.file));
  return manifest;
}

export function restore({ databaseUrl, backupDirectory, runtimeTarget = "" }) {
  const config = databaseConfig(databaseUrl);
  if (!config.database.startsWith(safeDatabasePrefix)) throw new Error("recovery_restore_target_name_refused");
  const manifest = verifyBackup(backupDirectory);
  const tableCount = Number(query(config, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"));
  if (tableCount !== 0) throw new Error("recovery_restore_target_not_empty");
  run("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", `--dbname=${config.database}`, path.join(path.resolve(backupDirectory), manifest.postgres.file)], {
    env: config.env,
  });
  if (manifest.runtime && runtimeTarget) {
    const target = path.resolve(runtimeTarget);
    if (existsSync(target)) throw new Error("recovery_runtime_target_exists");
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(path.join(path.resolve(backupDirectory), manifest.runtime.file), target);
    chmodSync(target, 0o600);
    validateRuntimeStore(target);
  }
  return { targetFingerprint: config.fingerprint, manifest };
}

function databaseUrlFor(config, database) {
  const url = new URL("postgres://localhost/");
  url.hostname = config.env.PGHOST;
  url.port = config.env.PGPORT;
  url.username = config.env.PGUSER;
  url.password = config.env.PGPASSWORD;
  url.pathname = `/${database}`;
  if (config.env.PGSSLMODE) url.searchParams.set("sslmode", config.env.PGSSLMODE);
  return url.toString();
}

function createDatabase(admin, database) {
  run("createdb", ["--maintenance-db", admin.database, database], { env: admin.env });
}

function dropDatabase(admin, database) {
  run("dropdb", ["--maintenance-db", admin.database, "--if-exists", "--force", database], {
    env: admin.env,
    tolerateFailure: true,
  });
}

function migrate(databaseUrl) {
  const output = run(process.execPath, ["scripts/migrate-db.mjs"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      TASKNODE_DATABASE_ENABLED: "true",
      TASKNODE_POSTGRES_DISABLED: "false",
      TASKNODE_DATABASE_DISABLED: "false",
    },
    capture: true,
  });
  return JSON.parse(output);
}

export function drill(adminUrl) {
  const admin = databaseConfig(adminUrl);
  const suffix = randomBytes(6).toString("hex");
  const sourceName = `${safeDatabasePrefix}source_${suffix}`;
  const restoredName = `${safeDatabasePrefix}restored_${suffix}`;
  const work = mkdtempSync(path.join(tmpdir(), "tasknode-recovery-drill-"));
  const backupDirectory = path.join(work, "backup");
  const runtimeSource = path.join(work, "runtime-source.json");
  const runtimeRestored = path.join(work, "restored", "runtime-store.json");
  const sourceUrl = databaseUrlFor(admin, sourceName);
  const restoredUrl = databaseUrlFor(admin, restoredName);
  let sourceCreated = false;
  let restoredCreated = false;
  try {
    createDatabase(admin, sourceName);
    sourceCreated = true;
    const initialMigration = migrate(sourceUrl);
    if (!Array.isArray(initialMigration.applied) || initialMigration.applied.length < 100) {
      throw new Error("recovery_drill_migrations_incomplete");
    }
    const source = databaseConfig(sourceUrl);
    query(source, `
      INSERT INTO chat_conversations (id, account_id, title) VALUES ('recovery_conversation', 'recovery_account', 'Recovery drill');
      INSERT INTO chat_messages (id, conversation_id, account_id, role, body) VALUES ('recovery_message', 'recovery_conversation', 'recovery_account', 'user', 'synthetic recovery sentinel');
    `);
    writeFileSync(runtimeSource, `${JSON.stringify({
      version: 1,
      conversations: { recovery_conversation: [{ id: "runtime_recovery_message", role: "user", body: "synthetic runtime sentinel" }] },
      sessions: { recovery_session: { accountId: "recovery_account", expiresAt: "2099-01-01T00:00:00.000Z" } },
    }, null, 2)}\n`, { mode: 0o600 });
    const created = backup({ databaseUrl: sourceUrl, runtimeStore: runtimeSource, outputDirectory: backupDirectory });
    verifyBackup(created.output);

    query(source, "DELETE FROM chat_messages WHERE id = 'recovery_message'; CREATE TABLE post_deploy_only (id integer PRIMARY KEY);");
    createDatabase(admin, restoredName);
    restoredCreated = true;
    restore({ databaseUrl: restoredUrl, backupDirectory, runtimeTarget: runtimeRestored });
    const restored = databaseConfig(restoredUrl);
    if (query(restored, "SELECT body FROM chat_messages WHERE id = 'recovery_message'") !== "synthetic recovery sentinel") {
      throw new Error("recovery_drill_database_sentinel_missing");
    }
    if (query(restored, "SELECT to_regclass('public.post_deploy_only') IS NULL") !== "t") {
      throw new Error("recovery_drill_rollback_boundary_failed");
    }
    if (validateRuntimeStore(runtimeRestored).sessions?.recovery_session?.accountId !== "recovery_account") {
      throw new Error("recovery_drill_runtime_sentinel_missing");
    }
    const idempotent = migrate(restoredUrl);
    if (!Array.isArray(idempotent.applied) || idempotent.applied.length !== 0) {
      throw new Error("recovery_drill_migrations_not_idempotent");
    }

    const failed = run("psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--command",
      "BEGIN; CREATE TABLE migration_failure_probe (id integer); INSERT INTO tasknode_schema_migrations(name) VALUES ('999_failure_probe.sql'); SELECT 1 / 0; COMMIT;"], {
      env: restored.env,
      capture: true,
      tolerateFailure: true,
    });
    if (failed !== null) throw new Error("recovery_drill_expected_migration_failure_missing");
    if (query(restored, "SELECT to_regclass('public.migration_failure_probe') IS NULL") !== "t"
      || query(restored, "SELECT count(*) FROM tasknode_schema_migrations WHERE name = '999_failure_probe.sql'") !== "0") {
      throw new Error("recovery_drill_migration_transaction_not_rolled_back");
    }
    return {
      ok: true,
      migrations: initialMigration.applied.length,
      postgresBackupBytes: created.manifest.postgres.bytes,
      runtimeBackupBytes: created.manifest.runtime.bytes,
      databaseRestore: "verified",
      runtimeRestore: "verified",
      migrationIdempotence: "verified",
      failedMigrationRollback: "verified",
      preMigrationBackupRollback: "verified",
    };
  } finally {
    if (restoredCreated) dropDatabase(admin, restoredName);
    if (sourceCreated) dropDatabase(admin, sourceName);
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const command = process.argv[2] || "";
  if (command === "backup") {
    const result = backup({
      databaseUrl: argument("--database-url", process.env.DATABASE_URL),
      runtimeStore: argument("--runtime-store", process.env.TASKNODE_STORE_PATH),
      outputDirectory: argument("--output"),
    });
    console.log(JSON.stringify({ ok: true, output: result.output, manifest: result.manifest }, null, 2));
  } else if (command === "restore") {
    const result = restore({
      databaseUrl: argument("--database-url", process.env.DATABASE_URL),
      backupDirectory: argument("--backup"),
      runtimeTarget: argument("--runtime-target"),
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else if (command === "drill") {
    console.log(JSON.stringify(drill(argument("--admin-url", process.env.TASKNODE_RECOVERY_ADMIN_URL)), null, 2));
  } else {
    console.error("Usage:\n  data-recovery.mjs backup --database-url <loopback-url> --runtime-store <file> --output <empty-dir>\n  data-recovery.mjs restore --database-url <loopback-tasknode_recovery_*-url> --backup <dir> [--runtime-target <new-file>]\n  data-recovery.mjs drill --admin-url <loopback-admin-url>");
    process.exitCode = 2;
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main();
