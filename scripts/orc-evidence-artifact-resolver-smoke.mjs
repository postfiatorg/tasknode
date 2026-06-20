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
const outDir = await mkdtemp(path.join(os.tmpdir(), "orc-evidence-artifact-resolver-"));
const scriptPath = path.join(repoRoot, "scripts/orc-evidence-artifact-resolver.mjs");

const artifactBase =
  "docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2";

const { stdout: helpOutput } = await execFileAsync(process.execPath, [scriptPath, "--help"]);
assert.match(helpOutput, /artifact resolution packet/);
assert.match(helpOutput, /--artifact/);

const { stdout } = await execFileAsync(process.execPath, [
  scriptPath,
  "resolve",
  "--pr-url",
  "https://github.com/postfiatorg/tasknodeofficial/pull/169",
  "--commit",
  "ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a",
  "--artifact",
  `${artifactBase}/outputs/status_dashboard.json`,
  "--artifact",
  `${artifactBase}/outputs/accounting_ledger.json`,
  "--artifact",
  "scripts/orc-submission-ingestion-tracker.mjs",
  "--out",
  outDir,
  "--repo-root",
  repoRoot,
  "--generated-at",
  "2026-06-20T10:30:00.000Z",
]);

await assert.rejects(
  execFileAsync(process.execPath, [
    scriptPath,
    "resolve",
    "--pr-url",
    "https://github.com/postfiatorg/tasknodeofficial/pull/169",
    "--commit",
    "ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a",
    "--artifact",
    "../package.json",
    "--out",
    outDir,
    "--repo-root",
    repoRoot,
  ]),
  (error) => /Artifact path must be a relative path inside the repository/.test(error.stderr)
);

const output = JSON.parse(stdout);
assert.equal(output.ok, true);
assert.equal(output.artifactCount, 3);
assert.equal(output.checklistPassed, output.checklistTotal);

const packet = JSON.parse(await readFile(path.join(outDir, "artifact_resolution_packet.json"), "utf8"));
assert.equal(packet.ok, true);
assert.equal(packet.publicLinks.prUrl, "https://github.com/postfiatorg/tasknodeofficial/pull/169");
assert.match(packet.publicLinks.commitUrl, /https:\/\/github\.com\/postfiatorg\/tasknodeofficial\/commit\/ba3b732/);
assert.equal(packet.artifacts.length, 3);
assert.ok(packet.artifacts.every((artifact) => artifact.localExists));
assert.ok(packet.artifacts.every((artifact) => artifact.committedExists));
assert.ok(packet.artifacts.every((artifact) => artifact.changedInCommit));
assert.ok(packet.artifacts.every((artifact) => artifact.blobUrl.includes("/blob/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a/")));
assert.ok(packet.artifacts.every((artifact) => artifact.rawUrl.includes("/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a/")));

const dashboardArtifact = packet.artifacts.find((artifact) => artifact.path.endsWith("status_dashboard.json"));
assert.equal(dashboardArtifact.excerpt.type, "json");
assert.equal(dashboardArtifact.excerpt.excerpt.summary.totalRecords, 10);
assert.equal(dashboardArtifact.excerpt.excerpt.summary.byState.accounted_for, 10);

const ledgerArtifact = packet.artifacts.find((artifact) => artifact.path.endsWith("accounting_ledger.json"));
assert.equal(ledgerArtifact.excerpt.excerpt.recordsCount, 10);
assert.equal(ledgerArtifact.excerpt.excerpt.firstRecord.state, "accounted_for");

const markdown = await readFile(path.join(outDir, "artifact_resolution_packet.md"), "utf8");
assert.match(markdown, /Artifact Checks/);
assert.match(markdown, /Blob URL:/);
assert.match(markdown, /Changed in commit: true/);
assert.match(markdown, /Reviewer Checklist/);

console.log("orc-evidence-artifact-resolver-smoke ok");
