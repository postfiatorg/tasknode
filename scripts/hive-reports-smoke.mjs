#!/usr/bin/env node

import assert from "node:assert/strict";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import { getHiveReport, hiveReportTypeIds, listHiveReports } from "../server/repositories/hive-reports.js";
import { runHiveReportsWorkerOnce } from "../server/hive-reports-worker.js";

process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK = "true";

function assertMarkdown(body = "") {
  assert.ok(body.trim().startsWith("#"), "report body starts with a Markdown heading");
  assert.notEqual(body.trimStart().slice(0, 1), "{", "report body is not a JSON object");
  assert.notEqual(body.trimStart().slice(0, 1), "[", "report body is not a JSON array");
}

try {
  await migrateDatabase({ force: true });
  const result = await runHiveReportsWorkerOnce({
    types: hiveReportTypeIds,
    force: true,
    now: new Date("2026-06-25T12:00:00.000Z"),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors || []));
  assert.equal(result.generated.length, hiveReportTypeIds.length, "all report types generated");

  const generatedIds = result.generated.map((item) => item.reportId).filter(Boolean);
  assert.equal(generatedIds.length, hiveReportTypeIds.length, "generated reports have ids");

  for (const item of result.generated) {
    const detail = await getHiveReport({ id: item.reportId });
    assert.equal(detail.ok, true, `${item.type} detail is readable`);
    assert.equal(detail.report.type, item.type, `${item.type} persisted as the requested type`);
    assertMarkdown(detail.report.bodyMarkdown);
    const phases = detail.verifications.map((verification) => verification.phase);
    assert.ok(phases.includes("initial"), `${item.type} has initial phase`);
    assert.ok(phases.includes("final"), `${item.type} has final phase`);
    if (item.type === "kol" || item.type === "development") {
      assert.ok(phases.includes("agent_verify"), `${item.type} has verifier phase`);
    }
  }

  const listed = await listHiveReports({ limit: 12 });
  assert.equal(listed.ok, true, "report list succeeds");
  assert.ok(generatedIds.some((id) => listed.reports.some((report) => report.id === id)), "generated report appears in list");

  await query("DELETE FROM hive_reports WHERE id = ANY($1::text[])", [generatedIds]);
  console.log(`hive-reports-smoke ok: generated/read ${generatedIds.length} markdown reports`);
} finally {
  await closePool().catch(() => null);
}
