#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "orc-routing-suppression-enforcement-verifier.mjs");
const tempDir = await mkdtemp(path.join(tmpdir(), "orc-routing-suppression-verifier-"));

try {
  const configPath = path.join(tempDir, "suppression_config.json");
  const allocationsPath = path.join(tempDir, "allocations.json");
  const outDir = path.join(tempDir, "out");
  await writeFile(
    configPath,
    `${JSON.stringify({
      schema: "pf.orc.contributor_routing_suppression_config.v1",
      generatedAt: "2026-06-20T04:00:00.000Z",
      generatedBy: "grashnuk",
      mode: "recommend_only_no_enforcement",
      dryRunOnly: true,
      operationalUseAllowed: false,
      entries: [
        {
          contributorKey: "rActiveViolation",
          walletAddress: "rActiveViolation",
          handle: "active_violation",
          suppressionEffectiveAt: "2026-06-20T04:00:00.000Z",
          expiresAt: "2026-06-21T04:00:00.000Z",
        },
        {
          contributorKey: "rExpired",
          walletAddress: "rExpired",
          handle: "expired_only",
          suppressionEffectiveAt: "2026-06-19T04:00:00.000Z",
          expiresAt: "2026-06-20T03:00:00.000Z",
        },
        {
          contributorKey: "rBlocked",
          walletAddress: "rBlocked",
          handle: "blocked_ok",
          suppressionEffectiveAt: "2026-06-20T04:00:00.000Z",
        },
      ],
    }, null, 2)}\n`
  );
  await writeFile(
    allocationsPath,
    `${JSON.stringify({
      schema: "pf.orc.routing_suppression_allocation_sample.v1",
      generatedAt: "2026-06-20T05:00:00.000Z",
      allocations: [
        {
          allocationId: "alloc_active",
          taskId: "task_active",
          walletAddress: "rActiveViolation",
          handle: "active_violation",
          status: "proposed",
          allocatedAt: "2026-06-20T04:15:00.000Z",
        },
        {
          allocationId: "alloc_expired_after_window",
          taskId: "task_expired_after_window",
          walletAddress: "rExpired",
          handle: "expired_only",
          status: "proposed",
          allocatedAt: "2026-06-20T04:30:00.000Z",
        },
        {
          allocationId: "alloc_blocked",
          taskId: "task_blocked",
          walletAddress: "rBlocked",
          handle: "blocked_ok",
          status: "suppressed",
          allocatedAt: "2026-06-20T04:45:00.000Z",
        },
      ],
    }, null, 2)}\n`
  );

  const result = spawnSync(process.execPath, [
    scriptPath,
    "batch",
    "--config",
    configPath,
    "--allocations",
    allocationsPath,
    "--out",
    outDir,
    "--generated-by",
    "grashnuk",
    "--generated-at",
    "2026-06-20T05:00:00.000Z",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.ok, true);
  assert.equal(stdout.summary.violated, 1);
  assert.equal(stdout.summary.expired, 1);
  assert.equal(stdout.summary.enforced, 1);

  const report = JSON.parse(await readFile(path.join(outDir, "verification_report.json"), "utf8"));
  const byHandle = Object.fromEntries(report.contributors.map((entry) => [entry.handle, entry]));
  assert.equal(byHandle.active_violation.status, "violated");
  assert.equal(byHandle.expired_only.status, "expired");
  assert.equal(byHandle.expired_only.allocationCounts.postExpiry, 1);
  assert.equal(byHandle.expired_only.activePostSuppressionAllocations.length, 0);
  assert.equal(byHandle.blocked_ok.status, "enforced");
  assert.equal(report.wouldBanAccounts, false);
  assert.equal(report.wouldMoveFunds, false);
  assert.equal(report.wouldMutateLiveRouting, false);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("orc-routing-suppression-enforcement-verifier-smoke ok");
