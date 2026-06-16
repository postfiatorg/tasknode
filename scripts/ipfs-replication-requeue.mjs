#!/usr/bin/env node
import { closePool, databaseEnabled, query, transaction } from "../server/db/pool.js";

const allowedStatuses = new Set(["exception_required", "failed"]);

function valueForFlag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  return String(process.argv[index + 1] || "").trim();
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function splitValues(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function usage() {
  console.log([
    "Usage:",
    "  node scripts/ipfs-replication-requeue.mjs [--status exception_required[,failed]] [--payload-class profile_nft_image] [--older-than-hours 1] [--execute]",
    "",
    "Defaults to dry-run. Mutates only with --execute.",
  ].join("\n"));
}

function statusesFromArgs() {
  const values = splitValues(valueForFlag("--status") || "exception_required");
  const statuses = values.filter((status) => allowedStatuses.has(status));
  if (statuses.length !== values.length || statuses.length === 0) {
    throw new Error(`--status must be one of: ${Array.from(allowedStatuses).join(", ")}`);
  }
  return Array.from(new Set(statuses));
}

function positiveNumber(value = "", fallback = 0) {
  if (value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("numeric flag must be a non-negative number");
  return parsed;
}

function whereClause({ statuses, payloadClass, olderThanHours }) {
  const params = [statuses];
  const clauses = ["status = ANY($1::text[])"];
  if (payloadClass) {
    params.push(payloadClass);
    clauses.push(`payload_class = $${params.length}`);
  }
  if (olderThanHours > 0) {
    params.push(String(olderThanHours));
    clauses.push(`updated_at < now() - ($${params.length}::text || ' hours')::interval`);
  }
  return {
    sql: clauses.join(" AND "),
    params,
  };
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage();
    return;
  }
  if (!databaseEnabled()) {
    throw new Error("database_not_configured: set DATABASE_URL and TASKNODE_DATABASE_ENABLED=true for the target environment");
  }

  const statuses = statusesFromArgs();
  const payloadClass = valueForFlag("--payload-class");
  const olderThanHours = positiveNumber(valueForFlag("--older-than-hours"), 0);
  const execute = hasFlag("--execute");
  const where = whereClause({ statuses, payloadClass, olderThanHours });
  const sample = await query(
    `
      SELECT id, cid, payload_class, source, source_ref, status, attempts, last_error, updated_at
      FROM ipfs_replication_jobs
      WHERE ${where.sql}
      ORDER BY updated_at ASC, id ASC
      LIMIT 20
    `,
    where.params
  );
  const count = await query(
    `
      SELECT count(*)::int AS count
      FROM ipfs_replication_jobs
      WHERE ${where.sql}
    `,
    where.params
  );
  const matchCount = Number(count.rows[0]?.count || 0);
  console.log(JSON.stringify({
    dryRun: !execute,
    matched: matchCount,
    statuses,
    payloadClass: payloadClass || null,
    olderThanHours: olderThanHours || null,
    sample: sample.rows,
  }, null, 2));

  if (!execute || matchCount === 0) return;

  const updated = await transaction(async (client) => {
    const result = await client.query(
      `
        UPDATE ipfs_replication_jobs
        SET status = 'queued',
            attempts = 0,
            next_attempt_at = now(),
            claimed_by = '',
            claimed_at = NULL,
            last_error = '',
            updated_at = now()
        WHERE ${where.sql}
        RETURNING id
      `,
      where.params
    );
    return result.rowCount || 0;
  });
  console.log(JSON.stringify({ dryRun: false, requeued: updated }, null, 2));
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
