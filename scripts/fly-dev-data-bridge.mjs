#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appName = process.env.TASKNODE_FLY_APP || "tasknodeofficial-dev";
const mpgClusterId = process.env.TASKNODE_FLY_MPG_CLUSTER_ID || "3x9jv02yd3dr6qp7";
const proxyPort = Number(process.env.TASKNODE_FLY_MPG_PROXY_PORT || 16432);
const proxyBindAddress = process.env.TASKNODE_FLY_MPG_PROXY_BIND || "0.0.0.0";
const envPath = path.resolve(".env.tasknodeofficial-fly-dev-data");
const localDbUrl = process.env.TASKNODE_LOCAL_DOCKER_DB_URL ||
  "postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/tasknodeofficial";
const dataTablesToExclude = [
  "public.jobs_corpus_chunks",
  "public.schema_migrations",
  "public.tasknode_schema_migrations",
];

function hasArg(name) {
  return process.argv.includes(name);
}

function requireFlyDevPushConfirmation() {
  if (appName !== "tasknodeofficial-dev") {
    throw new Error(
      `Refusing destructive data push to ${appName}. The Fly data bridge push command is only allowed for tasknodeofficial-dev.`
    );
  }
  if (
    process.env.TASKNODE_ALLOW_FLY_DEV_DATA_PUSH === "true" ||
    hasArg("--confirm-dev-push")
  ) {
    return;
  }
  throw new Error(
    "Refusing destructive Fly dev data push without confirmation. Re-run with TASKNODE_ALLOW_FLY_DEV_DATA_PUSH=true or --confirm-dev-push after verifying local data is the intended source of truth."
  );
}

function accessToken() {
  if (process.env.FLY_ACCESS_TOKEN) return process.env.FLY_ACCESS_TOKEN;
  const configPath = path.join(os.homedir(), ".fly", "config.yml");
  if (!existsSync(configPath)) throw new Error("FLY_ACCESS_TOKEN is missing and ~/.fly/config.yml was not found.");
  const match = readFileSync(configPath, "utf8").match(/^access_token:\s*(.+)$/m);
  if (!match) throw new Error("Could not read Fly access token from ~/.fly/config.yml.");
  return match[1].trim();
}

function run(command, args, { env = {}, input = null, stdio = "pipe" } = {}) {
  return execFileSync(command, args, {
    cwd: path.resolve("."),
    env: { ...process.env, FLY_ACCESS_TOKEN: accessToken(), ...env },
    input,
    encoding: input instanceof Buffer ? undefined : "utf8",
    stdio,
  });
}

function runText(command, args, options = {}) {
  return String(run(command, args, options));
}

function fly(args, options = {}) {
  return runText("fly", args, options);
}

