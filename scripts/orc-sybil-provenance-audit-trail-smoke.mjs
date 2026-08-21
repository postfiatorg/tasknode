#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixtureDir = path.join(
  repoRoot,
  "docs/verification/sybil_provenance_audit_task_3acca09c782268d962c323fc09161c68/inputs"
);
const outDir = await mkdtemp(path.join(os.tmpdir(), "orc-sybil-provenance-audit-"));
const scriptPath = path.join(repoRoot, "scripts/orc-sybil-provenance-audit-trail.mjs");

const { stdout: helpOutput } = await execFileAsync(process.execPath, [scriptPath, "--help"]);
assert.match(helpOutput, /provenance audit/i);
assert.match(helpOutput, /--risk-matrix/);

const { stdout } = await execFileAsync(process.execPath, [
  scriptPath,
  "audit",
  "--risk-matrix",
  path.join(fixtureDir, "mock_risk_matrix.json"),
  "--suppression-config",
  path.join(fixtureDir, "mock_suppression_config.json"),
  "--enforcement-state",
  path.join(fixtureDir, "mock_enforcement_state.json"),
  "--out",
  outDir,
  "--generated-at",
  "2026-06-20T10:50:00.000Z",
  "--generated-by",
  "grashnuk",
]);
const output = JSON.parse(stdout);
assert.equal(output.ok, true);
assert.equal(output.walletCount, 10);
assert.ok(output.eventCount >= 24);
assert.equal(output.clearanceWallets, 2);
assert.equal(output.violationWallets, 1);
assert.ok(output.walletsNeedingHumanReview >= 4);

const report = JSON.parse(await readFile(path.join(outDir, "provenance_audit_report.json"), "utf8"));
assert.equal(report.schema, "pf.orc.sybil_enforcement_provenance_audit.v1");
assert.equal(report.readOnly, true);
assert.equal(report.operationalUseAllowed, false);
assert.equal(report.enforcementBoundary.wouldBanAccounts, false);
assert.equal(report.enforcementBoundary.wouldMoveFunds, false);
assert.equal(report.coverage.walletCount, 10);
assert.equal(report.coverage.riskRows, 10);
assert.equal(report.coverage.suppressionEntries, 7);
assert.equal(report.coverage.enforcementRecords, 8);
assert.ok(report.sourceFieldMap.riskMatrix.flagging.includes("riskMatrix[].reviewPriorityScore"));

const highWallet = report.timelines.find((timeline) => timeline.wallet === "rHighMissingSuppression333333333333");
assert.equal(highWallet.riskBand, "high_review_priority");
assert.match(highWallet.recommendedNextAction, /suppression review packet/);

const violatedWallet = report.timelines.find((timeline) => timeline.wallet === "rHighViolation2222222222222222222");
assert.equal(violatedWallet.verificationStatus, "violated");
assert.ok(violatedWallet.events.some((event) => event.type === "gap_detected"));
assert.match(violatedWallet.recommendedNextAction, /Escalate/);

const clearedWallet = report.timelines.find((timeline) => timeline.wallet === "rWatchCleared5555555555555555555");
assert.ok(clearedWallet.events.some((event) => event.type === "clearance"));
assert.equal(clearedWallet.velocityHours.flagToClearanceHours, 72);

const metrics = JSON.parse(await readFile(path.join(outDir, "provenance_metrics.json"), "utf8"));
assert.equal(metrics.summary.riskLevelCounts.high_review_priority, 4);
assert.equal(metrics.summary.riskLevelCounts.watch, 3);
assert.equal(metrics.summary.riskLevelCounts.low, 3);
assert.equal(metrics.summary.eventTypeCounts.flagging, 10);
assert.equal(metrics.summary.eventTypeCounts.suppression, 6);
assert.equal(metrics.summary.eventTypeCounts.clearance, 2);

const summary = await readFile(path.join(outDir, "discord_summary.md"), "utf8");
assert.match(summary, /Wallets audited: 10/);
assert.match(summary, /Safety: read-only, recommend-only/);

console.log("orc-sybil-provenance-audit-trail-smoke ok");
