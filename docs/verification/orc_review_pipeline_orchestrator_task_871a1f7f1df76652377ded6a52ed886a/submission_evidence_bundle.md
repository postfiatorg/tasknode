# Evidence Bundle: Orc Review Pipeline Orchestrator

Task: `task_871a1f7f1df76652377ded6a52ed886a`

This bundle is self-contained for verification: source, mock submissions, pipeline report, ledger, generated Hive/Discord outputs, run output, and help output.

## Execution Summary

# Orc Review Pipeline Orchestrator

Task: `task_871a1f7f1df76652377ded6a52ed886a`

## Delivered files

- `scripts/orc-review-pipeline-orchestrator.mjs` - single-command local pipeline orchestrator.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/mock_submissions.json` - five mock network-task submissions.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_ledger.json` - submitted-work review ledger produced by the orchestrator.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_report.json` - JSON pipeline report.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/hive_payloads.json` - generated Hive Chat payloads.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/discord_messages.md` - generated Discord-ready messages.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/summary.json` - feedback-generator summary.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/run_output.json` - stdout from the orchestrator run.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/help_output.txt` - CLI help output.

## Workflow

The orchestrator connects the three Orc review pipeline layers into one local command:

1. Review parser stage: parses mock submissions into `pf.orc.review_parser_output.v1` verdict fields compatible with the `task_8df...` parser output shape.
2. Ledger stage: records each verdict into a `pf.orc.submitted_work_review_ledger.v1` ledger record compatible with `task_01ba...`.
3. Feedback stage: calls `scripts/orc-contributor-feedback-message-generator.mjs` from `task_3943...` to generate Hive Chat JSON payloads and Discord-ready contributor follow-up messages.
4. Report stage: writes `pipeline_report.json`, proving each submission produced parser output, a ledger record, and contributor messages.

The script is local and payload-only. It does not send Hive messages, post to Discord, mutate live task state, sign payments, move funds, or execute enforcement.

## Commands run

```bash
chmod +x scripts/orc-review-pipeline-orchestrator.mjs
node --check scripts/orc-review-pipeline-orchestrator.mjs
jq empty docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/mock_submissions.json
node scripts/orc-review-pipeline-orchestrator.mjs --help > docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/help_output.txt

node scripts/orc-review-pipeline-orchestrator.mjs run \
  --input docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/mock_submissions.json \
  --out docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs \
  --generated-by grashnuk \
  > docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/run_output.json

jq empty docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/run_output.json docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_report.json docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_ledger.json docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/hive_payloads.json docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/summary.json

git diff --check -- scripts/orc-review-pipeline-orchestrator.mjs docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a
```

## Run result

The orchestrator stdout confirmed:

```json
{
  "ok": true,
  "processedSubmissions": 5,
  "hivePayloads": 5,
  "discordMessages": 5,
  "byStatus": {
    "verified": 2,
    "unverified": 2,
    "self_attested": 1
  }
}
```

The pipeline report confirmed each mock submission was recorded and received both message outputs:

```json
[
  {
    "taskId": "task_mock_verified_reward_visibility",
    "recorded": true,
    "hive": true,
    "discord": true
  },
  {
    "taskId": "task_mock_unverifiable_parser",
    "recorded": true,
    "hive": true,
    "discord": true
  },
  {
    "taskId": "task_mock_self_attested_contagion",
    "recorded": true,
    "hive": true,
    "discord": true
  },
  {
    "taskId": "task_mock_verified_ledger",
    "recorded": true,
    "hive": true,
    "discord": true
  },
  {
    "taskId": "task_mock_unverified_docker_overlay",
    "recorded": true,
    "hive": true,
    "discord": true
  }
]
```

## Output locations

- Pipeline report: `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_report.json`
- Ledger: `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_ledger.json`
- Hive payloads: `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/hive_payloads.json`
- Discord messages: `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/discord_messages.md`

## Source File: scripts/orc-review-pipeline-orchestrator.mjs

```js
#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PIPELINE_SCHEMA = "pf.orc.review_pipeline_orchestrator.v1";
const LEDGER_SCHEMA = "pf.orc.submitted_work_review_ledger.v1";
const REVIEWER = "grashnuk";

function usage() {
  return `Usage:
  node scripts/orc-review-pipeline-orchestrator.mjs run --input <mock-submissions.json> --out <dir> [--generated-by <handle>]

Runs a local Orc review pipeline:
  1. Parse mock network-task submissions into review verdicts.
  2. Record verdicts in a submitted-work review ledger.
  3. Generate Hive Chat JSON payloads and Discord-ready contributor messages.
  4. Write a JSON pipeline report.

