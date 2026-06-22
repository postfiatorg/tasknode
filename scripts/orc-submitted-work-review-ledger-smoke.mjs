import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const script = path.join(repoRoot, "scripts/orc-submitted-work-review-ledger.mjs");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "orc-submitted-work-ledger-"));
const ledgerPath = path.join(tempDir, "review-ledger.json");

await writeFile(ledgerPath, `${JSON.stringify({
  schema: "pf.orc.submitted_work_review_ledger.v1",
  records: [
    {
      id: "swrev_seed_verified",
      taskId: "task_seed_verified",
      reviewer: "grashnuk",
      reviewStatus: "verified",
      score: 91,
      reviewFlags: [],
      archiveAction: "archive_hot",
      timestamp: "2026-06-22T00:00:00.000Z",
      source: { cid: "QmSeedVerified", txHash: "ABC" },
      parserOutput: {
        taskGrade: "pass",
        rewardRecommendation: "eligible",
        flagIndicators: [],
        archivalInstructions: "archive_hot",
        reviewerNotes: "Seed verified record.",
      },
    },
  ],
}, null, 2)}\n`);

function runJson(args) {
  return JSON.parse(execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  }));
}

const added = runJson([
  "add",
  "--ledger",
  ledgerPath,
  "--task-id",
  "task_smoke_followup",
  "--reviewer",
  "@tasknodeorc",
  "--status",
  "self_attested",
  "--score",
  "66",
  "--archive-action",
  "hold",
  "--flag",
  "self_attested_evidence",
  "--flag",
  "needs_independent_review",
  "--task-grade",
  "partial",
  "--reward-recommendation",
  "manual_review",
  "--note",
  "Smoke record for review ledger CLI.",
  "--timestamp",
  "2026-06-22T00:05:00.000Z",
]);
assert.equal(added.ok, true);
assert.equal(added.inserted, true);
assert.equal(added.record.reviewer, "tasknodeorc");
assert.equal(added.record.reviewStatus, "self_attested");
assert.deepEqual(added.record.reviewFlags, ["self_attested_evidence", "needs_independent_review"]);

const byTask = runJson(["query", "--ledger", ledgerPath, "--task-id", "task_smoke_followup"]);
assert.equal(byTask.count, 1);
assert.equal(byTask.records[0].archiveAction, "hold");

const byReviewer = runJson(["query", "--ledger", ledgerPath, "--reviewer", "grashnuk"]);
assert.equal(byReviewer.count, 1);
assert.equal(byReviewer.records[0].taskId, "task_seed_verified");

const flagged = runJson(["list", "--ledger", ledgerPath, "--flag", "needs_independent_review"]);
assert.equal(flagged.count, 1);
assert.equal(flagged.records[0].taskId, "task_smoke_followup");

const report = runJson(["report", "--ledger", ledgerPath]);
assert.equal(report.totalRecords, 2);
assert.equal(report.byStatus.verified, 1);
assert.equal(report.byStatus.self_attested, 1);
assert.equal(report.flagCounts.needs_independent_review, 1);
assert.equal(report.archiveActions.archive_hot, 1);
assert.equal(report.archiveActions.hold, 1);

const persisted = JSON.parse(await readFile(ledgerPath, "utf8"));
assert.equal(persisted.schema, "pf.orc.submitted_work_review_ledger.v1");
assert.equal(persisted.records.length, 2);

console.log("orc-submitted-work-review-ledger-smoke ok");