function remoteDatabaseUrl() {
  const output = fly([
    "ssh",
    "console",
    "-a",
    appName,
    "-C",
    "node -e \"process.stdout.write(process.env.DATABASE_URL || '')\"",
  ]);
  const line = output.split(/\r?\n/).find((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"));
  if (!line) throw new Error(`Could not read DATABASE_URL from ${appName}.`);
  return line.trim();
}

function dockerGatewayHost() {
  if (process.env.TASKNODE_FLY_MPG_DOCKER_HOST) return process.env.TASKNODE_FLY_MPG_DOCKER_HOST;
  const inspected = spawnSync("docker", [
    "network",
    "inspect",
    "tasknodeofficial_default",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  const gateway = inspected.status === 0 ? inspected.stdout.trim() : "";
  return gateway || "host.docker.internal";
}

function proxyDatabaseUrl({ dockerHost = false } = {}) {
  const remote = new URL(remoteDatabaseUrl());
  remote.hostname = dockerHost
    ? (process.env.TASKNODE_FLY_DATA_NETWORK_MODE === "bridge" ? dockerGatewayHost() : "127.0.0.1")
    : "127.0.0.1";
  remote.port = String(proxyPort);
  return remote.toString();
}

function waitForPort({ host = "127.0.0.1", port = proxyPort, timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    }
    attempt();
  });
}

async function portIsOpen() {
  try {
    await waitForPort({ timeoutMs: 500 });
    return true;
  } catch {
    return false;
  }
}

async function startProxy({ daemon = false } = {}) {
  if (await portIsOpen()) return { started: false };
  const logPath = "/tmp/tasknodeofficial-fly-mpg-proxy.log";
  const out = daemon ? openSync(logPath, "a") : "inherit";
  const child = spawn("fly", [
    "mpg",
    "proxy",
    mpgClusterId,
    "--bind-addr",
    proxyBindAddress,
    "--local-port",
    String(proxyPort),
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, FLY_ACCESS_TOKEN: accessToken() },
    detached: daemon,
    stdio: daemon ? ["ignore", out, out] : "inherit",
  });
  if (daemon) child.unref();
  await waitForPort();
  return { started: true, pid: child.pid, logPath };
}

function writeEnvFile() {
  const dbUrl = proxyDatabaseUrl({ dockerHost: true });
  const body = [
    "# Generated by npm run fly-dev:data:env. This file is gitignored.",
    "# It makes local Docker use the Task Node Official Fly dev database through fly mpg proxy.",
    `TASKNODE_FLY_MPG_PROXY_BIND=${proxyBindAddress}`,
    "TASKNODE_FLY_DEV_DATA_BRIDGE=true",
    `TASKNODE_DATABASE_URL=${dbUrl}`,
    "",
  ].join("\n");
  writeFileSync(envPath, body, { mode: 0o600 });
  return envPath;
}

function dockerCompose(args, { stdio = "inherit" } = {}) {
  return spawnSync("docker", [
    "compose",
    "--env-file",
    ".env.tasknodeofficial-dev",
    "--env-file",
    envPath,
    "-f",
    "docker-compose.dev.yml",
    "-f",
    "docker-compose.fly-data.yml",
    ...args,
  ], {
    cwd: path.resolve("."),
    env: process.env,
    stdio,
  });
}

function dockerComposeLocal(args, { stdio = "inherit" } = {}) {
  return spawnSync("docker", [
    "compose",
    "-f",
    "docker-compose.dev.yml",
    ...args,
  ], {
    cwd: path.resolve("."),
    env: process.env,
    stdio,
  });
}

function psql(dbUrl, sql) {
  return runText("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-Atc", sql], {
    env: { PGPASSWORD: "" },
  });
}

function tableCounts(dbUrl) {
  const sql = [
    "SELECT 'chat_messages', COUNT(*) FROM chat_messages",
    "UNION ALL SELECT 'chat_conversations', COUNT(*) FROM chat_conversations",
    "UNION ALL SELECT 'context_documents', COUNT(*) FROM context_documents",
    "UNION ALL SELECT 'chat_memory_entries', COUNT(*) FROM chat_memory_entries",
    "UNION ALL SELECT 'task_projections', COUNT(*) FROM task_projections",
    "UNION ALL SELECT 'pftl_task_pointer_events', COUNT(*) FROM pftl_task_pointer_events",
  ].join(" ");
  return psql(dbUrl, sql).trim();
}

function dumpData(sourceDbUrl, targetFile) {
  const args = [
    "--data-only",
    "--no-owner",
    "--no-privileges",
    ...dataTablesToExclude.flatMap((table) => [`--exclude-table=${table}`]),
    "--file",
    targetFile,
    sourceDbUrl,
  ];
  run("pg_dump", args, { stdio: "inherit" });
}

function truncateReloadableTables(dbUrl) {
  const excluded = dataTablesToExclude
    .map((table) => table.split(".")[1])
    .map((table) => `'${table.replaceAll("'", "''")}'`)
    .join(",");
  const sql = `
    SELECT 'TRUNCATE TABLE ' || string_agg(format('%I.%I', table_schema, table_name), ', ') || ' RESTART IDENTITY CASCADE;'
    FROM information_schema.tables
    WHERE table_schema='public'
      AND table_type='BASE TABLE'
      AND table_name NOT IN (${excluded});
  `;
  const truncateSql = psql(dbUrl, sql).trim();
  if (!truncateSql) throw new Error("No reloadable tables found.");
  run("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-c", truncateSql], { stdio: "inherit" });
}

function restoreData(dbUrl, file) {
  run("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", file], { stdio: "inherit" });
}

function backup(dbUrl, prefix) {
  const dir = path.join("/tmp", `tasknodeofficial-${prefix}-${new Date().toISOString().replace(/[:.]/g, "")}`);
  mkdirSync(dir, { recursive: true });
  run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", dbUrl, "--file", path.join(dir, `${prefix}.dump`)], {
    stdio: "inherit",
  });
  return dir;
}

