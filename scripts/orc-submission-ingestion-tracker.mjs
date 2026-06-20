#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LEDGER_SCHEMA = "pf.orc.submission_ingestion_accounting_ledger.v1";
const DASHBOARD_SCHEMA = "pf.orc.submission_ingestion_dashboard.v1";
const FEEDBACK_SCHEMA = "pf.orc.review_feedback_delivery_payload.v1";
const SECRETARY_SCHEMA = "pf.hive_secretary.context_update.v1";
const STATES = ["pending", "in_review", "reviewed", "accounted_for", "failed"];
const STAGES = ["ingest", "review", "ledger", "feedback", "delivery", "secretary_update"];
const TERMINAL_STATES = new Set(["accounted_for", "failed"]);

function usage() {
  return `Usage:
  node scripts/orc-submission-ingestion-tracker.mjs run --submissions <file> --ledger <file> --out <dir> [--generated-by grashnuk] [--generated-at ISO]
  node scripts/orc-submission-ingestion-tracker.mjs catch-up --submissions <file> --ledger <file> --out <dir> [--generated-by grashnuk] [--generated-at ISO]
  node scripts/orc-submission-ingestion-tracker.mjs dashboard --ledger <file> --out <dir> [--generated-by grashnuk] [--generated-at ISO]

Commands:
  run       Process every submission packet into a fresh accounting pass.
  catch-up  Process only submissions missing from the ledger or not yet terminal.
  dashboard Write status dashboard and summary artifacts from the current ledger.

Outputs:
  accounting_ledger.json
  status_dashboard.json
  feedback_delivery_payloads.json
  hive_secretary_context_updates.json
  discord_summary.md

This is an offline accounting tracker. It does not sign, submit, move funds, send Hive messages, or execute enforcement.`;
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
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeKey(value, fallback = "unknown") {
  const normalized = safeText(value)
    .toLowerCase()
    .replace(/^@/, "")
    .replaceAll(/[^a-z0-9_ -]/g, "")
    .replaceAll(/[ -]+/g, "_");
  return normalized || fallback;
}

function stableId(value, prefix = "id") {
  const digest = createHash("sha256").update(safeText(value, 4000)).digest("hex").slice(0, 16);
  return `${prefix}_${digest}`;
}

async function readJson(filePath) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readLedger(filePath) {
  if (!existsSync(filePath)) {
    return {
      schema: LEDGER_SCHEMA,
      createdAt: "",
      updatedAt: "",
      records: [],
      runs: [],
    };
  }
  const ledger = await readJson(filePath);
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.records)) {
    throw new Error("Ledger must be a JSON object with records[]");
  }
  return {
    schema: safeText(ledger.schema || LEDGER_SCHEMA),
    createdAt: safeText(ledger.createdAt),
    updatedAt: safeText(ledger.updatedAt),
    records: ledger.records,
    runs: asArray(ledger.runs),
  };
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeSubmissions(raw) {
  const rows = asArray(raw.submissions || raw.items || raw.records || raw);
  if (!rows.length) throw new Error("Submissions input must contain submissions[]/items[]/records[]");
  return rows.map((row, index) => normalizeSubmission(row, index));
}

