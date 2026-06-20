#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/orc-submission-ingestion-tracker.mjs");
const fixturePath = path.join(
  repoRoot,
  "docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/mock_submissions.json"
);
const tempDir = await mkdtemp(path.join(os.tmpdir(), "orc-submission-ingestion-tracker-"));
const ledgerPath = path.join(tempDir, "working_ledger.json");
const outDir = path.join(tempDir, "outputs");

const { stdout: helpOutput } = await execFileAsync(process.execPath, [scriptPath, "--help"]);
assert.match(helpOutput, /catch-up/);
assert.match(helpOutput, /accounting_ledger\.json/);

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const initialRecords = fixture.submissions.slice(0, 2).map((submission, index) => ({
  schema: "pf.orc.submission_ingestion_accounting_ledger.v1",
  recordId: `seed_record_${index + 1}`,
  submissionId: submission.submissionId,
  taskId: submission.taskId,
  title: submission.title,
  project: submission.project,
  state: "accounted_for",
  previousState: "",
  createdAt: "2026-06-20T07:00:00.000Z",
  updatedAt: "2026-06-20T07:00:00.000Z",
  lastRunId: "seed_run",
  contributor: submission.contributor,
  evidence: submission.evidence,
  review: submission.review,
  accounting: {
    rewardPft: submission.rewardPft,
    accountedAt: "2026-06-20T07:00:00.000Z",
    ledgerRecordKey: `seed_acct_${index + 1}`,
    accountedBy: "grashnuk",
    outcome: submission.review.disposition,
  },
  stateHistory: [
    { state: "pending", at: "2026-06-20T07:00:00.000Z", reason: "seeded" },
    { state: "in_review", at: "2026-06-20T07:00:00.000Z", reason: "seeded" },
    { state: "reviewed", at: "2026-06-20T07:00:00.000Z", reason: "seeded" },
    { state: "accounted_for", at: "2026-06-20T07:00:00.000Z", reason: "seeded" },
  ],
  stages: {
    ingest: { status: "completed", startedAt: "2026-06-20T07:00:00.000Z", completedAt: "2026-06-20T07:00:00.000Z", details: {} },
    review: { status: "completed", startedAt: "2026-06-20T07:00:00.000Z", completedAt: "2026-06-20T07:00:00.000Z", details: {} },
    ledger: { status: "completed", startedAt: "2026-06-20T07:00:00.000Z", completedAt: "2026-06-20T07:00:00.000Z", details: {} },
    feedback: { status: "completed", startedAt: "2026-06-20T07:00:00.000Z", completedAt: "2026-06-20T07:00:00.000Z", details: {} },
    delivery: { status: "completed", startedAt: "2026-06-20T07:00:00.000Z", completedAt: "2026-06-20T07:00:00.000Z", details: {} },
    secretary_update: { status: "completed", startedAt: "2026-06-20T07:00:00.000Z", completedAt: "2026-06-20T07:00:00.000Z", details: {} },
  },
  feedbackPayload: { payloadId: `seed_feedback_${index + 1}` },
  secretaryUpdatePayload: { updateId: `seed_secretary_${index + 1}` },
}));
await writeFile(
  ledgerPath,
  `${JSON.stringify(
    {
      schema: "pf.orc.submission_ingestion_accounting_ledger.v1",
      createdAt: "2026-06-20T07:00:00.000Z",
      updatedAt: "2026-06-20T07:00:00.000Z",
      records: initialRecords,
      runs: [{ runId: "seed_run", command: "seed", processedCount: 2 }],
    },
    null,
    2
  )}\n`,
  "utf8"
);

const { stdout } = await execFileAsync(process.execPath, [
  scriptPath,
  "catch-up",
  "--submissions",
  fixturePath,
  "--ledger",
  ledgerPath,
  "--out",
  outDir,
  "--generated-by",
  "grashnuk",
  "--generated-at",
  "2026-06-20T07:30:00.000Z",
]);
const output = JSON.parse(stdout);
assert.equal(output.ok, true);
assert.equal(output.run.sourceSubmissionCount, 10);
assert.equal(output.run.processedCount, 8);
assert.equal(output.run.skippedTerminalCount, 2);
assert.equal(output.summary.totalRecords, 10);
assert.equal(output.summary.byState.accounted_for, 10);
assert.equal(output.summary.feedbackPayloadsReady, 10);
assert.equal(output.summary.secretaryUpdatesReady, 10);

const ledger = JSON.parse(await readFile(path.join(outDir, "accounting_ledger.json"), "utf8"));
assert.equal(ledger.records.length, 10);
assert.ok(ledger.records.every((record) => record.state === "accounted_for"));
assert.ok(ledger.records.every((record) => record.stages.secretary_update.status === "completed"));
assert.ok(ledger.records.every((record) => record.stateHistory.some((entry) => entry.state === "reviewed")));

const dashboard = JSON.parse(await readFile(path.join(outDir, "status_dashboard.json"), "utf8"));
assert.equal(dashboard.summary.stageCounts.secretary_update.completed, 10);
assert.equal(dashboard.summary.accountedRewardPft, 113000);

const feedback = JSON.parse(await readFile(path.join(outDir, "feedback_delivery_payloads.json"), "utf8"));
const secretary = JSON.parse(await readFile(path.join(outDir, "hive_secretary_context_updates.json"), "utf8"));
assert.equal(feedback.length, 10);
assert.equal(secretary.length, 10);
assert.ok(feedback.every((payload) => payload.safety?.deliveredLive === false || payload.payloadId.startsWith("seed_feedback_")));
assert.ok(secretary.some((payload) => payload.action?.required === true));

const summary = await readFile(path.join(outDir, "discord_summary.md"), "utf8");
assert.match(summary, /Submission ingestion accounting tracker run complete/);
assert.match(summary, /Records in ledger: 10/);

console.log("orc-submission-ingestion-tracker-smoke ok");