This script is read-only with respect to Task Node. It does not send messages, apply enforcement, sign payments, or mutate live task state.`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    index += 1;
    options[key] = next;
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function safeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableId(prefix, ...parts) {
  const hash = crypto.createHash("sha256").update(parts.map((part) => safeText(part)).join("|")).digest("hex");
  return `${prefix}_${hash.slice(0, 20)}`;
}

function hasInspectableArtifact(submission) {
  return asArray(submission.artifacts).some((artifact) => {
    const type = safeText(artifact.type || artifact.artifactType).toLowerCase();
    return artifact.url || artifact.cid || artifact.txHash || type === "screenshot" || type === "source" || type === "command_output";
  });
}

function normalizeScenario(value) {
  const scenario = safeText(value).toLowerCase().replaceAll("-", "_");
  if (["verified", "unverified", "unverifiable", "self_attested"].includes(scenario)) return scenario;
  return "";
}

function parseReview(submission, index) {
  const scenario = normalizeScenario(submission.evidenceScenario || submission.expectedReviewStatus);
  const artifacts = asArray(submission.artifacts);
  const artifactEvidence = hasInspectableArtifact(submission);
  const notes = [];
  let reviewStatus = "unverified";
  let score = 55;
  let archiveAction = "needs_followup";
  let reviewFlags = ["missing_public_artifact"];
  let taskGrade = "hold";
  let rewardRecommendation = "needs evidence";
  let recommendedAction = "Provide source links, screenshots, command output, or uploaded artifacts so the review can be independently verified.";

  if (scenario === "verified" || (!scenario && artifactEvidence && artifacts.length >= 2)) {
    reviewStatus = "verified";
    score = Number(submission.score ?? 88);
    archiveAction = "archive_hot";
    reviewFlags = [];
    taskGrade = "pass";
    rewardRecommendation = "eligible";
    recommendedAction = "No contributor action required; the submission is ready to archive as verified.";
    notes.push("Inspectable artifacts are present and sufficient for the mock review path.");
  } else if (scenario === "self_attested") {
    reviewStatus = "self_attested";
    score = Number(submission.score ?? 70);
    archiveAction = "hold";
    reviewFlags = ["self_attested_evidence"];
    if (submission.moneySensitive) reviewFlags.push("money_sensitive", "do_not_operationalize");
    taskGrade = "partial";
    rewardRecommendation = "manual review";
    recommendedAction = "Publish independently inspectable artifacts before this work is operationalized.";
    notes.push("Submission makes a plausible claim but lacks enough independent artifact evidence.");
  } else {
    reviewStatus = "unverified";
    score = Number(submission.score ?? (scenario === "unverifiable" ? 58 : 60));
    archiveAction = "needs_followup";
    reviewFlags = artifactEvidence ? ["needs_artifact_verification"] : ["missing_public_artifact"];
    taskGrade = "hold";
    rewardRecommendation = "needs evidence";
    recommendedAction = "Add the missing public artifact or a command/output pair that proves the claimed work.";
    notes.push("Mock parser could not fully verify the submission from the provided evidence packet.");
  }

  if (submission.pipelineAdjacent) reviewFlags.push("pipeline_adjacent");
  const reviewerNotes = safeText(submission.reviewNote) || notes.join(" ");
  return {
    reviewStatus,
    score: Number(score.toFixed ? score.toFixed(2) : Number(score).toFixed(2)),
    reviewFlags,
    archiveAction,
    recommendedAction,
    parserOutput: {
      schema: "pf.orc.review_parser_output.v1",
      parserVersion: "mock_orc_review_parser_v1",
      submissionIndex: index + 1,
      taskGrade,
      rewardRecommendation,
      flagIndicators: reviewFlags,
      archivalInstructions: archiveAction,
      reviewerNotes,
    },
  };
}

function buildLedgerRecord(submission, review, index) {
  const taskId = safeText(submission.taskId, `mock_task_${index + 1}`);
  const timestamp = safeText(submission.reviewedAt) || new Date(Date.UTC(2026, 5, 20, 2, 5, index)).toISOString();
  return {
    id: stableId("swrev_pipeline", taskId, REVIEWER, timestamp, review.reviewStatus),
    taskId,
    recipientAccountId: safeText(submission.recipientAccountId),
    recipientHandle: safeText(submission.recipientHandle || submission.assigneeHandle),
    reviewer: REVIEWER,
    reviewStatus: review.reviewStatus,
    score: review.score,
    reviewFlags: review.reviewFlags,
    archiveAction: review.archiveAction,
    timestamp,
    source: {
      cid: safeText(submission.sourceCid),
      txHash: safeText(submission.sourceTxHash),
    },
    parserOutput: review.parserOutput,
    recommendedAction: review.recommendedAction,
  };
}

function summarize(records) {
  const byStatus = {};
  const flags = {};
  for (const record of records) {
    byStatus[record.reviewStatus] = (byStatus[record.reviewStatus] || 0) + 1;
    for (const flag of record.reviewFlags) {
      flags[flag] = (flags[flag] || 0) + 1;
    }
  }
  return {
    processedSubmissions: records.length,
    ledgerRecords: records.length,
    byStatus,
    flags,
  };
}

async function readInput(inputPath) {
  if (!existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
  const parsed = JSON.parse(await readFile(inputPath, "utf8"));
  const submissions = asArray(parsed.submissions);
  if (!submissions.length) throw new Error("Input must contain submissions[]");
  return {
    schema: safeText(parsed.schema, "pf.orc.mock_task_submission_batch.v1"),
    submissions,
  };
}

async function run(options) {
  const inputPath = requireOption(options, "input");
  const outDir = requireOption(options, "out");
  const generatedBy = safeText(options["generated-by"], REVIEWER).replace(/^@/, "");
  const input = await readInput(inputPath);
  await mkdir(outDir, { recursive: true });

  const pipelineItems = input.submissions.map((submission, index) => {
    const review = parseReview(submission, index);
    const ledgerRecord = buildLedgerRecord(submission, review, index);
    return { submission, review, ledgerRecord };
  });

  const ledger = {
    schema: LEDGER_SCHEMA,
    updatedAt: new Date().toISOString(),
    records: pipelineItems.map((item) => item.ledgerRecord),
  };
  const ledgerPath = path.join(outDir, "pipeline_ledger.json");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

  const feedbackDir = path.join(outDir, "feedback_messages");
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const generatorPath = path.join(scriptDir, "orc-contributor-feedback-message-generator.mjs");
  const batchStdout = execFileSync(process.execPath, [
    generatorPath,
    "batch",
    "--ledger",
    ledgerPath,
    "--out",
    feedbackDir,
    "--generated-by",
    generatedBy,
  ], { encoding: "utf8" });

  const hivePayloads = JSON.parse(await readFile(path.join(feedbackDir, "hive_payloads.json"), "utf8"));
  const discordMessages = await readFile(path.join(feedbackDir, "discord_messages.md"), "utf8");
  const feedbackSummary = JSON.parse(await readFile(path.join(feedbackDir, "summary.json"), "utf8"));

  const report = {
    ok: true,
    schema: PIPELINE_SCHEMA,
    generatedAt: new Date().toISOString(),
    generatedBy,
    input: {
      path: inputPath,
      schema: input.schema,
      submissions: input.submissions.length,
    },
    tools: {
      reviewParser: "mock_orc_review_parser_v1 compatible with task_8df review fields",
      submittedWorkReviewLedger: LEDGER_SCHEMA,
      feedbackMessageGenerator: "pf.orc.contributor_feedback_messages.v1",
    },
    outputs: {
      ledgerPath,
      hivePayloadsPath: path.join(feedbackDir, "hive_payloads.json"),
      discordMessagesPath: path.join(feedbackDir, "discord_messages.md"),
      feedbackSummaryPath: path.join(feedbackDir, "summary.json"),
    },
    summary: {
      ...summarize(ledger.records),
      hivePayloads: hivePayloads.length,
      discordMessages: feedbackSummary.discordMessages,
    },
    pipeline: pipelineItems.map((item, index) => {
      const hivePayload = hivePayloads.find((payload) => payload.metadata?.sourceReviewId === item.ledgerRecord.id) || {};
      const discordIncluded = discordMessages.includes(item.ledgerRecord.taskId);
      return {
        index: index + 1,
        submission: {
          taskId: item.ledgerRecord.taskId,
          recipientAccountId: item.ledgerRecord.recipientAccountId,
          recipientHandle: item.ledgerRecord.recipientHandle,
          evidenceScenario: safeText(item.submission.evidenceScenario),
          artifactCount: asArray(item.submission.artifacts).length,
        },
        reviewParserOutput: item.review.parserOutput,
        ledgerEntry: {
          recorded: true,
          id: item.ledgerRecord.id,
          reviewStatus: item.ledgerRecord.reviewStatus,
          score: item.ledgerRecord.score,
          archiveAction: item.ledgerRecord.archiveAction,
          reviewFlags: item.ledgerRecord.reviewFlags,
        },
        contributorMessage: {
          hivePayloadGenerated: Boolean(hivePayload.metadata?.sourceReviewId),
          hivePayloadMetadata: hivePayload.metadata || {},
          discordMessageGenerated: discordIncluded,
        },
      };
    }),
    generatorBatchStdout: JSON.parse(batchStdout),
  };

  const reportPath = path.join(outDir, "pipeline_report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return {
    ok: true,
    schema: PIPELINE_SCHEMA,
    outputDir: outDir,
    reportPath,
    ledgerPath,
    processedSubmissions: ledger.records.length,
    hivePayloads: hivePayloads.length,
    discordMessages: feedbackSummary.discordMessages,
    byStatus: report.summary.byStatus,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(await run(options), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
```

