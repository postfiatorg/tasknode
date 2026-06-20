#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "orc-sybil-enforcement-state-tracker.mjs");
const tempDir = await mkdtemp(path.join(tmpdir(), "orc-sybil-state-tracker-"));

function run(args, { expectOk = true } = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (expectOk) assert.equal(result.status, 0, result.stderr || result.stdout);
  else assert.notEqual(result.status, 0, "command should have failed");
  return result;
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

try {
  const riskPath = path.join(tempDir, "risk_matrix.json");
  const suppressionPath = path.join(tempDir, "suppression_config.json");
  const verifierPath = path.join(tempDir, "verifier_report.json");
  const outDir = path.join(tempDir, "out");

  await writeJson(riskPath, {
    schema: "tasknode.xrpl_sybil_risk_matrix.v1",
    generatedAt: "2026-06-20T06:00:00.000Z",
    riskMatrix: [
      {
        walletAddress: "rHighMissingSuppression",
        handle: "high_missing_suppression",
        riskBand: "high_review_priority",
        reviewPriorityScore: 81.25,
        reasons: ["duplicate documentation cadence", "reward concentration"],
        recommendation: "suspected-only review",
      },
      {
        walletAddress: "rSuppressedViolated",
        handle: "suppressed_violated",
        riskBand: "high_review_priority",
        reviewPriorityScore: 67,
        reasons: ["allocation after suppression window"],
      },
      {
        walletAddress: "rCleanWatch",
        handle: "clean_watch",
        riskBand: "watch",
        reviewPriorityScore: 21,
      },
    ],
  });

  await writeJson(suppressionPath, {
    schema: "pf.orc.contributor_routing_suppression_config.v1",
    generatedAt: "2026-06-20T06:05:00.000Z",
    mode: "recommend_only_no_enforcement",
    entries: [
      {
        walletAddress: "rSuppressedViolated",
        handle: "suppressed_violated",
        status: "routing_suppression_recommended",
        suppressionReason: "suspected duplicate-submission cluster",
        operationalUseAllowed: false,
        requiresHumanApproval: true,
        supportingTaskIds: ["task_suppression_basis"],
      },
    ],
  });

  await writeJson(verifierPath, {
    schema: "pf.orc.routing_suppression_enforcement_verification.v1",
    generatedAt: "2026-06-20T06:10:00.000Z",
    contributors: [
      {
        walletAddress: "rSuppressedViolated",
        handle: "suppressed_violated",
        status: "violated",
        finding: "Active post-suppression allocation observed in the sample.",
        allocationCounts: { activePostSuppression: 1 },
        activePostSuppressionAllocations: [{ taskId: "task_active_after_suppression" }],
      },
      {
        walletAddress: "rCleanWatch",
        handle: "clean_watch",
        status: "enforced",
        finding: "No post-suppression allocation detected.",
        allocationCounts: { activePostSuppression: 0 },
      },
    ],
  });

  const batch = run([
    "batch",
    "--risk-matrix",
    riskPath,
    "--suppression-config",
    suppressionPath,
    "--verifier-report",
    verifierPath,
    "--out",
    outDir,
    "--generated-by",
    "grashnuk",
    "--generated-at",
    "2026-06-20T06:20:00.000Z",
  ]);
  const batchOutput = JSON.parse(batch.stdout);
  assert.equal(batchOutput.ok, true);
  assert.equal(batchOutput.mode, "recommend_only_state_tracking");
  assert.equal(batchOutput.summary.walletCount, 3);
  assert.equal(batchOutput.summary.walletsWithDetectedGaps, 2);

  const statePath = path.join(outDir, "enforcement_state.json");
  const reportPath = path.join(outDir, "state_report.json");
  const summaryPath = path.join(outDir, "discord_summary.md");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const summary = await readFile(summaryPath, "utf8");

  assert.equal(state.readOnly, true);
  assert.equal(state.enforcementBoundary.wouldMutateLiveRouting, false);
  assert.equal(state.enforcementBoundary.wouldMoveFunds, false);
  assert.equal(state.enforcementBoundary.wouldBanAccounts, false);
  assert.equal(state.enforcementBoundary.wouldClawBackRewards, false);
  assert.equal(state.enforcementBoundary.wouldDeploy, false);
  assert.equal(state.enforcementBoundary.requiresHumanApprovalForAnyOperationalUse, true);
  assert.equal(report.readOnly, true);
  assert.match(summary, /human review only/);
  assert.match(summary, /No routing mutation, ban, blacklist, clawback, fund movement, signing, deployment, or live enforcement occurred\./);

  const byWallet = Object.fromEntries(state.records.map((record) => [record.walletAddress, record]));
  assert.deepEqual(byWallet.rHighMissingSuppression.detectedGaps, ["high_risk_missing_suppression_entry", "risk_score_above_threshold_without_suppression"]);
  assert.match(byWallet.rHighMissingSuppression.recommendedNextAction, /recommend-only routing review packet/);
  assert.deepEqual(byWallet.rSuppressedViolated.detectedGaps, ["post_suppression_active_allocation_detected"]);
  assert.match(byWallet.rSuppressedViolated.recommendedNextAction, /do not auto-enforce/);
  assert.deepEqual(byWallet.rCleanWatch.detectedGaps, []);
  assert.equal(byWallet.rCleanWatch.recommendedNextAction, "No action beyond continued monitoring.");

  const list = run(["list", "--state", statePath, "--gap-only"]);
  const listOutput = JSON.parse(list.stdout);
  assert.equal(listOutput.count, 2);
  assert.ok(listOutput.records.every((record) => record.detectedGaps.length > 0));

  const query = run(["query", "--state", statePath, "--wallet", "rSuppressedViolated"]);
  const queryOutput = JSON.parse(query.stdout);
  assert.equal(queryOutput.walletAddress, "rSuppressedViolated");
  assert.equal(queryOutput.verification.status, "violated");

  const addPath = path.join(tempDir, "state_after_add.json");
  const add = run([
    "add",
    "--state",
    statePath,
    "--wallet",
    "rManualReview",
    "--risk-score",
    "72",
    "--risk-band",
    "high_review_priority",
    "--gap",
    "risk_score_above_threshold_without_suppression",
    "--out",
    addPath,
    "--generated-at",
    "2026-06-20T06:25:00.000Z",
  ]);
  assert.equal(JSON.parse(add.stdout).summary.walletCount, 4);

  const updatePath = path.join(tempDir, "state_after_update.json");
  const update = run([
    "update",
    "--state",
    addPath,
    "--wallet",
    "rManualReview",
    "--verification-status",
    "not_tested",
    "--gap",
    "suppression_not_tested_by_allocation_sample",
    "--out",
    updatePath,
    "--generated-at",
    "2026-06-20T06:30:00.000Z",
  ]);
  assert.equal(JSON.parse(update.stdout).summary.walletCount, 4);
  const updated = JSON.parse(await readFile(updatePath, "utf8"));
  assert.equal(updated.records.find((record) => record.walletAddress === "rManualReview").verification.status, "not_tested");

  const badRiskPath = path.join(tempDir, "bad_risk_matrix.json");
  await writeJson(badRiskPath, { schema: "wrong", riskMatrix: [] });
  const bad = run([
    "generate",
    "--risk-matrix",
    badRiskPath,
    "--suppression-config",
    suppressionPath,
    "--verifier-report",
    verifierPath,
  ], { expectOk: false });
  assert.match(bad.stderr, /Risk matrix schema must be tasknode\.xrpl_sybil_risk_matrix\.v1/);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("orc-sybil-enforcement-state-tracker-smoke ok");