function normalizeSubmission(row, index) {
  const submissionId = safeText(row.submissionId || row.id || row.evidenceId || `submission_${index + 1}`, 160);
  const taskId = safeText(row.taskId || row.task_id, 180);
  const review = row.review && typeof row.review === "object" ? row.review : {};
  return {
    sourceIndex: index,
    submissionId,
    taskId,
    title: safeText(row.title || row.taskTitle, 300),
    project: safeText(row.project || row.networkProject || "task_node_core_product", 180),
    rewardPft: safeNumber(row.rewardPft ?? row.reward ?? row.pft, 0),
    submittedAt: safeText(row.submittedAt || row.createdAt),
    contributor: {
      handle: safeText(row.contributor?.handle || row.submitterHandle || row.handle, 120).replace(/^@/, ""),
      accountId: safeText(row.contributor?.accountId || row.accountId || row.submitterAccountId, 180),
      walletAddress: safeText(row.contributor?.walletAddress || row.walletAddress || row.submitterWallet, 180),
    },
    evidence: {
      cid: safeText(row.evidence?.cid || row.evidenceCid || row.cid, 180),
      txHash: safeText(row.evidence?.txHash || row.evidenceTxHash || row.txHash, 180),
      summary: safeText(row.evidence?.summary || row.summary, 1200),
      artifacts: asArray(row.evidence?.artifacts || row.artifacts).map((artifact) => safeText(artifact, 300)),
    },
    review: {
      status: normalizeKey(review.status || row.reviewStatus || "verified"),
      disposition: normalizeKey(review.disposition || row.disposition || "reviewed_no_action"),
      category: normalizeKey(review.category || row.category || "uncategorized"),
      score: safeNumber(review.score ?? row.score, null),
      actionOwner: normalizeKey(review.actionOwner || row.actionOwner || "none"),
      recommendedAction: safeText(review.recommendedAction || row.recommendedAction || "No action required.", 1200),
      integritySignals: asArray(review.integritySignals || row.integritySignals || row.flags)
        .map((signal) => normalizeKey(signal, ""))
        .filter(Boolean),
      reviewer: safeText(review.reviewer || row.reviewer || "grashnuk", 120).replace(/^@/, ""),
    },
  };
}

function recordKey(submission) {
  return submission.taskId || submission.submissionId || `index_${submission.sourceIndex}`;
}

function validateSubmission(submission) {
  const errors = [];
  if (!submission.submissionId) errors.push("missing_submission_id");
  if (!submission.taskId) errors.push("missing_task_id");
  if (!submission.contributor.handle && !submission.contributor.walletAddress && !submission.contributor.accountId) {
    errors.push("missing_contributor_identity");
  }
  if (!submission.evidence.cid && !submission.evidence.txHash && !submission.evidence.summary) {
    errors.push("missing_evidence_reference");
  }
  return errors;
}

function stage(status, at, details = {}) {
  return {
    status,
    startedAt: at,
    completedAt: status === "completed" || status === "failed" ? at : "",
    details,
  };
}

function stateTransition(state, at, reason) {
  return { state, at, reason };
}

function feedbackPayload(submission, runId, generatedAt) {
  const needsAction = submission.review.disposition !== "reviewed_no_action";
  return {
    schema: FEEDBACK_SCHEMA,
    payloadId: stableId(`${runId}:${submission.taskId}:feedback`, "feedback"),
    generatedAt,
    deliveryMode: "mock",
    target: {
      channel: "hive_followup",
      recipientHandle: submission.contributor.handle,
      recipientAccountId: submission.contributor.accountId,
      recipientWalletAddress: submission.contributor.walletAddress,
    },
    message: {
      subject: `Review accounting for ${submission.taskId}`,
      body: needsAction
        ? `Your rewarded task ${submission.taskId} was reviewed and routed for follow-up: ${submission.review.recommendedAction}`
        : `Your rewarded task ${submission.taskId} was reviewed and accounted for. No follow-up is currently required.`,
    },
    source: {
      taskId: submission.taskId,
      submissionId: submission.submissionId,
      evidenceCid: submission.evidence.cid,
      evidenceTxHash: submission.evidence.txHash,
    },
    safety: {
      signed: false,
      deliveredLive: false,
      enforcementAllowed: false,
    },
  };
}