## Mock Submission Batch

```json
{
  "schema": "pf.orc.mock_task_submission_batch.v1",
  "createdAt": "2026-06-20T02:05:00.000Z",
  "submissions": [
    {
      "taskId": "task_mock_verified_reward_visibility",
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "recipientHandle": "gmoney",
      "title": "Document Reward Visibility Gaps Across Hive Screens",
      "evidenceScenario": "verified",
      "sourceCid": "QmMockRewardVisibilitySubmission",
      "sourceTxHash": "MOCK_TX_REWARD_VISIBILITY",
      "artifacts": [
        {
          "type": "report",
          "url": "https://example.invalid/reward-visibility-report.md"
        },
        {
          "type": "screenshot",
          "url": "https://example.invalid/tasks-active-reward-breakdown.png"
        }
      ],
      "reviewNote": "Report contains concrete reward-visibility findings with inspectable screenshot evidence."
    },
    {
      "taskId": "task_mock_unverifiable_parser",
      "recipientAccountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
      "recipientHandle": "zoz",
      "title": "Build Orc Review Prompt and JSON Parser",
      "evidenceScenario": "unverifiable",
      "pipelineAdjacent": true,
      "sourceCid": "QmMockParserSubmission",
      "sourceTxHash": "MOCK_TX_PARSER",
      "artifacts": [
        {
          "type": "summary",
          "text": "Parser behavior described, but no runnable source link or captured input/output pair was attached."
        }
      ],
      "reviewNote": "Pipeline-adjacent parser claim needs inspectable source and generated output before reuse."
    },
    {
      "taskId": "task_mock_self_attested_contagion",
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "recipientHandle": "grashnuk",
      "title": "Build XRPL Contagion Risk Monitoring Script",
      "evidenceScenario": "self_attested",
      "moneySensitive": true,
      "sourceCid": "QmMockContagionRiskSubmission",
      "sourceTxHash": "MOCK_TX_CONTAGION",
      "artifacts": [
        {
          "type": "summary",
          "text": "Monitoring logic summarized inline without a public repository or reproducible output bundle."
        }
      ],
      "reviewNote": "Money-sensitive output must remain recommend-only until public artifacts are independently inspected."
    },
    {
      "taskId": "task_mock_verified_ledger",
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "recipientHandle": "grashnuk",
      "title": "Build Submitted Work Review Ledger Tool",
      "evidenceScenario": "verified",
      "sourceCid": "QmMockLedgerSubmission",
      "sourceTxHash": "MOCK_TX_LEDGER",
      "artifacts": [
        {
          "type": "source",
          "url": "scripts/orc-submitted-work-review-ledger.mjs"
        },
        {
          "type": "command_output",
          "url": "docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/report_output.json"
        }
      ],
      "reviewNote": "Runnable source and captured output demonstrate the ledger path."
    },
    {
      "taskId": "task_mock_unverified_docker_overlay",
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "recipientHandle": "gmoney",
      "title": "Build Dynamic UNL Participation Docker Overlay",
      "evidenceScenario": "unverified",
      "sourceCid": "QmMockDockerOverlaySubmission",
      "sourceTxHash": "MOCK_TX_DOCKER",
      "artifacts": [
        {
          "type": "summary",
          "text": "Output describes Docker overlay behavior but omits the compose file and startup log."
        }
      ],
      "reviewNote": "Needs the docker-compose artifact and startup log before another agent can reuse it."
    }
  ]
}
```

