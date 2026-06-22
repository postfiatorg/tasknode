import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const tempDir = await mkdtemp(path.join(os.tmpdir(), "orc-review-feedback-pipeline-"));
const inputPath = path.join(tempDir, "mock-submissions.json");
const pipelineOut = path.join(tempDir, "pipeline");
const deliveryOut = path.join(tempDir, "delivery");
const targetsPath = path.join(tempDir, "targets.json");

function runJson(scriptName, args) {
  return JSON.parse(execFileSync(process.execPath, [
    path.join(repoRoot, "scripts", scriptName),
    ...args,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  }));
}

await writeFile(inputPath, `${JSON.stringify({
  schema: "pf.orc.mock_task_submission_batch.v1",
  submissions: [
    {
      taskId: "task_feedback_verified",
      recipientAccountId: "acct_verified",
      recipientHandle: "verified-user",
      evidenceScenario: "verified",
      sourceCid: "QmVerified",
      artifacts: [
        { type: "source", url: "https://example.test/source" },
        { type: "command_output", cid: "QmOutput" },
      ],
    },
    {
      taskId: "task_feedback_self_attested",
      recipientAccountId: "acct_self_attested",
      recipientHandle: "self-user",
      evidenceScenario: "self_attested",
      moneySensitive: true,
      artifacts: [{ type: "text", value: "I did it." }],
    },
    {
      taskId: "task_feedback_missing_target",
      recipientAccountId: "acct_missing_target",
      recipientHandle: "missing-user",
      evidenceScenario: "unverified",
      artifacts: [],
    },
  ],
}, null, 2)}\n`);

const pipeline = runJson("orc-review-pipeline-orchestrator.mjs", [
  "run",
  "--input",
  inputPath,
  "--out",
  pipelineOut,
  "--generated-by",
  "grashnuk",
]);
assert.equal(pipeline.ok, true);
assert.equal(pipeline.processedSubmissions, 3);
assert.equal(pipeline.hivePayloads, 3);
assert.equal(pipeline.byStatus.verified, 1);
assert.equal(pipeline.byStatus.self_attested, 1);
assert.equal(pipeline.byStatus.unverified, 1);

const report = JSON.parse(await readFile(path.join(pipelineOut, "pipeline_report.json"), "utf8"));
assert.equal(report.summary.flags.money_sensitive, 1);
assert.equal(report.summary.flags.do_not_operationalize, 1);
assert.equal(report.pipeline.every((item) => item.contributorMessage.hivePayloadGenerated), true);

await writeFile(targetsPath, `${JSON.stringify({
  contributors: [
    {
      accountId: "acct_verified",
      handle: "verified-user",
      conversationId: "conv_verified",
    },
    {
      accountId: "acct_self_attested",
      handle: "self-user",
      conversationId: "conv_self",
      mockStatus: "failed",
      mockError: "manual review hold",
    },
  ],
}, null, 2)}\n`);

const delivery = runJson("orc-hive-feedback-delivery.mjs", [
  "deliver",
  "--messages",
  path.join(pipelineOut, "feedback_messages", "hive_payloads.json"),
  "--targets",
  targetsPath,
  "--out",
  deliveryOut,
  "--mode",
  "mock",
  "--generated-by",
  "grashnuk",
]);
assert.equal(delivery.ok, true);
assert.equal(delivery.totalAttempts, 3);
assert.equal(delivery.sent, 1);
assert.equal(delivery.failed, 2);
assert.equal(delivery.byError.mock_endpoint_rejected, 1);
assert.equal(delivery.byError.target_not_found, 1);

const deliveryReport = JSON.parse(await readFile(path.join(deliveryOut, "delivery_report.json"), "utf8"));
assert.equal(deliveryReport.mode, "mock");
assert.equal(deliveryReport.attempts.filter((attempt) => attempt.status === "sent").length, 1);

console.log("orc-review-feedback-pipeline-smoke ok");
