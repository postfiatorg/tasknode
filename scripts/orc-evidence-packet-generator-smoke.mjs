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
  "docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910"
);
const outDir = await mkdtemp(path.join(os.tmpdir(), "orc-evidence-packet-generator-"));

const { stdout } = await execFileAsync(process.execPath, [
  path.join(repoRoot, "scripts/orc-evidence-packet-generator.mjs"),
  "generate",
  "--task-id",
  "task_914927149f7f301950b5457ef91d6d59",
  "--title",
  "Repair Hive Chat Delivery Failure Path",
  "--pr-url",
  "https://github.com/postfiatorg/tasknodeofficial/pull/162",
  "--commit",
  "8b00e39",
  "--artifact",
  "docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/sample_zoz_repair/repair_report.json",
  "--artifact",
  "docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/execution_summary.md",
  "--commands",
  path.join(fixtureDir, "fixture_commands.json"),
  "--json-excerpts",
  path.join(fixtureDir, "fixture_json_excerpts.json"),
  "--out",
  outDir,
  "--repo-root",
  repoRoot,
]);

const commandOutput = JSON.parse(stdout);
assert.equal(commandOutput.ok, true);
assert.equal(commandOutput.checklistPassed, commandOutput.checklistTotal);
assert.ok(commandOutput.changedFileCount >= 2);
assert.equal(commandOutput.artifactCount, 2);
assert.equal(commandOutput.commandCount, 3);
assert.equal(commandOutput.excerptCount, 2);

const markdown = await readFile(path.join(outDir, "evidence_packet.md"), "utf8");
assert.match(markdown, /https:\/\/github\.com\/postfiatorg\/tasknodeofficial\/pull\/162/);
assert.match(markdown, /https:\/\/github\.com\/postfiatorg\/tasknodeofficial\/commit\/8b00e39/);
assert.match(markdown, /scripts\/orc-hive-delivery-repair\.mjs/);
assert.match(markdown, /orc-hive-delivery-repair-smoke ok/);
assert.match(markdown, /direct_message_retrieval_read_path_missing_index_after_successful_post/);
assert.match(markdown, /Reviewer Checklist/);

const summary = JSON.parse(await readFile(path.join(outDir, "submission_summary.json"), "utf8"));
assert.equal(summary.ok, true);
assert.equal(summary.publicLinks.prUrl, "https://github.com/postfiatorg/tasknodeofficial/pull/162");
assert.ok(summary.reviewerChecklist.every((item) => item.ok));

console.log("orc-evidence-packet-generator-smoke ok");