## Run Output

```json
{
  "ok": true,
  "schema": "pf.orc.review_pipeline_orchestrator.v1",
  "outputDir": "docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs",
  "reportPath": "docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_report.json",
  "ledgerPath": "docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_ledger.json",
  "processedSubmissions": 5,
  "hivePayloads": 5,
  "discordMessages": 5,
  "byStatus": {
    "verified": 2,
    "unverified": 2,
    "self_attested": 1
  }
}
```

## Pipeline Report

```json
{
  "ok": true,
  "schema": "pf.orc.review_pipeline_orchestrator.v1",
  "generatedAt": "2026-06-20T02:06:23.447Z",
  "generatedBy": "grashnuk",
  "input": {
    "path": "docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/mock_submissions.json",
    "schema": "pf.orc.mock_task_submission_batch.v1",
    "submissions": 5
  },
  "tools": {
    "reviewParser": "mock_orc_review_parser_v1 compatible with task_8df review fields",
    "submittedWorkReviewLedger": "pf.orc.submitted_work_review_ledger.v1",
    "feedbackMessageGenerator": "pf.orc.contributor_feedback_messages.v1"
  },
  "outputs": {
    "ledgerPath": "docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_ledger.json",
    "hivePayloadsPath": "docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/hive_payloads.json",
    "discordMessagesPath": "docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/discord_messages.md",
    "feedbackSummaryPath": "docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/summary.json"
  },
  "summary": {
    "processedSubmissions": 5,
    "ledgerRecords": 5,
    "byStatus": {
      "verified": 2,
      "unverified": 2,
      "self_attested": 1
    },
    "flags": {
      "missing_public_artifact": 2,
      "pipeline_adjacent": 1,
      "self_attested_evidence": 1,
      "money_sensitive": 1,
      "do_not_operationalize": 1
    },
    "hivePayloads": 5,
    "discordMessages": 5
  },
  "pipeline": [
    {
      "index": 1,
      "submission": {
        "taskId": "task_mock_verified_reward_visibility",
        "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
        "recipientHandle": "gmoney",
        "evidenceScenario": "verified",
        "artifactCount": 2
      },
      "reviewParserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 1,
        "taskGrade": "pass",
        "rewardRecommendation": "eligible",
        "flagIndicators": [],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Report contains concrete reward-visibility findings with inspectable screenshot evidence."
      },
      "ledgerEntry": {
        "recorded": true,
        "id": "swrev_pipeline_a0ef2eb71eab9a1adf61",
        "reviewStatus": "verified",
        "score": 88,
        "archiveAction": "archive_hot",
        "reviewFlags": []
      },
      "contributorMessage": {
        "hivePayloadGenerated": true,
        "hivePayloadMetadata": {
          "schema": "pf.orc.contributor_feedback_messages.v1",
          "deliverySurface": "hive_chat",
          "generatedBy": "grashnuk",
          "sourceReviewId": "swrev_pipeline_a0ef2eb71eab9a1adf61",
          "sourceTaskId": "task_mock_verified_reward_visibility",
          "reviewStatus": "verified",
          "score": 88,
          "reviewFlags": [],
          "archiveAction": "archive_hot",
          "requiresContributorAction": false
        },
        "discordMessageGenerated": true
      }
    },
    {
      "index": 2,
      "submission": {
        "taskId": "task_mock_unverifiable_parser",
        "recipientAccountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
        "recipientHandle": "zoz",
        "evidenceScenario": "unverifiable",
        "artifactCount": 1
      },
      "reviewParserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 2,
        "taskGrade": "hold",
        "rewardRecommendation": "needs evidence",
        "flagIndicators": [
          "missing_public_artifact",
          "pipeline_adjacent"
        ],
        "archivalInstructions": "needs_followup",
        "reviewerNotes": "Pipeline-adjacent parser claim needs inspectable source and generated output before reuse."
      },
      "ledgerEntry": {
        "recorded": true,
        "id": "swrev_pipeline_8c4155dc4bc6ce7f7d79",
        "reviewStatus": "unverified",
        "score": 58,
        "archiveAction": "needs_followup",
        "reviewFlags": [
          "missing_public_artifact",
          "pipeline_adjacent"
        ]
      },
      "contributorMessage": {
        "hivePayloadGenerated": true,
        "hivePayloadMetadata": {
          "schema": "pf.orc.contributor_feedback_messages.v1",
          "deliverySurface": "hive_chat",
          "generatedBy": "grashnuk",
          "sourceReviewId": "swrev_pipeline_8c4155dc4bc6ce7f7d79",
          "sourceTaskId": "task_mock_unverifiable_parser",
          "reviewStatus": "unverified",
          "score": 58,
          "reviewFlags": [
            "missing_public_artifact",
            "pipeline_adjacent"
          ],
          "archiveAction": "needs_followup",
          "requiresContributorAction": true
        },
        "discordMessageGenerated": true
      }
    },
    {
      "index": 3,
      "submission": {
        "taskId": "task_mock_self_attested_contagion",
        "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
        "recipientHandle": "grashnuk",
        "evidenceScenario": "self_attested",
        "artifactCount": 1
      },
      "reviewParserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 3,
        "taskGrade": "partial",
        "rewardRecommendation": "manual review",
        "flagIndicators": [
          "self_attested_evidence",
          "money_sensitive",
          "do_not_operationalize"
        ],
        "archivalInstructions": "hold",
        "reviewerNotes": "Money-sensitive output must remain recommend-only until public artifacts are independently inspected."
      },
      "ledgerEntry": {
        "recorded": true,
        "id": "swrev_pipeline_ae6f9fd8ec94322a5335",
        "reviewStatus": "self_attested",
        "score": 70,
        "archiveAction": "hold",
        "reviewFlags": [
          "self_attested_evidence",
          "money_sensitive",
          "do_not_operationalize"
        ]
      },
      "contributorMessage": {
        "hivePayloadGenerated": true,
        "hivePayloadMetadata": {
          "schema": "pf.orc.contributor_feedback_messages.v1",
          "deliverySurface": "hive_chat",
          "generatedBy": "grashnuk",
          "sourceReviewId": "swrev_pipeline_ae6f9fd8ec94322a5335",
          "sourceTaskId": "task_mock_self_attested_contagion",
          "reviewStatus": "self_attested",
          "score": 70,
          "reviewFlags": [
            "self_attested_evidence",
            "money_sensitive",
            "do_not_operationalize"
          ],
          "archiveAction": "hold",
          "requiresContributorAction": true
        },
        "discordMessageGenerated": true
      }
    },
    {
      "index": 4,
      "submission": {
        "taskId": "task_mock_verified_ledger",
        "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
        "recipientHandle": "grashnuk",
        "evidenceScenario": "verified",
        "artifactCount": 2
      },
      "reviewParserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 4,
        "taskGrade": "pass",
        "rewardRecommendation": "eligible",
        "flagIndicators": [],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Runnable source and captured output demonstrate the ledger path."
      },
      "ledgerEntry": {
        "recorded": true,
        "id": "swrev_pipeline_28f1a8ade78b7c933e41",
        "reviewStatus": "verified",
        "score": 88,
        "archiveAction": "archive_hot",
        "reviewFlags": []
      },
      "contributorMessage": {
        "hivePayloadGenerated": true,
        "hivePayloadMetadata": {
          "schema": "pf.orc.contributor_feedback_messages.v1",
          "deliverySurface": "hive_chat",
          "generatedBy": "grashnuk",
          "sourceReviewId": "swrev_pipeline_28f1a8ade78b7c933e41",
          "sourceTaskId": "task_mock_verified_ledger",
          "reviewStatus": "verified",
          "score": 88,
          "reviewFlags": [],
          "archiveAction": "archive_hot",
          "requiresContributorAction": false
        },
        "discordMessageGenerated": true
      }
    },
    {
      "index": 5,
      "submission": {
        "taskId": "task_mock_unverified_docker_overlay",
        "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
        "recipientHandle": "gmoney",
        "evidenceScenario": "unverified",
        "artifactCount": 1
      },
      "reviewParserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 5,
        "taskGrade": "hold",
        "rewardRecommendation": "needs evidence",
        "flagIndicators": [
          "missing_public_artifact"
        ],
        "archivalInstructions": "needs_followup",
        "reviewerNotes": "Needs the docker-compose artifact and startup log before another agent can reuse it."
      },
      "ledgerEntry": {
        "recorded": true,
        "id": "swrev_pipeline_28d3e570d4e34573ffd1",
        "reviewStatus": "unverified",
        "score": 60,
        "archiveAction": "needs_followup",
        "reviewFlags": [
          "missing_public_artifact"
        ]
      },
      "contributorMessage": {
        "hivePayloadGenerated": true,
        "hivePayloadMetadata": {
          "schema": "pf.orc.contributor_feedback_messages.v1",
          "deliverySurface": "hive_chat",
          "generatedBy": "grashnuk",
          "sourceReviewId": "swrev_pipeline_28d3e570d4e34573ffd1",
          "sourceTaskId": "task_mock_unverified_docker_overlay",
          "reviewStatus": "unverified",
          "score": 60,
          "reviewFlags": [
            "missing_public_artifact"
          ],
          "archiveAction": "needs_followup",
          "requiresContributorAction": true
        },
        "discordMessageGenerated": true
      }
    }
  ],
  "generatorBatchStdout": {
    "ok": true,
    "schema": "pf.orc.contributor_feedback_messages.v1",
    "generatedAt": "2026-06-20T02:06:23.438Z",
    "unnotifiedRecords": 5,
    "hivePayloads": 5,
    "discordMessages": 5,
    "byStatus": {
      "verified": 2,
      "unverified": 2,
      "self_attested": 1
    },
    "flags": {
      "missing_public_artifact": 2,
      "pipeline_adjacent": 1,
      "self_attested_evidence": 1,
      "money_sensitive": 1,
      "do_not_operationalize": 1
    },
    "taskIds": [
      "task_mock_verified_reward_visibility",
      "task_mock_unverifiable_parser",
      "task_mock_self_attested_contagion",
      "task_mock_verified_ledger",
      "task_mock_unverified_docker_overlay"
    ],
    "outputDir": "docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages"
  }
}
```

