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
const tempDir = await mkdtemp(path.join(os.tmpdir(), "orc-routing-artifacts-"));
const generatedAt = "2026-06-20T00:00:00.000Z";

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function runScript(script, args) {
  const { stdout } = await execFileAsync(process.execPath, [path.join(repoRoot, "scripts", script), ...args], {
    cwd: repoRoot,
  });
  return JSON.parse(stdout);
}

const ledgerPath = path.join(tempDir, "review-ledger.json");
await writeJson(ledgerPath, {
  schema: "pf.orc.submitted_work_review_ledger.v1",
  records: [
    {
      id: "orcrev_good_1",
      taskId: "task_good_1",
      walletAddress: "rGoodContributor111111111111111111111",
      accountId: "acct_good",
      contributor: { handle: "steadybuilder" },
      reviewStatus: "verified",
      timestamp: "2026-06-19T12:00:00.000Z",
      score: 92,
    },
    {
      id: "orcrev_good_2",
      taskId: "task_good_2",
      walletAddress: "rGoodContributor111111111111111111111",
      accountId: "acct_good",
      contributor: { handle: "steadybuilder" },
      reviewStatus: "verified",
      timestamp: "2026-06-19T13:00:00.000Z",
      score: 95,
    },
    {
      id: "orcrev_risky_1",
      taskId: "task_risky_1",
      walletAddress: "rRiskyContributor2222222222222222222",
      accountId: "acct_risky",
      contributor: { handle: "thinworker" },
      reviewStatus: "unverifiable",
      timestamp: "2026-06-19T14:00:00.000Z",
      parserOutput: { flagIndicators: ["missing_external_proof"] },
    },
    {
      id: "orcrev_risky_2",
      taskId: "task_risky_2",
      walletAddress: "rRiskyContributor2222222222222222222",
      accountId: "acct_risky",
      contributor: { handle: "thinworker" },
      reviewStatus: "unverifiable",
      timestamp: "2026-06-19T15:00:00.000Z",
      parserOutput: { flagIndicators: ["self_attested_only"] },
    },
    {
      id: "orcrev_risky_3",
      taskId: "task_risky_3",
      walletAddress: "rRiskyContributor2222222222222222222",
      accountId: "acct_risky",
      contributor: { handle: "thinworker" },
      reviewStatus: "unverifiable",
      timestamp: "2026-06-19T16:00:00.000Z",
    },
    {
      id: "orcrev_risky_4",
      taskId: "task_risky_4",
      walletAddress: "rRiskyContributor2222222222222222222",
      accountId: "acct_risky",
      contributor: { handle: "thinworker" },
      reviewStatus: "refused",
      timestamp: "2026-06-19T17:00:00.000Z",
    },
    {
      id: "orcrev_risky_5",
      taskId: "task_risky_5",
      walletAddress: "rRiskyContributor2222222222222222222",
      accountId: "acct_risky",
      contributor: { handle: "thinworker" },
      reviewStatus: "refused",
      timestamp: "2026-06-19T18:00:00.000Z",
    },
    {
      id: "orcrev_rotating_1",
      taskId: "task_rotating_wallet_1",
      walletAddress: "rRotatingContributor333333333333333A",
      accountId: "acct_rotating",
      contributor: { handle: "rotatingwallet" },
      reviewStatus: "unverifiable",
      timestamp: "2026-06-19T10:00:00.000Z",
    },
    {
      id: "orcrev_rotating_2",
      taskId: "task_rotating_wallet_2",
      walletAddress: "rRotatingContributor333333333333333B",
      accountId: "acct_rotating",
      contributor: { handle: "rotatingwallet" },
      reviewStatus: "unverifiable",
      timestamp: "2026-06-19T11:00:00.000Z",
    },
    {
      id: "orcrev_rotating_3",
      taskId: "task_rotating_wallet_3",
      walletAddress: "rRotatingContributor333333333333333C",
      accountId: "acct_rotating",
      contributor: { handle: "rotatingwallet" },
      reviewStatus: "unverifiable",
      timestamp: "2026-06-19T12:00:00.000Z",
    },
  ],
});