function secretaryUpdatePayload(submission, runId, generatedAt) {
  const needsAction = submission.review.disposition !== "reviewed_no_action";
  return {
    schema: SECRETARY_SCHEMA,
    updateId: stableId(`${runId}:${submission.taskId}:secretary`, "hivesecretary"),
    generatedAt,
    generatedBy: submission.review.reviewer,
    target: {
      service: "hive_secretary",
      operation: "append_context_update",
      channel: needsAction ? "submission_ingestion_follow_up" : "submission_ingestion_accounting",
    },
    source: {
      trackerSchema: LEDGER_SCHEMA,
      taskId: submission.taskId,
      submissionId: submission.submissionId,
      evidenceCid: submission.evidence.cid,
      evidenceTxHash: submission.evidence.txHash,
    },
    subject: {
      contributor: submission.contributor,
      taskTitle: submission.title,
      rewardPft: submission.rewardPft,
    },
    review: {
      status: submission.review.status,
      disposition: submission.review.disposition,
      category: submission.review.category,
      score: submission.review.score,
      integritySignals: submission.review.integritySignals,
    },
    action: {
      required: needsAction,
      owner: needsAction ? submission.review.actionOwner : "none",
      recommendedAction: needsAction ? submission.review.recommendedAction : "No action required.",
      enforcementAllowed: false,
    },
    contextUpdate: {
      title: `Submission accounted: ${submission.taskId}`,
      body: [
        `Submission ${submission.submissionId} for task ${submission.taskId} reached accounted_for.`,
        `Contributor: ${submission.contributor.handle || submission.contributor.walletAddress || "unknown"}.`,
        `Review disposition: ${submission.review.disposition}.`,
        needsAction ? `Recommended action: ${submission.review.recommendedAction}` : "No follow-up is required.",
      ].join("\n"),
      tags: ["orc_submission_ingestion", submission.review.disposition, submission.review.category],
      visibility: "operator_internal",
      status: "ready_for_hive_secretary",
    },
  };
}

function failedRecord(submission, existing, generatedAt, runId, errors) {
  const recordId = existing?.recordId || stableId(recordKey(submission), "ingest");
  return {
    schema: LEDGER_SCHEMA,
    recordId,
    submissionId: submission.submissionId,
    taskId: submission.taskId,
    title: submission.title,
    project: submission.project,
    state: "failed",
    previousState: existing?.state || "",
    createdAt: existing?.createdAt || generatedAt,
    updatedAt: generatedAt,
    lastRunId: runId,
    contributor: submission.contributor,
    evidence: submission.evidence,
    review: submission.review,
    accounting: {
      rewardPft: submission.rewardPft,
      accountedAt: "",
      ledgerRecordKey: "",
      failureReasons: errors,
    },
    stateHistory: [
      ...asArray(existing?.stateHistory),
      stateTransition("failed", generatedAt, errors.join(",")),
    ],
    stages: {
      ingest: stage("failed", generatedAt, { errors }),
      review: stage("skipped", generatedAt, {}),
      ledger: stage("skipped", generatedAt, {}),
      feedback: stage("skipped", generatedAt, {}),
      delivery: stage("skipped", generatedAt, {}),
      secretary_update: stage("skipped", generatedAt, {}),
    },
    feedbackPayload: null,
    secretaryUpdatePayload: null,
  };
}

function processedRecord(submission, existing, generatedAt, runId) {
  const recordId = existing?.recordId || stableId(recordKey(submission), "ingest");
  const ledgerRecordKey = stableId(`${submission.taskId}:${submission.submissionId}:${submission.rewardPft}`, "acct");
  const feedback = feedbackPayload(submission, runId, generatedAt);
  const secretary = secretaryUpdatePayload(submission, runId, generatedAt);
  return {
    schema: LEDGER_SCHEMA,
    recordId,
    submissionId: submission.submissionId,
    taskId: submission.taskId,
    title: submission.title,
    project: submission.project,
    state: "accounted_for",
    previousState: existing?.state || "",
    createdAt: existing?.createdAt || generatedAt,
    updatedAt: generatedAt,
    lastRunId: runId,
    contributor: submission.contributor,
    evidence: submission.evidence,
    review: submission.review,
    accounting: {
      rewardPft: submission.rewardPft,
      accountedAt: generatedAt,
      ledgerRecordKey,
      accountedBy: submission.review.reviewer,
      outcome: submission.review.disposition,
    },
    stateHistory: [
      ...asArray(existing?.stateHistory),
      stateTransition("pending", generatedAt, "submission_ingested"),
      stateTransition("in_review", generatedAt, "review_packet_attached"),
      stateTransition("reviewed", generatedAt, "review_outcome_normalized"),
      stateTransition("accounted_for", generatedAt, "feedback_and_secretary_payloads_prepared"),
    ],
    stages: {
      ingest: stage("completed", generatedAt, {
        sourceSubmissionId: submission.submissionId,
        evidenceReferencePresent: Boolean(submission.evidence.cid || submission.evidence.txHash || submission.evidence.summary),
      }),
      review: stage("completed", generatedAt, {
        reviewer: submission.review.reviewer,
        status: submission.review.status,
        disposition: submission.review.disposition,
        score: submission.review.score,
      }),
      ledger: stage("completed", generatedAt, {
        ledgerRecordKey,
        rewardPft: submission.rewardPft,
        state: "accounted_for",
      }),
      feedback: stage("completed", generatedAt, {
        payloadId: feedback.payloadId,
        channel: feedback.target.channel,
      }),
      delivery: stage("completed", generatedAt, {
        deliveryMode: "mock",
        deliveredLive: false,
        payloadId: feedback.payloadId,
      }),
      secretary_update: stage("completed", generatedAt, {
        updateId: secretary.updateId,
        channel: secretary.target.channel,
      }),
    },
    feedbackPayload: feedback,
    secretaryUpdatePayload: secretary,
  };
}