## Pipeline Ledger

```json
{
  "schema": "pf.orc.submitted_work_review_ledger.v1",
  "updatedAt": "2026-06-20T02:06:23.410Z",
  "records": [
    {
      "id": "swrev_pipeline_a0ef2eb71eab9a1adf61",
      "taskId": "task_mock_verified_reward_visibility",
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "recipientHandle": "gmoney",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "score": 88,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T02:05:00.000Z",
      "source": {
        "cid": "QmMockRewardVisibilitySubmission",
        "txHash": "MOCK_TX_REWARD_VISIBILITY"
      },
      "parserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 1,
        "taskGrade": "pass",
        "rewardRecommendation": "eligible",
        "flagIndicators": [],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Report contains concrete reward-visibility findings with inspectable screenshot evidence."
      },
      "recommendedAction": "No contributor action required; the submission is ready to archive as verified."
    },
    {
      "id": "swrev_pipeline_8c4155dc4bc6ce7f7d79",
      "taskId": "task_mock_unverifiable_parser",
      "recipientAccountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
      "recipientHandle": "zoz",
      "reviewer": "grashnuk",
      "reviewStatus": "unverified",
      "score": 58,
      "reviewFlags": [
        "missing_public_artifact",
        "pipeline_adjacent"
      ],
      "archiveAction": "needs_followup",
      "timestamp": "2026-06-20T02:05:01.000Z",
      "source": {
        "cid": "QmMockParserSubmission",
        "txHash": "MOCK_TX_PARSER"
      },
      "parserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 2,
        "taskGrade": "hold",
        "rewardRecommendation": "needs evidence",
        "flagIndicators": [
          "missing_public_artifact",
          "pipeline_adjacent"
        ],
        "archivalInstructions": "needs_followup",
        "reviewerNotes": "Pipeline-adjacent parser claim needs inspectable source and generated output before reuse."
      },
      "recommendedAction": "Add the missing public artifact or a command/output pair that proves the claimed work."
    },
    {
      "id": "swrev_pipeline_ae6f9fd8ec94322a5335",
      "taskId": "task_mock_self_attested_contagion",
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "recipientHandle": "grashnuk",
      "reviewer": "grashnuk",
      "reviewStatus": "self_attested",
      "score": 70,
      "reviewFlags": [
        "self_attested_evidence",
        "money_sensitive",
        "do_not_operationalize"
      ],
      "archiveAction": "hold",
      "timestamp": "2026-06-20T02:05:02.000Z",
      "source": {
        "cid": "QmMockContagionRiskSubmission",
        "txHash": "MOCK_TX_CONTAGION"
      },
      "parserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 3,
        "taskGrade": "partial",
        "rewardRecommendation": "manual review",
        "flagIndicators": [
          "self_attested_evidence",
          "money_sensitive",
          "do_not_operationalize"
        ],
        "archivalInstructions": "hold",
        "reviewerNotes": "Money-sensitive output must remain recommend-only until public artifacts are independently inspected."
      },
      "recommendedAction": "Publish independently inspectable artifacts before this work is operationalized."
    },
    {
      "id": "swrev_pipeline_28f1a8ade78b7c933e41",
      "taskId": "task_mock_verified_ledger",
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "recipientHandle": "grashnuk",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "score": 88,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T02:05:03.000Z",
      "source": {
        "cid": "QmMockLedgerSubmission",
        "txHash": "MOCK_TX_LEDGER"
      },
      "parserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 4,
        "taskGrade": "pass",
        "rewardRecommendation": "eligible",
        "flagIndicators": [],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Runnable source and captured output demonstrate the ledger path."
      },
      "recommendedAction": "No contributor action required; the submission is ready to archive as verified."
    },
    {
      "id": "swrev_pipeline_28d3e570d4e34573ffd1",
      "taskId": "task_mock_unverified_docker_overlay",
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "recipientHandle": "gmoney",
      "reviewer": "grashnuk",
      "reviewStatus": "unverified",
      "score": 60,
      "reviewFlags": [
        "missing_public_artifact"
      ],
      "archiveAction": "needs_followup",
      "timestamp": "2026-06-20T02:05:04.000Z",
      "source": {
        "cid": "QmMockDockerOverlaySubmission",
        "txHash": "MOCK_TX_DOCKER"
      },
      "parserOutput": {
        "schema": "pf.orc.review_parser_output.v1",
        "parserVersion": "mock_orc_review_parser_v1",
        "submissionIndex": 5,
        "taskGrade": "hold",
        "rewardRecommendation": "needs evidence",
        "flagIndicators": [
          "missing_public_artifact"
        ],
        "archivalInstructions": "needs_followup",
        "reviewerNotes": "Needs the docker-compose artifact and startup log before another agent can reuse it."
      },
      "recommendedAction": "Add the missing public artifact or a command/output pair that proves the claimed work."
    }
  ]
}
```