const reportDir = path.join(tempDir, "report");
const reportOutput = await runScript("orc-contributor-quality-routing-report.mjs", [
  "batch",
  "--ledger",
  ledgerPath,
  "--out",
  reportDir,
  "--generated-at",
  generatedAt,
]);
assert.equal(reportOutput.ok, true);
assert.equal(reportOutput.schema, "pf.orc.contributor_quality_routing_report.v1");
assert.equal(reportOutput.enforcementMode, "recommend_only_no_enforcement");
assert.equal(reportOutput.summary.flaggedForRoutingReview, 2);

const report = await readJson(path.join(reportDir, "quality_routing_report.json"));
assert.equal(report.schema, "pf.orc.contributor_quality_routing_report.v1");
assert.equal(report.enforcementMode, "recommend_only_no_enforcement");
assert.match(report.note, /does not execute pauses, bans, blocklists, clawbacks, or payment actions/);
assert.equal(report.flaggedContributors.length, 2);
const riskyContributor = report.flaggedContributors.find((contributor) => contributor.accountId === "acct_risky");
assert.equal(riskyContributor.walletAddress, "rRiskyContributor2222222222222222222");
assert.deepEqual(
  riskyContributor.violations.map((violation) => violation.rule).sort(),
  [
    "consecutive_unverifiable_submissions",
    "low_verified_to_total_ratio",
    "recent_refusals",
    "repeated_unverifiable_submissions",
  ]
);
const rotatingContributor = report.flaggedContributors.find((contributor) => contributor.accountId === "acct_rotating");
assert.equal(rotatingContributor.contributorKey, "acct_rotating");
assert.deepEqual(rotatingContributor.walletAddresses, [
  "rRotatingContributor333333333333333A",
  "rRotatingContributor333333333333333B",
  "rRotatingContributor333333333333333C",
]);
assert.equal(rotatingContributor.violations.some((violation) => violation.rule === "repeated_unverifiable_submissions"), true);

const existingConfigPath = path.join(tempDir, "existing-suppression-config.json");
await writeJson(existingConfigPath, {
  schema: "pf.orc.contributor_routing_suppression_config.v1",
  generatedAt: "2026-06-19T00:00:00.000Z",
  entries: [],
});

const suppressionDir = path.join(tempDir, "suppression");
const suppressionOutput = await runScript("orc-contributor-routing-suppression-config.mjs", [
  "batch",
  "--report",
  path.join(reportDir, "quality_routing_report.json"),
  "--existing-config",
  existingConfigPath,
  "--out",
  suppressionDir,
  "--generated-at",
  generatedAt,
]);
assert.equal(suppressionOutput.ok, true);
assert.equal(suppressionOutput.schema, "pf.orc.contributor_routing_suppression_config.v1");
assert.equal(suppressionOutput.mode, "recommend_only_no_enforcement");
assert.equal(suppressionOutput.summary.suppressionEntryCount, 2);

const suppressionConfig = await readJson(path.join(suppressionDir, "suppression_config.json"));
assert.equal(suppressionConfig.dryRunOnly, true);
assert.equal(suppressionConfig.operationalUseAllowed, false);
assert.match(suppressionConfig.note, /does not execute bans, blocklists, clawbacks, payment actions, or deploys/);
assert.equal(suppressionConfig.entries[0].requiresHumanApproval, true);
assert.equal(suppressionConfig.entries[0].operationalUseAllowed, false);
const rotatingSuppression = suppressionConfig.entries.find((entry) => entry.accountId === "acct_rotating");
assert.equal(rotatingSuppression.contributorKey, "acct_rotating");
assert.deepEqual(rotatingSuppression.walletAddresses, [
  "rRotatingContributor333333333333333A",
  "rRotatingContributor333333333333333B",
  "rRotatingContributor333333333333333C",
]);

