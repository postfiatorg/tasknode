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
  "docs/verification/verified_orc_messaging_bridge_task_c6a991a7ef8956a53c3b593e93cbc2a1"
);

const outDir = await mkdtemp(path.join(os.tmpdir(), "orc-verified-messaging-bridge-"));
const { stdout } = await execFileAsync(process.execPath, [
  path.join(repoRoot, "scripts/orc-verified-messaging-bridge.mjs"),
  "deliver",
  "--messages",
  path.join(fixtureDir, "sample_messages.json"),
  "--contributors",
  path.join(fixtureDir, "sample_contributors.json"),
  "--out",
  outDir,
  "--mode",
  "mock",
  "--generated-by",
  "grashnuk",
  "--generated-at",
  "2026-06-20T00:00:00.000Z",
  "--diagnostic",
]);

const commandOutput = JSON.parse(stdout);
assert.equal(commandOutput.ok, true);
assert.equal(commandOutput.totalMessages, 5);
assert.equal(commandOutput.deliveredVerified, 2);
assert.equal(commandOutput.failed, 3);
assert.equal(commandOutput.retriedMessages, 2);

const deliveryLog = JSON.parse(await readFile(path.join(outDir, "delivery_log.json"), "utf8"));
assert.equal(deliveryLog.schema, "pf.orc.verified_hive_messaging_bridge.v1");
assert.equal(deliveryLog.records.length, 5);
assert.equal(deliveryLog.summary.byFailureStage.none, 2);
assert.equal(deliveryLog.summary.byFailureStage.conversation_lookup, 1);
assert.equal(deliveryLog.summary.byFailureStage.message_post, 1);
assert.equal(deliveryLog.summary.byFailureStage.message_retrieval, 1);

const zozRecord = deliveryLog.records.find((record) => record.target.handle === "zoz");
assert.equal(zozRecord.finalStatus, "delivered_verified");
assert.equal(zozRecord.resolvedBy, "wallet_address");
assert.equal(zozRecord.postAttempts.length, 2);
assert.equal(zozRecord.postAttempts[0].httpStatus, 503);
assert.equal(zozRecord.postAttempts[0].retryScheduled, true);
assert.equal(zozRecord.verification.ok, true);

const agtiRecord = deliveryLog.records.find((record) => record.target.handle === "agticorp");
assert.equal(agtiRecord.failureStage, "conversation_lookup");
assert.equal(agtiRecord.failureCode, "conversation_not_found");

const donravleRecord = deliveryLog.records.find((record) => record.target.handle === "donravle");
assert.equal(donravleRecord.failureStage, "message_post");
assert.equal(donravleRecord.postAttempts.length, 3);

const yuukiRecord = deliveryLog.records.find((record) => record.target.handle === "yuuki");
assert.equal(yuukiRecord.failureStage, "message_retrieval");
assert.equal(yuukiRecord.postAttempts.length, 1);

console.log("orc-verified-messaging-bridge-smoke ok");