## Hive Payloads

```json
[
  {
    "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
    "messageBody": "@gmoney - I am following up on reviewed Network Task task_mock_verified_reward_visibility.\nReview status: verified.\nScore: 88/100.\nFlags: none.\nNext action: No contributor action required; the submission is ready to archive as verified.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_pipeline_a0ef2eb71eab9a1adf61",
      "sourceTaskId": "task_mock_verified_reward_visibility",
      "reviewStatus": "verified",
      "score": 88,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "requiresContributorAction": false
    }
  },
  {
    "recipientAccountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
    "messageBody": "@zoz - I am following up on reviewed Network Task task_mock_unverifiable_parser.\nReview status: unverifiable.\nScore: 58/100.\nFlags: missing_public_artifact, pipeline_adjacent.\nNext action: Add the missing public artifact or a command/output pair that proves the claimed work.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_pipeline_8c4155dc4bc6ce7f7d79",
      "sourceTaskId": "task_mock_unverifiable_parser",
      "reviewStatus": "unverified",
      "score": 58,
      "reviewFlags": [
        "missing_public_artifact",
        "pipeline_adjacent"
      ],
      "archiveAction": "needs_followup",
      "requiresContributorAction": true
    }
  },
  {
    "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
    "messageBody": "@grashnuk - I am following up on reviewed Network Task task_mock_self_attested_contagion.\nReview status: self-attested.\nScore: 70/100.\nFlags: self_attested_evidence, money_sensitive, do_not_operationalize.\nNext action: Publish independently inspectable artifacts before this work is operationalized.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_pipeline_ae6f9fd8ec94322a5335",
      "sourceTaskId": "task_mock_self_attested_contagion",
      "reviewStatus": "self_attested",
      "score": 70,
      "reviewFlags": [
        "self_attested_evidence",
        "money_sensitive",
        "do_not_operationalize"
      ],
      "archiveAction": "hold",
      "requiresContributorAction": true
    }
  },
  {
    "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
    "messageBody": "@grashnuk - I am following up on reviewed Network Task task_mock_verified_ledger.\nReview status: verified.\nScore: 88/100.\nFlags: none.\nNext action: No contributor action required; the submission is ready to archive as verified.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_pipeline_28f1a8ade78b7c933e41",
      "sourceTaskId": "task_mock_verified_ledger",
      "reviewStatus": "verified",
      "score": 88,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "requiresContributorAction": false
    }
  },
  {
    "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
    "messageBody": "@gmoney - I am following up on reviewed Network Task task_mock_unverified_docker_overlay.\nReview status: unverifiable.\nScore: 60/100.\nFlags: missing_public_artifact.\nNext action: Add the missing public artifact or a command/output pair that proves the claimed work.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_pipeline_28d3e570d4e34573ffd1",
      "sourceTaskId": "task_mock_unverified_docker_overlay",
      "reviewStatus": "unverified",
      "score": 60,
      "reviewFlags": [
        "missing_public_artifact"
      ],
      "archiveAction": "needs_followup",
      "requiresContributorAction": true
    }
  }
]
```