const dryRun = await readJson(path.join(suppressionDir, "dry_run_output.json"));
assert.equal(dryRun.wouldMutateLiveRouting, false);
assert.equal(dryRun.proposedSuppressionCount, 2);
assert.match(dryRun.warnings.join("\n"), /No bans, clawbacks, fund movement, signing, deployment, or task-routing mutation occurred/);

const riskMatrixPath = path.join(tempDir, "risk-matrix.json");
await writeJson(riskMatrixPath, {
  schema: "tasknode.xrpl_sybil_risk_matrix.v1",
  generatedAt,
  riskMatrix: [
    {
      wallet: "rRiskyContributor2222222222222222222",
      riskBand: "high",
      role: "review_target",
      compositeScore: 82,
      reviewPriorityScore: 88,
      recommendation: "review raw transactions and identity before routing changes",
      reasons: ["duplicate cadence", "thin evidence"],
      componentScores: {
        duplicateCadence: { score: 90, source: "fixture", weight: 0.5 },
      },
      supportingTaskIds: ["task_risky_1", "task_risky_2"],
    },
    {
      wallet: "rBelowThreshold333333333333333333333",
      riskBand: "watch",
      role: "review_target",
      compositeScore: 20,
      reviewPriorityScore: 25,
      reasons: ["weak signal only"],
    },
  ],
});

const integratedDir = path.join(tempDir, "integrated");
const integratedOutput = await runScript("orc-sybil-risk-routing-suppression-integrator.mjs", [
  "batch",
  "--risk-matrix",
  riskMatrixPath,
  "--suppression-config",
  path.join(suppressionDir, "suppression_config.json"),
  "--out",
  integratedDir,
  "--generated-at",
  generatedAt,
  "--threshold",
  "60",
]);
assert.equal(integratedOutput.ok, true);
assert.equal(integratedOutput.schema, "pf.orc.sybil_risk_routing_suppression_batch.v1");
assert.equal(integratedOutput.mode, "recommend_only_no_enforcement");
assert.equal(integratedOutput.enforcementBoundary.readOnly, true);
assert.equal(integratedOutput.enforcementBoundary.wouldMutateLiveRouting, false);
assert.equal(integratedOutput.enforcementBoundary.wouldMoveFunds, false);
assert.equal(integratedOutput.enforcementBoundary.wouldBanAccounts, false);
assert.equal(integratedOutput.reconciliation.qualifyingRiskWallets, 1);
assert.equal(integratedOutput.reconciliation.belowThresholdWallets, 1);

const enhancedConfig = await readJson(path.join(integratedDir, "enhanced_suppression_config.json"));
assert.equal(enhancedConfig.operationalUseAllowed, false);
assert.equal(enhancedConfig.enforcementBoundary.wouldDeploy, false);
assert.equal(enhancedConfig.entries.length, 2);
const enhancedRisky = enhancedConfig.entries.find((entry) => entry.walletAddress === "rRiskyContributor2222222222222222222");
assert.equal(enhancedRisky.sybilRisk.selectedScore, 88);
assert.equal(enhancedRisky.requiresHumanApproval, true);
assert.equal(enhancedRisky.operationalUseAllowed, false);
const enhancedRotating = enhancedConfig.entries.find((entry) => entry.accountId === "acct_rotating");
assert.equal(enhancedRotating.sybilRisk, undefined);
assert.equal(enhancedRotating.requiresHumanApproval, true);
assert.equal(enhancedRotating.operationalUseAllowed, false);

const reconciliation = await readJson(path.join(integratedDir, "reconciliation_report.json"));
assert.equal(reconciliation.schema, "pf.orc.sybil_risk_routing_suppression_reconciliation.v1");
assert.match(reconciliation.warnings.join("\n"), /No live routing mutation occurred/);

console.log("orc contributor routing artifacts smoke ok");
