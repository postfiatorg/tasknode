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
