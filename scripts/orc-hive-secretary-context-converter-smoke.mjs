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
  "docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7"
);
const batchOut = await mkdtemp(path.join(os.tmpdir(), "hive-secretary-batch-"));
const singleOut = await mkdtemp(path.join(os.tmpdir(), "hive-secretary-single-"));

const script = path.join(repoRoot, "scripts/orc-hive-secretary-context-converter.mjs");
const ledger = path.join(fixtureDir, "sample_review_ledger.json");
const digest = path.join(fixtureDir, "sample_action_digest.json");

const batch = JSON.parse(
  (
    await execFileAsync(process.execPath, [
      script,
      "batch",
      "--ledger",
      ledger,
      "--digest",
      digest,
      "--out",
      batchOut,
      "--generated-by",
      "grashnuk",
      "--generated-at",
      "2026-06-20T00:00:00.000Z",
    ])
  ).stdout
);
assert.equal(batch.ok, true);
assert.equal(batch.summary.totalUpdates, 5);
assert.equal(batch.summary.actionRequired, 4);
assert.equal(batch.summary.noAction, 1);
assert.equal(batch.summary.byReviewStatus.verified, 3);
assert.equal(batch.summary.byReviewStatus.self_attested, 1);
assert.equal(batch.summary.byReviewStatus.unverifiable, 1);

const batchPayload = JSON.parse(await readFile(path.join(batchOut, "hive_secretary_batch_payload.json"), "utf8"));
assert.equal(batchPayload.updates.length, 5);
assert.deepEqual(batchPayload.source.sourceTaskIds, [
  "task_doc_acceptance_workflow",
  "task_hive_chat_delivery_gap",
  "task_self_attested_parser_claim",
  "task_unverifiable_cluster_submission",
  "task_reward_projection_mismatch",
]);
assert.deepEqual(batchPayload.source.sourceReviewIds, [
  "swrev_secretary_001",
  "swrev_secretary_002",
  "swrev_secretary_003",
  "swrev_secretary_004",
  "swrev_secretary_005",
]);
assert.equal(batchPayload.source.routingPacketFiles.length, 4);
assert.equal(batchPayload.summary.byActionOwner.product_engineering_triage, 1);
assert.equal(batchPayload.summary.byActionOwner.nazgul_alex_review, 1);
assert.equal(batchPayload.summary.byActionOwner.protocol_owner_review, 1);

const negative = batchPayload.updates.find((update) => update.review.disposition === "reviewed_negative_follow_up");
assert.equal(negative.action.required, true);
assert.equal(negative.action.owner, "nazgul_alex_review");
assert.equal(negative.review.grading.score, 22);
assert.equal(negative.action.integrityPolicy.clawbackFlag, "blacklist_if_proven_no_clawback");
assert.equal(negative.action.integrityPolicy.archivalDirective, "hold_for_human_integrity_review");
assert.equal(negative.action.integrityPolicy.enforcementAllowed, false);
assert.ok(negative.contextUpdate.body.includes("Integrity/routing signals"));

const noAction = batchPayload.updates.find((update) => update.review.disposition === "reviewed_no_action");
assert.equal(noAction.action.required, false);
assert.equal(noAction.target.channel, "orc_review_accounting");

const single = JSON.parse(
  (
    await execFileAsync(process.execPath, [
      script,
      "single",
      "--ledger",
      ledger,
      "--digest",
      digest,
      "--review-id",
      "swrev_secretary_002",
      "--out",
      singleOut,
      "--generated-by",
      "grashnuk",
      "--generated-at",
      "2026-06-20T00:00:00.000Z",
    ])
  ).stdout
);
assert.equal(single.ok, true);
assert.equal(single.summary.totalUpdates, 1);

const singlePayload = JSON.parse(await readFile(path.join(singleOut, "hive_secretary_single_update.json"), "utf8"));
assert.equal(singlePayload.source.reviewId, "swrev_secretary_002");
assert.equal(singlePayload.action.owner, "product_engineering_triage");
assert.equal(singlePayload.contextUpdate.status, "ready_for_hive_secretary");

console.log("orc-hive-secretary-context-converter-smoke ok");
