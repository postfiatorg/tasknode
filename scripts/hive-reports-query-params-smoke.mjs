#!/usr/bin/env node

// DB-free: pg.Pool.prototype.query is stubbed, so this checks the exact
// LIMIT/OFFSET params listHiveReports sends without a Postgres connection.
import assert from "node:assert/strict";
import pg from "pg";
import { closePool } from "../server/db/pool.js";
import { listHiveReports } from "../server/repositories/hive-reports.js";

process.env.DATABASE_URL = "postgres://stub:stub@127.0.0.1:1/stub";
process.env.TASKNODE_DATABASE_ENABLED = "true";
delete process.env.TASKNODE_DATABASE_DISABLED;
delete process.env.TASKNODE_POSTGRES_DISABLED;

const calls = [];
let nextError = null;
pg.Pool.prototype.query = async function stubbedQuery(text, params) {
  calls.push(params);
  if (nextError) {
    const error = nextError;
    nextError = null;
    throw error;
  }
  return { rows: [] };
};

async function paramsFor(input) {
  calls.length = 0;
  const result = await listHiveReports(input);
  assert.equal(calls.length, 1, `${JSON.stringify(input)} runs one query`);
  return { params: calls[0], page: result.page, pageSize: result.pageSize };
}

try {
  // Integer inputs keep the exact params they had before truncation was added.
  assert.deepEqual(await paramsFor({}), { params: [21, 0], page: 1, pageSize: 20 });
  assert.deepEqual(await paramsFor({ page: "2", limit: "20" }), { params: [21, 20], page: 2, pageSize: 20 });
  assert.deepEqual(await paramsFor({ limit: "1" }), { params: [2, 0], page: 1, pageSize: 1 });
  assert.deepEqual(await paramsFor({ limit: "200" }), { params: [81, 0], page: 1, pageSize: 80 });
  assert.deepEqual(await paramsFor({ page: "1000" }), { params: [21, 19980], page: 1000, pageSize: 20 });
  assert.deepEqual(await paramsFor({ since: "2026-10-01T00:00:00Z" }), {
    params: ["2026-10-01T00:00:00Z", 21, 0],
    page: 1,
    pageSize: 20,
  });
  assert.deepEqual(await paramsFor({ since: "2026-10-01" }), { params: ["2026-10-01", 21, 0], page: 1, pageSize: 20 });

  // Fractions are truncated before the clamp; LIMIT/OFFSET are bigint.
  assert.deepEqual(await paramsFor({ limit: "2.5", page: "1.5" }), { params: [3, 0], page: 1, pageSize: 2 });
  assert.deepEqual(await paramsFor({ page: "1.5", limit: "20" }), { params: [21, 0], page: 1, pageSize: 20 });
  assert.deepEqual(await paramsFor({ limit: "0.5" }), { params: [2, 0], page: 1, pageSize: 1 });
  assert.deepEqual(await paramsFor({ limit: "abc", page: "NaN" }), { params: [21, 0], page: 1, pageSize: 20 });
  assert.deepEqual(await paramsFor({ limit: "1e1" }), { params: [11, 0], page: 1, pageSize: 10 });
  assert.deepEqual(await paramsFor({ limit: "9".repeat(400), page: "9".repeat(400) }), {
    params: [81, 79920],
    page: 1000,
    pageSize: 80,
  });

  // An unparseable since is a 400 before any query runs.
  for (const since of ["garbage", "2026-13-45", "now()"]) {
    calls.length = 0;
    await assert.rejects(listHiveReports({ since }), (error) => {
      assert.equal(error.status, 400, `${since} is a client error`);
      assert.equal(error.code, "hive_reports_since_invalid", `${since} has a stable code`);
      return true;
    });
    assert.equal(calls.length, 0, `${since} runs no query`);
  }

  // Postgres datetime errors on the since cast map to the same 400; other errors pass through.
  nextError = Object.assign(new Error("date/time field value out of range"), { code: "22008" });
  await assert.rejects(listHiveReports({ since: "2026-02-30" }), { status: 400, code: "hive_reports_since_invalid" });
  nextError = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  await assert.rejects(listHiveReports({ since: "2026-10-01" }), { code: "57014" });
  nextError = Object.assign(new Error("invalid input syntax"), { code: "22007" });
  await assert.rejects(listHiveReports({}), { code: "22007" });

  console.log("hive-reports-query-params-smoke ok");
} finally {
  await closePool().catch(() => null);
}
