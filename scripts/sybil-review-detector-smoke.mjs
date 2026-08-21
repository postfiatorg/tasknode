#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "sybil-review-detector-"));
const inputPath = path.join(tempDir, "sybil-input.json");
const outDir = path.join(tempDir, "out");
const generatedAt = "2026-06-20T00:00:00.000Z";

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

await writeJson(inputPath, {
  schema: "pf.orc.sybil_detection_input.v1",
  contributors: [
    {
      contributorKey: "acct_good",
      accountId: "acct_good",
      walletAddress: "rGoodContributor111111111111111111111",
      handle: "solidbuilder",
      providers: ["github"],
      tasks: [
        {
          taskId: "task_good_1",
          taskKind: "network",
          title: "Implement API projection repair",
          status: "rewarded",
          rewardOfferPft: 25000,
          rewardActualPft: 25000,
          acceptedAt: "2026-06-19T10:00:00.000Z",
          submittedAt: "2026-06-19T12:30:00.000Z",
          updatedAt: "2026-06-19T13:00:00.000Z",
          submission: {
            text:
              "Implemented on branch fix/projection-repair in commit 4a9f1c2d3e4f5a67890123456789012345678901. " +
              "Changed files: server/repositories/tasks.js and scripts/task-projection-smoke.mjs. " +
              "Commands run: npm run task-projection-smoke && npm run lint. PR: https://github.com/postfiatorg/tasknodeofficial/pull/999",
          },
        },
      ],
    },
    {
      contributorKey: "acct_burst_text",
      accountId: "acct_burst_text",
      walletAddress: "rBurstContributor22222222222222222222",
      handle: "bursttext",
      providers: ["email"],
      tasks: [
        {
          taskId: "task_burst_1",
          taskKind: "network",
          title: "Review workflow friction one",
          status: "rewarded",
          rewardOfferPft: 10000,
          rewardActualPft: 5000,
          acceptedAt: "2026-06-19T10:00:00.000Z",
          submittedAt: "2026-06-19T10:05:00.000Z",
          updatedAt: "2026-06-19T10:10:00.000Z",
          submission: { text: "I reviewed the workflow. It seems useful and the team should improve the user experience." },
        },
        {
          taskId: "task_burst_2",
          taskKind: "network",
          title: "Review workflow friction two",
          status: "rewarded",
          rewardOfferPft: 10000,
          rewardActualPft: 5000,
          acceptedAt: "2026-06-19T10:20:00.000Z",
          submittedAt: "2026-06-19T10:25:00.000Z",
          updatedAt: "2026-06-19T10:30:00.000Z",
          submission: { text: "I reviewed the workflow. It seems useful and the team should improve the user experience." },
        },
        {
          taskId: "task_burst_3",
          taskKind: "network",
          title: "Review workflow friction three",
          status: "rewarded",
          rewardOfferPft: 10000,
          rewardActualPft: 10000,
          acceptedAt: "2026-06-19T10:40:00.000Z",
          submittedAt: "2026-06-19T10:45:00.000Z",
          updatedAt: "2026-06-19T10:50:00.000Z",
          submission: { text: "I reviewed the workflow. It seems useful and the team should improve the user experience." },
        },
        {
          taskId: "task_burst_4",
          taskKind: "network",
          title: "Review workflow friction four",
          status: "rewarded",
          rewardOfferPft: 10000,
          rewardActualPft: 10000,
          acceptedAt: "2026-06-19T11:00:00.000Z",
          submittedAt: "2026-06-19T11:05:00.000Z",
          updatedAt: "2026-06-19T11:10:00.000Z",
          submission: { text: "I reviewed the workflow. It seems useful and the team should improve the user experience." },
        },
      ],
    },
    {
      contributorKey: "acct_template",
      accountId: "acct_template",
      walletAddress: "rTemplateContributor333333333333333333",
      handle: "templater",
      providers: [],
      tasks: [
        {
          taskId: "task_template_1",
          taskKind: "network",
          title: "Prepare Task Acceptance Workflow",
          status: "rewarded",
          rewardOfferPft: 8000,
          rewardActualPft: 8000,
          acceptedAt: "2026-06-19T12:00:00.000Z",
          submittedAt: "2026-06-19T12:01:00.000Z",
          updatedAt: "2026-06-19T12:02:00.000Z",
          submission: { text: "The task acceptance flow was reviewed and the output is complete." },
        },
        {
          taskId: "task_template_2",
          taskKind: "network",
          title: "Task Acceptance Workflow",
          status: "rewarded",
          rewardOfferPft: 8000,
          rewardActualPft: 8000,
          acceptedAt: "2026-06-19T12:10:00.000Z",
          submittedAt: "2026-06-19T12:11:00.000Z",
          updatedAt: "2026-06-19T12:12:00.000Z",
          submission: { text: "The task acceptance flow was reviewed and the output is complete." },
        },
        {
          taskId: "task_template_3",
          taskKind: "network",
          title: "Review Task Acceptance Workflow",
          status: "rewarded",
          rewardOfferPft: 8000,
          rewardActualPft: 8000,
          acceptedAt: "2026-06-19T12:20:00.000Z",
          submittedAt: "2026-06-19T12:21:00.000Z",
          updatedAt: "2026-06-19T12:22:00.000Z",
          submission: { text: "The task acceptance flow was reviewed and the output is complete." },
        },
      ],
    },
  ],
});

