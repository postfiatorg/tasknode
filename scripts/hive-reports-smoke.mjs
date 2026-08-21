#!/usr/bin/env node

import assert from "node:assert/strict";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import {
  buildHiveReportSourcePacket,
  getHiveReport,
  hiveReportTypeIds,
  listHiveReports,
  saveHiveReport,
} from "../server/repositories/hive-reports.js";
import {
  requestHiveReportRerun,
  runHiveReportsWorkerOnce,
  waitForHiveReportRerunForTests,
} from "../server/hive-reports-worker.js";

process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK = "true";

function assertMarkdown(body = "") {
  assert.ok(body.trim().startsWith("#"), "report body starts with a Markdown heading");
  assert.notEqual(body.trimStart().slice(0, 1), "{", "report body is not a JSON object");
  assert.notEqual(body.trimStart().slice(0, 1), "[", "report body is not a JSON array");
}

const cleanupIds = [];

try {
  await migrateDatabase({ force: true });
  const intelligenceSource = await buildHiveReportSourcePacket({
    type: "hive_intelligence",
    now: new Date("2026-06-25T12:00:00.000Z"),
  });
  assert.equal(
    intelligenceSource.taskRoutingConstraints?.schema,
    "pf.task_node.hive_intelligence_task_routing_constraints.v1",
    "intelligence report source includes deterministic task routing constraints"
  );
  assert.ok(
    intelligenceSource.taskRoutingConstraints.rulePromptFiles.includes("prompts/hive/reports/hive_intelligence_v1.md"),
    "task routing constraints reference the prompt file that tells the report to obey required badges"
  );
  const planningSource = await buildHiveReportSourcePacket({
    type: "board_manager_planning",
    now: new Date("2026-06-25T12:00:00.000Z"),
  });
  assert.equal(
    planningSource.schema,
    "pf.task_node.board_manager_planning_report_source_packet.v1",
    "board manager planning source has the expected schema"
  );
  assert.equal(
    planningSource.planningRules?.reasoningEffort,
    "high",
    "board manager planning source documents high thinking"
  );
  assert.ok(
    planningSource.planningRules?.promptFiles?.includes("prompts/hive/reports/board_manager_planning_v1.md"),
    "board manager planning source references prompt files instead of embedding prompt rules"
  );
  assert.ok(
    Array.isArray(planningSource.northStar?.executableActionVocabulary) &&
      planningSource.northStar.executableActionVocabulary.includes("ADD_BOARD") &&
      planningSource.northStar.executableActionVocabulary.includes("ARCHIVE_BOARD") &&
      planningSource.northStar.executableActionVocabulary.includes("UNARCHIVE_BOARD"),
    "board manager planning source limits executable action vocabulary"
  );
  const result = await runHiveReportsWorkerOnce({
    types: hiveReportTypeIds,
    force: true,
    now: new Date("2026-06-25T12:00:00.000Z"),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors || []));
  assert.equal(result.generated.length, hiveReportTypeIds.length, "all report types generated");

  const generatedIds = result.generated.map((item) => item.reportId).filter(Boolean);
  assert.equal(generatedIds.length, hiveReportTypeIds.length, "generated reports have ids");
  cleanupIds.push(...generatedIds);

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

  const planningGenerated = result.generated.find((item) => item.type === "board_manager_planning");
  const listed = await listHiveReports({ type: "board_manager_planning", limit: 12 });
  assert.equal(listed.ok, true, "report list succeeds");
  assert.ok(
    listed.reports.some((report) => report.id === planningGenerated?.reportId),
    "generated Board Manager Planning report appears in filtered list"
  );
  const manualRerun = requestHiveReportRerun({
    type: "board_manager_planning",
    requestedBy: "acct_oauth_3c70e69ab7b8ef1fad3df508",
    now: new Date("2026-06-25T14:00:00.000Z"),
  });
  assert.equal(manualRerun.ok, true, "manual report rerun queues");
  assert.equal(manualRerun.queued, true, "manual rerun starts a new generation");
  const duplicateRerun = requestHiveReportRerun({
    type: "board_manager_planning",
    requestedBy: "acct_oauth_3c70e69ab7b8ef1fad3df508",
    now: new Date("2026-06-25T14:00:01.000Z"),
  });
  assert.equal(duplicateRerun.ok, true, "duplicate manual rerun request is accepted as running");
  assert.equal(duplicateRerun.running, true, "duplicate manual rerun reports existing run");
  assert.equal(duplicateRerun.queued, false, "duplicate manual rerun does not queue a second generation");
  const manualResult = await waitForHiveReportRerunForTests("board_manager_planning");
  const manualReportId = manualResult?.report?.id || "";
  assert.ok(manualReportId, "manual rerun writes a fresh Board Manager Planning report");
  const manualDetail = await getHiveReport({ id: manualReportId });
  assert.equal(manualDetail.ok, true, "manual rerun report is readable");
  assert.equal(manualDetail.report.type, "board_manager_planning", "manual rerun persisted the requested type");
  cleanupIds.push(manualReportId);

  for (let index = 0; index < 8; index += 1) {
    const extra = await saveHiveReport({
      type: "rewarded_task",
      generatedAt: new Date(`2026-06-25T13:${String(index).padStart(2, "0")}:00.000Z`),
      bodyMarkdown: [`# Extra Rewarded Report ${index}`, "", "Rewarded report flood fixture."].join("\n"),
      sourceRunId: `hive_reports_smoke_extra_${index}`,
      model: "mock",
    });
    cleanupIds.push(extra.report.id);
  }
  const clipped = await listHiveReports({ limit: 2, includeLatestByType: true });
  assert.equal(clipped.ok, true, "latest-per-type report list succeeds");
  const clippedTypes = new Set(clipped.reports.map((report) => report.type));
  for (const type of hiveReportTypeIds) {
    assert.ok(clippedTypes.has(type), `latest ${type} report remains present when recent rows are clipped`);
  }

  console.log(`hive-reports-smoke ok: generated/read ${generatedIds.length} markdown reports`);
} finally {
  if (cleanupIds.length) {
    await query("DELETE FROM hive_reports WHERE id = ANY($1::text[])", [cleanupIds]).catch(() => null);
  }
  await closePool().catch(() => null);
}
