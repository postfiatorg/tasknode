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
  "docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59"
);
const outDir = await mkdtemp(path.join(os.tmpdir(), "orc-hive-delivery-repair-"));

const { stdout } = await execFileAsync(process.execPath, [
  path.join(repoRoot, "scripts/orc-hive-delivery-repair.mjs"),
  "repair",
  "--diagnostics",
  path.join(fixtureDir, "sample_before_delivery_log.json"),
  "--repair-fixture",
  path.join(fixtureDir, "sample_repair_fixture.json"),
  "--out",
  outDir,
  "--generated-by",
  "grashnuk",
  "--generated-at",
  "2026-06-20T00:00:00.000Z",
]);

const commandOutput = JSON.parse(stdout);
assert.equal(commandOutput.ok, true);
assert.equal(commandOutput.before.totalMessages, 5);
assert.equal(commandOutput.before.deliveredVerified, 1);
assert.equal(commandOutput.before.failed, 4);
assert.equal(commandOutput.after.totalMessages, 5);
assert.equal(commandOutput.after.deliveredVerified, 3);
assert.equal(commandOutput.after.failed, 2);
assert.equal(commandOutput.after.repaired, 2);

const report = JSON.parse(await readFile(path.join(outDir, "repair_report.json"), "utf8"));
const zoz = report.records.find((record) => record.target.handle === "zoz");
assert.equal(zoz.before.failureStage, "message_retrieval");
assert.equal(zoz.inspection.failingApiStep, "message_retrieval");
assert.equal(zoz.inspection.postHttpStatus, 201);
assert.equal(zoz.inspection.retrievalHttpStatus, 404);
assert.equal(zoz.repairStatus, "repaired");
assert.equal(zoz.repairMethod, "conversation_scan_fallback");
assert.equal(zoz.after.verification.ok, true);

const yuuki = report.records.find((record) => record.target.handle === "yuuki");
assert.equal(yuuki.repairStatus, "repaired");
assert.equal(yuuki.repairMethod, "idempotent_repost");
assert.equal(yuuki.idempotentRepost.attempts[0].idempotencyKey, "orc-delivery-repair-yuuki-001");
assert.equal(yuuki.after.verification.visible, true);

const donravle = report.records.find((record) => record.target.handle === "donravle");
assert.equal(donravle.repairStatus, "not_applicable");
assert.equal(donravle.after.failureStage, "message_post");

console.log("orc-hive-delivery-repair-smoke ok");