const scriptPath = path.join(repoRoot, "scripts", "sybil-review-detector.mjs");
const { stdout } = await execFileAsync(process.execPath, [
  scriptPath,
  "batch",
  "--input",
  inputPath,
  "--out",
  outDir,
  "--generated-at",
  generatedAt,
  "--generated-by",
  "grashnuk",
]);
const output = JSON.parse(stdout);
assert.equal(output.ok, true);
assert.equal(output.schema, "pf.orc.sybil_detection_report.v1");
assert.equal(output.summary.contributorsEvaluated, 3);
assert.equal(output.summary.contributorsFlagged, 2);

const report = await readJson(path.join(outDir, "sybil_detection_report.json"));
assert.equal(report.mode, "recommend_only_no_enforcement");
assert.equal(report.enforcementBoundary.wouldMoveFunds, false);
assert.equal(report.enforcementBoundary.wouldBanAccounts, false);
assert.equal(report.enforcementBoundary.requiresHumanApprovalForAnyOperationalUse, true);
assert.equal(report.flags.length, 2);
assert.equal(report.flags.some((flag) => flag.accountId === "acct_good"), false);

const burst = report.flags.find((flag) => flag.accountId === "acct_burst_text");
assert.ok(burst);
assert.equal(burst.operationalUseAllowed, false);
assert.equal(burst.requiresHumanApproval, true);
assert.deepEqual(
  burst.flagRules.sort(),
  [
    "all_ai_like_text_only_submissions",
    "duplicate_submission_text",
    "network_task_burst_gt_3_in_3h",
    "partial_network_rewards_2plus",
    "provider_risk_email_only_or_email_primary",
    "rapid_accept_to_submit_loop",
    "text_only_no_work_submission",
  ].sort()
);

const templated = report.flags.find((flag) => flag.accountId === "acct_template");
assert.ok(templated);
assert.equal(templated.providerRisk, "unknown_provider");
assert.equal(templated.flagRules.includes("duplicate_submission_text"), true);
assert.equal(templated.flagRules.includes("repeated_title_family"), true);
assert.equal(templated.flagRules.includes("rapid_accept_to_submit_loop"), true);
assert.equal(templated.flagRules.includes("provider_risk_unknown_provider"), true);

const summary = await readFile(path.join(outDir, "sybil_detection_summary.md"), "utf8");
assert.match(summary, /Contributors flagged: 2/);
assert.match(summary, /recommend-only/);

console.log("sybil-review-detector-smoke ok");
