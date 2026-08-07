import pg from "pg";

const { Pool } = pg;

const statementTimeoutMs = Math.max(500, Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 5000));
const connectionTimeoutMs = Math.max(500, Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 5000));

function processRole(env = process.env) {
  return String(env.TASKNODE_PROCESS_ROLE || env.FLY_PROCESS_GROUP || "all").trim().toLowerCase() || "all";
}

function defaultPoolMaxForRole(role = processRole()) {
  if (["web", "app", "api"].includes(role)) return 10;
  if (role === "board-manager") return 3;
  if (role === "worker:taskgen" || role === "worker:context-rewrite") return 4;
  if (role === "worker:pftl") return 4;
  if (role === "worker:task-review" || role === "worker:hive") return 3;
  if (role === "worker:memory-profile" || role === "worker:airdrop") return 2;
  return 6;
}

const poolRole = processRole();
const configuredPoolMax = process.env.DATABASE_POOL_MAX;
const maxConnections = Math.min(
  Math.max(Number(configuredPoolMax || defaultPoolMaxForRole(poolRole)), 1),
  30
);

let pool = null;
let lastError = "";

export function databaseUrl() {
  return String(process.env.DATABASE_URL || "").trim();
}

export function databaseEnabled() {
  if (process.env.TASKNODE_POSTGRES_DISABLED === "true") return false;
  if (process.env.TASKNODE_DATABASE_DISABLED === "true") return false;
  if (!databaseUrl()) return false;
  return (
    process.env.TASKNODE_DATABASE_ENABLED === "true" ||
    process.env.TASKNODE_POSTGRES_ENABLED === "true"
  );
}

export function databaseStatus() {
  return {
    configured: Boolean(databaseUrl()),
    enabled: databaseEnabled(),
    durable: databaseEnabled(),
    role: poolRole,
    poolMax: maxConnections,
    poolMaxSource: configuredPoolMax ? "DATABASE_POOL_MAX" : "role_default",
    lastError,
  };
}

export function getPool() {
  if (!databaseEnabled()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      max: maxConnections,
      connectionTimeoutMillis: connectionTimeoutMs,
      idleTimeoutMillis: Math.max(1000, Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30000)),
      query_timeout: statementTimeoutMs,
      application_name: `${process.env.TASKNODE_APP_NAME || "tasknodeofficial"}:${poolRole}`,
    });
    pool.on("error", (error) => {
      lastError = error?.message || "database_pool_error";
    });
  }
  return pool;
}

export function poolMetrics() {
  return {
    configured: Boolean(databaseUrl()),
    enabled: databaseEnabled(),
    role: poolRole,
    max: maxConnections,
    maxSource: configuredPoolMax ? "DATABASE_POOL_MAX" : "role_default",
    total: pool?.totalCount || 0,
    idle: pool?.idleCount || 0,
    waiting: pool?.waitingCount || 0,
    lastError,
  };
}

export async function query(text, params = []) {
  const db = getPool();
  if (!db) {
    const error = new Error("database_not_configured");
    error.code = "TASKNODE_DATABASE_NOT_CONFIGURED";
    throw error;
  }

  try {
    return await db.query(text, params);
  } catch (error) {
    lastError = error?.message || "database_query_failed";
    throw error;
  }
}

export async function withDatabaseClient(work) {
  const db = getPool();
  if (!db) {
    const error = new Error("database_not_configured");
    error.code = "TASKNODE_DATABASE_NOT_CONFIGURED";
    throw error;
  }

  const client = await db.connect();
  try {
    return await work(client);
  } catch (error) {
    lastError = error?.message || "database_query_failed";
    throw error;
  } finally {
    client.release();
  }
}

export async function transaction(work) {
  const db = getPool();
  if (!db) {
    const error = new Error("database_not_configured");
    error.code = "TASKNODE_DATABASE_NOT_CONFIGURED";
    throw error;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    lastError = error?.message || "database_transaction_failed";
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error) {
  return error?.code === "23505";
}

export async function closePool() {
  if (!pool) return;
  const active = pool;
  pool = null;
  await active.end();
}
