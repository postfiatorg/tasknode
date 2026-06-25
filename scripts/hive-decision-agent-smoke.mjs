#!/usr/bin/env node

import assert from "node:assert/strict";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import { getHiveDecisionRun } from "../server/repositories/hive-decision-agent.js";
import { runHiveReportsWorkerOnce } from "../server/hive-reports-worker.js";
import { runHiveDecisionAgentOnce } from "../server/hive-decision-agent-worker.js";

process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK = "true";
process.env.TASKNODE_HIVE_DECISION_AGENT_PROVIDER_MOCK = "true";

try {
  await migrateDatabase({ force: true });
  const reports = await runHiveReportsWorkerOnce({
    force: true,
    now: new Date("2026-06-25T13:00:00.000Z"),
  });
  assert.equal(reports.ok, true, JSON.stringify(reports.errors || []));
  assert.equal(reports.generated.length, 6, "all report types available");

  const decision = await runHiveDecisionAgentOnce({
    trigger: "smoke_shadow_tick",
    now: new Date("2026-06-25T13:05:00.000Z"),
  });
  assert.equal(decision.ok, true, JSON.stringify(decision));
  assert.ok(decision.runId, "decision run id returned");

  const detail = await getHiveDecisionRun({ runId: decision.runId });
  assert.equal(detail.ok, true, "decision run detail loads");
  assert.equal(detail.run.shadow, true, "run is shadow");
  assert.equal(detail.run.status, "completed", "run completed");
  assert.ok(detail.run.reasoningText.length > 40, "explanation persisted");
  assert.ok(detail.run.optionsConsidered.length >= 1, "options considered persisted");
  assert.ok(detail.run.inputReportIds.length >= 6, "report ids captured");
  assert.equal(detail.run.result.executed, false, "no mutation executed");
  assert.equal(detail.run.sourcePacket.phase, "shadow", "source packet marks shadow mode");
  assert.equal(detail.run.sourcePacket.guardrails.structuralDedupRequired, true, "dedup guardrail in source");

  const reportIds = reports.generated.map((item) => item.reportId).filter(Boolean);
  await query("DELETE FROM hive_decision_runs WHERE id = $1", [decision.runId]);
  await query("DELETE FROM hive_reports WHERE id = ANY($1::text[])", [reportIds]);
  console.log(`hive-decision-agent-smoke ok: ${decision.runId}`);
} finally {
  await closePool().catch(() => null);
}