function countBy(rows, finder) {
  const counts = {};
  for (const row of rows) {
    const key = finder(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function buildDashboard({ ledger, run, generatedAt, generatedBy }) {
  const records = asArray(ledger.records);
  const feedbackReady = records.filter((record) => record.feedbackPayload && record.state === "accounted_for");
  const secretaryReady = records.filter((record) => record.secretaryUpdatePayload && record.state === "accounted_for");
  const stageCounts = {};
  for (const stageName of STAGES) {
    stageCounts[stageName] = countBy(records, (record) => record.stages?.[stageName]?.status || "missing");
  }
  return {
    schema: DASHBOARD_SCHEMA,
    generatedAt,
    generatedBy,
    ledgerSchema: ledger.schema,
    run: run || null,
    summary: {
      totalRecords: records.length,
      supportedStates: STATES,
      byState: countBy(records, (record) => record.state || "unknown"),
      processedThisRun: run?.processedCount || 0,
      skippedTerminalThisRun: run?.skippedTerminalCount || 0,
      failedThisRun: run?.failedCount || 0,
      feedbackPayloadsReady: feedbackReady.length,
      secretaryUpdatesReady: secretaryReady.length,
      accountedRewardPft: records
        .filter((record) => record.state === "accounted_for")
        .reduce((total, record) => total + safeNumber(record.accounting?.rewardPft, 0), 0),
      stageCounts,
    },
    records: records.map((record) => ({
      recordId: record.recordId,
      submissionId: record.submissionId,
      taskId: record.taskId,
      title: record.title,
      contributor: record.contributor,
      state: record.state,
      rewardPft: record.accounting?.rewardPft || 0,
      reviewDisposition: record.review?.disposition || "unknown",
      actionOwner: record.review?.actionOwner || "none",
      lastRunId: record.lastRunId,
      updatedAt: record.updatedAt,
      stageStatus: Object.fromEntries(STAGES.map((stageName) => [stageName, record.stages?.[stageName]?.status || "missing"])),
    })),
  };
}

function discordSummary(dashboard) {
  const lines = [
    "@goodalexander Submission ingestion accounting tracker run complete.",
    "",
    `Records in ledger: ${dashboard.summary.totalRecords}`,
    `Processed this run: ${dashboard.summary.processedThisRun}`,
    `Skipped already-terminal: ${dashboard.summary.skippedTerminalThisRun}`,
    `Failed this run: ${dashboard.summary.failedThisRun}`,
    `Accounted reward total: ${dashboard.summary.accountedRewardPft} PFT`,
    `Feedback payloads ready: ${dashboard.summary.feedbackPayloadsReady}`,
    `Hive Secretary updates ready: ${dashboard.summary.secretaryUpdatesReady}`,
    "",
    "State counts:",
  ];
  for (const [stateName, count] of Object.entries(dashboard.summary.byState)) {
    lines.push(`- ${stateName}: ${count}`);
  }
  lines.push("", "Sample accounted submissions:");
  for (const record of dashboard.records.filter((item) => item.state === "accounted_for").slice(0, 5)) {
    lines.push(`- ${record.taskId}: ${record.reviewDisposition} -> ${record.actionOwner}`);
  }
  lines.push(
    "",
    "Generated artifacts:",
    "- accounting_ledger.json",
    "- status_dashboard.json",
    "- feedback_delivery_payloads.json",
    "- hive_secretary_context_updates.json",
    "- discord_summary.md"
  );
  return `${lines.join("\n")}\n`;
}

async function writeOutputs({ outDir, ledgerPath, ledger, dashboard }) {
  const feedbackPayloads = ledger.records
    .map((record) => record.feedbackPayload)
    .filter(Boolean);
  const secretaryUpdates = ledger.records
    .map((record) => record.secretaryUpdatePayload)
    .filter(Boolean);
  await mkdir(outDir, { recursive: true });
  await writeJson(ledgerPath, ledger);
  await writeJson(path.join(outDir, "accounting_ledger.json"), ledger);
  await writeJson(path.join(outDir, "status_dashboard.json"), dashboard);
  await writeJson(path.join(outDir, "feedback_delivery_payloads.json"), feedbackPayloads);
  await writeJson(path.join(outDir, "hive_secretary_context_updates.json"), secretaryUpdates);
  await writeFile(path.join(outDir, "discord_summary.md"), discordSummary(dashboard), "utf8");
}

function buildRun({ command, submissions, ledger, generatedAt, generatedBy }) {
  const runId = stableId(`${command}:${generatedBy}:${generatedAt}:${submissions.length}`, "ingestion_run");
  const existingByKey = new Map(ledger.records.map((record) => [record.taskId || record.submissionId, record]));
  const nextRecordsByKey = new Map(existingByKey);
  let processedCount = 0;
  let skippedTerminalCount = 0;
  let failedCount = 0;

  for (const submission of submissions) {
    const key = recordKey(submission);
    const existing = existingByKey.get(key);
    if (command === "catch-up" && existing && TERMINAL_STATES.has(existing.state)) {
      skippedTerminalCount += 1;
      continue;
    }
    const errors = validateSubmission(submission);
    const nextRecord = errors.length
      ? failedRecord(submission, existing, generatedAt, runId, errors)
      : processedRecord(submission, existing, generatedAt, runId);
    nextRecordsByKey.set(key, nextRecord);
    processedCount += 1;
    if (nextRecord.state === "failed") failedCount += 1;
  }

  const records = [...nextRecordsByKey.values()].sort((left, right) =>
    String(left.taskId || left.submissionId).localeCompare(String(right.taskId || right.submissionId))
  );
  const run = {
    runId,
    command,
    generatedAt,
    generatedBy,
    sourceSubmissionCount: submissions.length,
    processedCount,
    skippedTerminalCount,
    failedCount,
  };
  return {
    ledger: {
      schema: LEDGER_SCHEMA,
      createdAt: ledger.createdAt || generatedAt,
      updatedAt: generatedAt,
      records,
      runs: [...asArray(ledger.runs), run],
    },
    run,
  };
}

async function execute(command, options) {
  const outDir = requireOption(options, "out");
  const ledgerPath = requireOption(options, "ledger");
  const generatedAt = safeText(options["generated-at"] || new Date().toISOString(), 80);
  const generatedBy = safeText(options["generated-by"] || "grashnuk", 120).replace(/^@/, "");

  let ledger = await readLedger(ledgerPath);
  let run = null;
  if (command !== "dashboard") {
    const submissions = normalizeSubmissions(await readJson(requireOption(options, "submissions")));
    const result = buildRun({ command, submissions, ledger, generatedAt, generatedBy });
    ledger = result.ledger;
    run = result.run;
  }
  const dashboard = buildDashboard({ ledger, run, generatedAt, generatedBy });
  await writeOutputs({ outDir, ledgerPath, ledger, dashboard });
  return {
    ok: true,
    schema: command === "dashboard" ? DASHBOARD_SCHEMA : LEDGER_SCHEMA,
    command,
    run,
    ledgerPath,
    outDir,
    summary: dashboard.summary,
    files: [
      "accounting_ledger.json",
      "status_dashboard.json",
      "feedback_delivery_payloads.json",
      "hive_secretary_context_updates.json",
      "discord_summary.md",
    ],
    safety: {
      signed: false,
      submittedLive: false,
      movedFunds: false,
      enforcementAllowed: false,
    },
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h" || options.help || options.h) {
    console.log(usage());
    return;
  }
  if (!["run", "catch-up", "dashboard"].includes(command)) throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(await execute(command, options), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