function localRuntimeStore() {
  const result = spawnSync("docker", ["exec", "tasknodeofficial-api-1", "cat", "/data/runtime-store.json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout;
}

function flyRuntimeStore() {
  const output = fly([
    "ssh",
    "console",
    "-a",
    appName,
    "-C",
    "cat /data/runtime-store.json",
  ]);
  const jsonStart = output.indexOf("{");
  return jsonStart >= 0 ? output.slice(jsonStart) : "";
}

function writeLocalRuntimeStore(text) {
  if (!text.trim()) return false;
  const result = spawnSync("docker", ["exec", "-i", "tasknodeofficial-api-1", "sh", "-lc", "cat > /data/runtime-store.json && chmod 600 /data/runtime-store.json"], {
    input: text,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  return result.status === 0;
}

function runtimeSummary(text) {
  try {
    const parsed = JSON.parse(text);
    return {
      accounts: Object.keys(parsed.accounts || {}).length,
      sessions: Object.keys(parsed.sessions || {}).length,
      accountWallets: Object.keys(parsed.accountWallets || {}).length,
      accountIdentities: Object.keys(parsed.accountIdentities || {}).length,
    };
  } catch {
    return null;
  }
}

async function status() {
  await startProxy({ daemon: true });
  const flyDb = proxyDatabaseUrl();
  console.log("fly_db_counts");
  console.log(tableCounts(flyDb));
  console.log("local_db_counts");
  console.log(tableCounts(localDbUrl));
  console.log("fly_runtime_store");
  console.log(JSON.stringify(runtimeSummary(flyRuntimeStore()), null, 2));
  console.log("local_runtime_store");
  console.log(JSON.stringify(runtimeSummary(localRuntimeStore()), null, 2));
}

async function pull() {
  await startProxy({ daemon: true });
  const flyDb = proxyDatabaseUrl();
  dockerComposeLocal(["stop", "api", "board-manager"], { stdio: "inherit" });
  const backupDir = backup(localDbUrl, "local-before-fly-pull");
  const sqlFile = path.join(backupDir, "fly-data.sql");
  dumpData(flyDb, sqlFile);
  truncateReloadableTables(localDbUrl);
  restoreData(localDbUrl, sqlFile);
  const existingRuntime = localRuntimeStore();
  if (existingRuntime.trim()) {
    writeFileSync(path.join(backupDir, "local-runtime-store-before.json"), existingRuntime, { mode: 0o600 });
  }
  const remoteRuntime = flyRuntimeStore();
  if (remoteRuntime.trim()) {
    writeFileSync(path.join(backupDir, "fly-runtime-store.json"), remoteRuntime, { mode: 0o600 });
  }
  const runtimeCopied = writeLocalRuntimeStore(remoteRuntime);
  console.log(`pulled_fly_dev_data backup_dir=${backupDir} runtime_store_copied=${runtimeCopied}`);
  console.log(tableCounts(localDbUrl));
}

async function push() {
  requireFlyDevPushConfirmation();
  await startProxy({ daemon: true });
  const flyDb = proxyDatabaseUrl();
  const backupDir = backup(flyDb, "fly-before-local-push");
  const sqlFile = path.join(backupDir, "local-data.sql");
  dumpData(localDbUrl, sqlFile);
  truncateReloadableTables(flyDb);
  restoreData(flyDb, sqlFile);
  console.log(`pushed_local_docker_data backup_dir=${backupDir}`);
  console.log(tableCounts(flyDb));
}

async function dockerUp() {
  await startProxy({ daemon: true });
  writeEnvFile();
  const result = dockerCompose(["up", "--build"], { stdio: "inherit" });
  process.exitCode = result.status || 0;
}

async function main() {
  const command = process.argv[2] || "status";
  if (command === "proxy") {
    await startProxy({ daemon: false });
    return;
  }
  if (command === "env") {
    await startProxy({ daemon: true });
    console.log(`wrote ${writeEnvFile()}`);
    return;
  }
  if (command === "status") return status();
  if (command === "pull") return pull();
  if (command === "push") return push();
  if (command === "docker-up") return dockerUp();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