## Discord Messages

```md
**task_mock_verified_reward_visibility** - contributor follow-up
Recipient: @gmoney (acct_oauth_31a2b120878c91e24add9ceb)
Review status: verified
Score: 88/100
Flags: none
Archive action: archive_hot
Reviewer note: Report contains concrete reward-visibility findings with inspectable screenshot evidence.
Recommended next action: No contributor action required; the submission is ready to archive as verified.
Generated by: @grashnuk

---

**task_mock_unverifiable_parser** - contributor follow-up
Recipient: @zoz (acct_oauth_8b6a2004c07fe8d96493d95f)
Review status: unverifiable
Score: 58/100
Flags: missing_public_artifact, pipeline_adjacent
Archive action: needs_followup
Reviewer note: Pipeline-adjacent parser claim needs inspectable source and generated output before reuse.
Recommended next action: Add the missing public artifact or a command/output pair that proves the claimed work.
Generated by: @grashnuk

---

**task_mock_self_attested_contagion** - contributor follow-up
Recipient: @grashnuk (acct_wallet_1a528118923ae8830d46f56e)
Review status: self-attested
Score: 70/100
Flags: self_attested_evidence, money_sensitive, do_not_operationalize
Archive action: hold
Reviewer note: Money-sensitive output must remain recommend-only until public artifacts are independently inspected.
Recommended next action: Publish independently inspectable artifacts before this work is operationalized.
Generated by: @grashnuk

---

**task_mock_verified_ledger** - contributor follow-up
Recipient: @grashnuk (acct_wallet_1a528118923ae8830d46f56e)
Review status: verified
Score: 88/100
Flags: none
Archive action: archive_hot
Reviewer note: Runnable source and captured output demonstrate the ledger path.
Recommended next action: No contributor action required; the submission is ready to archive as verified.
Generated by: @grashnuk

---

**task_mock_unverified_docker_overlay** - contributor follow-up
Recipient: @gmoney (acct_oauth_31a2b120878c91e24add9ceb)
Review status: unverifiable
Score: 60/100
Flags: missing_public_artifact
Archive action: needs_followup
Reviewer note: Needs the docker-compose artifact and startup log before another agent can reuse it.
Recommended next action: Add the missing public artifact or a command/output pair that proves the claimed work.
Generated by: @grashnuk
```

