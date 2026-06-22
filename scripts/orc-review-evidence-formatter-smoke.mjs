import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildDiscordSummary,
  buildOrcReviewPrompt,
  normalizeEvidencePacket,
  parseOrcReviewResponse,
  runFormatterCli,
} from "./orc-review-evidence-formatter.mjs";

const samplePacket = {
  packetType: "task_node.orc_review_evidence_packet.v1",
  referenceTaskId: "task_2edac546e8dc671d6f51ad58cc5dfdc8",
  task: {
    taskId: "task_review_formatter_smoke",
    requestId: "req_review_formatter_smoke",
    title: "Create Orc review formatter smoke packet",
    state: "rewarded",
    kind: "Network task",
    pft: 35000,
    assignee: "rSmokeWallet",
    assigneeAccountId: "acct_smoke",
    assigneeHandle: "smoke-orc",
    project: { id: "task_node_core_product", name: "Task Node Core Product" },
    description: "Build a runnable formatter and demonstrate input to Orc prompt to parsed JSON.",
    statusPacket: {
      schema: "pf.task_node.network_task_status_packet.v1",
      allocationState: "published",
      taskState: "rewarded",
      rewardMovement: "paid_positive",
    },
  },
  sourcePointers: {
    requestBundleCid: "QmRequestSmoke",
    submissionCid: "QmSubmissionSmoke",
    submissionTxHash: "ABC123",
    rewardCid: "QmRewardSmoke",
    rewardTxHash: "DEF456",
  },
  review: {
    submissions: [{
      eventType: "pf.task.submission.v1",
      sourceCid: "QmSubmissionSmoke",
      sourceTxHash: "ABC123",
      artifacts: [{
        artifactType: "file",
        value: "scripts/orc-review-evidence-formatter.mjs plus generated artifacts.",
        notes: "End-to-end formatter proof.",
      }],
    }],
    verification: {
      request: "Show script, sample packet, generated prompt, parsed JSON, and Discord summary.",
      response: "All artifacts generated locally.",
    },
    outcome: {
      decision: "rewarded",
      rewardPft: 35000,
      reason: "Formatter artifact demonstrated.",
    },
  },
  evaluationPackets: [{
    id: "eval_smoke",
    packetStatus: "ready",
    evaluatorId: "orc_formatter_smoke",
    summary: "Formatter proof is present.",
    recommendation: "Archive artifacts.",
  }],
  timeline: [
    { action: "pf.task.offer.v1", time: "2026-06-19T00:00:00.000Z", cid: "QmOfferSmoke", txHash: "OFFER" },
    { action: "pf.task.submission.v1", time: "2026-06-19T00:10:00.000Z", cid: "QmSubmissionSmoke", txHash: "ABC123" },
    { action: "pf.reward.v1", time: "2026-06-19T00:20:00.000Z", cid: "QmRewardSmoke", txHash: "DEF456" },
  ],
};

const normalized = normalizeEvidencePacket(samplePacket);
assert.equal(normalized.task.taskId, "task_review_formatter_smoke");
assert.equal(normalized.review.submissions.length, 1);
assert.equal(normalized.sourcePointers.cids.includes("QmSubmissionSmoke"), true);
assert.equal(normalized.sourcePointers.txHashes.includes("DEF456"), true);

const prompt = buildOrcReviewPrompt(samplePacket);
assert.match(prompt, /Orc Network Task Evidence Review Prompt/);
assert.match(prompt, /task_review_formatter_smoke/);
assert.match(prompt, /QmSubmissionSmoke/);
assert.match(prompt, /recommendedAction/);
assert.match(prompt, /recommendedRewardPft/);

const responseText = [
  "```json",
  JSON.stringify({
    disposition: "verified",
    recommendedAction: "keep_reward",
    recommendedRewardPft: 35000,
    integritySignals: ["external_delivery_self_attested"],
    archival: {
      archive: true,
      instructions: "Archive the packet, prompt, parsed JSON, CIDs, and reviewer note.",
    },
    notes: "Script and generated artifacts demonstrate the formatter flow end to end.",
  }, null, 2),
  "```",
].join("\n");

const result = parseOrcReviewResponse(responseText);
assert.deepEqual(Object.keys(result), [
  "taskGrade",
  "rewardRecommendation",
  "flagIndicators",
  "archivalInstructions",
  "reviewerNotes",
]);
assert.equal(result.taskGrade, "pass");
assert.equal(result.rewardRecommendation, "keep_reward: 35000 PFT");
assert.deepEqual(result.flagIndicators, ["external_delivery_self_attested"]);
assert.match(result.archivalInstructions, /Archive the packet/);

const badResult = parseOrcReviewResponse("not json");
assert.equal(badResult.taskGrade, "partial");
assert.equal(badResult.flagIndicators[0].startsWith("unparseable_orc_response:"), true);

const summary = buildDiscordSummary({ packet: samplePacket, result });
assert.match(summary, /grade=pass/);
assert.match(summary, /flags=external_delivery_self_attested/);

const tempDir = await mkdtemp(path.join(os.tmpdir(), "orc-review-formatter-smoke-"));
const inputPath = path.join(tempDir, "input.json");
const responsePath = path.join(tempDir, "response.md");
await writeFile(inputPath, `${JSON.stringify(samplePacket, null, 2)}\n`);
await writeFile(responsePath, `${responseText}\n`);
const exitCode = await runFormatterCli(["--input", inputPath, "--response", responsePath, "--out-dir", tempDir]);
assert.equal(exitCode, 0);
const cliJson = JSON.parse(await readFile(path.join(tempDir, "review_output.json"), "utf8"));
assert.equal(cliJson.taskGrade, "pass");
assert.match(await readFile(path.join(tempDir, "generated_review_prompt.md"), "utf8"), /Required Orc Response JSON/);
assert.match(await readFile(path.join(tempDir, "discord_summary.md"), "utf8"), /Orc review formatter demo/);

console.log("orc review evidence formatter smoke ok");
