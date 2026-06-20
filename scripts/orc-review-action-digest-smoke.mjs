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
  "docs/verification/orc_review_action_digest_task_2ea6b10ba3e3ae2cc3c3cd7b59431ee8"
);
const script = path.join(repoRoot, "scripts/orc-review-action-digest.mjs");
const ledger = path.join(fixtureDir, "sample_review_ledger.json");
const outDir = await mkdtemp(path.join(os.tmpdir(), "orc-review-action-digest-"));

const help = (await execFileAsync(process.execPath, [script, "--help"])).stdout;
assert.match(help, /review-routing artifacts only/);
assert.match(help, /does not mutate routing/);

const batch = JSON.parse(
  (
    await execFileAsync(process.execPath, [
      script,
      "batch",
      "--ledger",
      ledger,
      "--out",
      outDir,
      "--generated-by",
      "grashnuk",
    ])
  ).stdout
);
assert.equal(batch.ok, true);
assert.deepEqual(batch.counts, {
  totalReviewRecords: 6,
  actionRequiredRecords: 5,
  noActionRecords: 1,
  actionOwners: 3,
});
assert.deepEqual(batch.files.sort(), [
  "digest.json",
  "discord_briefing.md",
  "routing_packets/nazgul_alex_review.json",
  "routing_packets/product_engineering_triage.json",
  "routing_packets/protocol_owner_review.json",
]);

const digest = JSON.parse(await readFile(path.join(outDir, "digest.json"), "utf8"));
assert.equal(digest.operationalBoundary.artifactOnly, true);
assert.equal(digest.operationalBoundary.enforcementAllowed, false);
assert.equal(digest.operationalBoundary.liveRoutingMutationAllowed, false);
assert.equal(digest.operationalBoundary.fundsMovementAllowed, false);
assert.equal(digest.operationalBoundary.humanReviewRequiredForEnforcement, true);
assert.equal(digest.byActionOwner.product_engineering_triage, 2);
assert.equal(digest.byActionOwner.protocol_owner_review, 2);
assert.equal(digest.byActionOwner.nazgul_alex_review, 1);
assert.equal(digest.highestPriorityItems[0].taskId, "task_cross_wallet_cluster_candidate");
assert.equal(digest.highestPriorityItems[0].actionOwner, "nazgul_alex_review");
assert.deepEqual(digest.highestPriorityItems.map((item) => item.priority), [96, 88, 82, 72, 69]);

const nazgulPacket = JSON.parse(await readFile(path.join(outDir, "routing_packets/nazgul_alex_review.json"), "utf8"));
assert.equal(nazgulPacket.operationalBoundary.enforcementAllowed, false);
assert.equal(nazgulPacket.summary.highestPriority, 96);
assert.equal(nazgulPacket.tasks.length, 1);
assert.equal(nazgulPacket.tasks[0].taskId, "task_cross_wallet_cluster_candidate");
assert.equal(nazgulPacket.tasks[0].feedbackCompatiblePayload.metadata.actionOwner, "nazgul_alex_review");
assert.deepEqual(nazgulPacket.tasks[0].integritySignals, [
  "cross_wallet_pattern",
  "thin_evidence",
  "repeat_title_family",
]);

const productPacket = JSON.parse(await readFile(path.join(outDir, "routing_packets/product_engineering_triage.json"), "utf8"));
assert.equal(productPacket.tasks.length, 2);
assert.equal(
  productPacket.tasks.some((task) => task.taskId === "task_completed_self_contained_docs"),
  false
);
assert.equal(
  productPacket.tasks.every((task) => task.feedbackCompatiblePayload.recipientAccountId.startsWith("acct_")),
  true
);

const briefing = await readFile(path.join(outDir, "discord_briefing.md"), "utf8");
assert.match(briefing, /task_cross_wallet_cluster_candidate -> nazgul_alex_review/);
assert.match(briefing, /no bans, clawbacks, fund movement, signing, deployment, enforcement, or live routing mutation occurred/);

const generated = JSON.parse(
  (
    await execFileAsync(process.execPath, [
      script,
      "generate",
      "--ledger",
      ledger,
      "--generated-by",
      "grashnuk",
    ])
  ).stdout
);
assert.equal(generated.ok, true);
assert.equal(generated.digest.counts.actionRequiredRecords, batch.counts.actionRequiredRecords);
assert.equal(generated.routingPackets.length, 3);
assert.equal(generated.digest.operationalBoundary.enforcementAllowed, false);

console.log("orc-review-action-digest-smoke ok");