## Feedback Summary

```json
{
  "ok": true,
  "schema": "pf.orc.contributor_feedback_messages.v1",
  "generatedAt": "2026-06-20T02:06:23.438Z",
  "unnotifiedRecords": 5,
  "hivePayloads": 5,
  "discordMessages": 5,
  "byStatus": {
    "verified": 2,
    "unverified": 2,
    "self_attested": 1
  },
  "flags": {
    "missing_public_artifact": 2,
    "pipeline_adjacent": 1,
    "self_attested_evidence": 1,
    "money_sensitive": 1,
    "do_not_operationalize": 1
  },
  "taskIds": [
    "task_mock_verified_reward_visibility",
    "task_mock_unverifiable_parser",
    "task_mock_self_attested_contagion",
    "task_mock_verified_ledger",
    "task_mock_unverified_docker_overlay"
  ]
}
```

## Help Output

```text
Usage:
  node scripts/orc-review-pipeline-orchestrator.mjs run --input <mock-submissions.json> --out <dir> [--generated-by <handle>]

Runs a local Orc review pipeline:
  1. Parse mock network-task submissions into review verdicts.
  2. Record verdicts in a submitted-work review ledger.
  3. Generate Hive Chat JSON payloads and Discord-ready contributor messages.
  4. Write a JSON pipeline report.

This script is read-only with respect to Task Node. It does not send messages, apply enforcement, sign payments, or mutate live task state.
```
