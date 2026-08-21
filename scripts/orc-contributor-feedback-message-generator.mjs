#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const OUTPUT_SCHEMA = "pf.orc.contributor_feedback_messages.v1";
const VALID_STATUSES = new Set(["verified", "unverified", "unverifiable", "self_attested"]);

function usage() {
  return `Usage:
  node scripts/orc-contributor-feedback-message-generator.mjs batch --ledger <file> --out <dir> [--generated-by <handle>]
  node scripts/orc-contributor-feedback-message-generator.mjs generate --ledger <file> [--generated-by <handle>]

Commands:
  batch     Write hive_payloads.json, discord_messages.md, and summary.json for unnotified records.
  generate  Print generated payloads to stdout without writing files.

The ledger must contain records[] compatible with pf.orc.submitted_work_review_ledger.v1.
Unnotified records are entries without notification.notifiedAt, notification.sentAt, or notifiedAt.`;
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
    if (options[key] === undefined) options[key] = next;
    else if (Array.isArray(options[key])) options[key].push(next);
    else options[key] = [options[key], next];
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
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeHandle(value) {
  const handle = safeText(value).replace(/^@/, "");
  return handle ? `@${handle}` : "@contributor";
}

function normalizeStatus(value) {
  const status = safeText(value).toLowerCase().replaceAll("-", "_");
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid review status: ${value}`);
  return status;
}

function displayStatus(status) {
  if (status === "self_attested") return "self-attested";
  if (status === "unverified") return "unverifiable";
  return status;
}

function findRecipientAccountId(record) {
  return safeText(
    record.recipientAccountId ||
      record.accountId ||
      record.assigneeAccountId ||
      record.recipient?.accountId ||
      record.contributor?.accountId
  );
}

function findRecipientHandle(record) {
  return normalizeHandle(
    record.recipientHandle ||
      record.assigneeHandle ||
      record.recipient?.handle ||
      record.contributor?.handle ||
      record.reviewer
  );
}

function isUnnotified(record) {
  return !(
    record.notifiedAt ||
    record.notification?.notifiedAt ||
    record.notification?.sentAt ||
    record.notification?.hiveMessageId ||
    record.notification?.discordMessageId
  );
}

function extractParser(record) {
  return record.parserOutput && typeof record.parserOutput === "object" ? record.parserOutput : {};
}

function findRecommendedAction(record) {
  const parser = extractParser(record);
  const explicit = safeText(
    record.recommendedAction ||
      record.nextAction ||
      parser.recommendedAction ||
      parser.nextAction ||
      parser.rewardRecommendation
  );
  if (explicit) return explicit;
  const status = normalizeStatus(record.reviewStatus);
  const archiveAction = safeText(record.archiveAction || parser.archivalInstructions).toLowerCase();
  if (status === "verified") return "No action required. Your submitted work was reviewed as verified.";
  if (archiveAction === "needs_followup") {
    return "Please provide the missing artifact, command output, screenshot, or source pointer requested by the reviewer.";
  }
  if (archiveAction === "reject") {
    return "Submit replacement evidence before this work should be counted further.";
  }
  if (archiveAction === "hold") {
    return "Wait for a reviewer or core-team decision before this work is operationalized.";
  }
  return "Add independently inspectable evidence so the work can be verified without relying only on self-attested text.";
}

function formatFlags(flags) {
  const values = asArray(flags).map((flag) => safeText(flag)).filter(Boolean);
  return values.length ? values.join(", ") : "none";
}

function buildHiveBody(record) {
  const status = normalizeStatus(record.reviewStatus);
  const flags = asArray(record.reviewFlags);
  const score = Number(record.score ?? 0);
  const taskId = safeText(record.taskId, "unknown task");
  const action = findRecommendedAction(record);
  return [
    `${findRecipientHandle(record)} - I am following up on reviewed Network Task ${taskId}.`,
    `Review status: ${displayStatus(status)}.`,
    `Score: ${Number.isFinite(score) ? score : 0}/100.`,
    `Flags: ${formatFlags(flags)}.`,
    `Next action: ${action}`,
  ].join("\n");
}

function buildHivePayload(record, generatedBy) {
  const status = normalizeStatus(record.reviewStatus);
  const recipientAccountId = findRecipientAccountId(record);
  const taskId = safeText(record.taskId);
  return {
    recipientAccountId,
    messageBody: buildHiveBody(record),
    metadata: {
      schema: OUTPUT_SCHEMA,
      deliverySurface: "hive_chat",
      generatedBy,
      sourceReviewId: safeText(record.id),
      sourceTaskId: taskId,
      reviewStatus: status,
      score: Number(record.score ?? 0),
      reviewFlags: asArray(record.reviewFlags).map((flag) => safeText(flag)).filter(Boolean),
      archiveAction: safeText(record.archiveAction),
      requiresContributorAction: status !== "verified" || safeText(record.archiveAction) === "needs_followup",
    },
  };
}

function buildDiscordMessage(record, generatedBy) {
  const parser = extractParser(record);
  const status = normalizeStatus(record.reviewStatus);
  const taskId = safeText(record.taskId, "unknown task");
  const score = Number(record.score ?? 0);
  const flags = formatFlags(record.reviewFlags);
  const action = findRecommendedAction(record);
  const reviewerNotes = safeText(parser.reviewerNotes || record.notes);
  const lines = [
    `**${taskId}** - contributor follow-up`,
    `Recipient: ${findRecipientHandle(record)} (${findRecipientAccountId(record) || "account unresolved"})`,
    `Review status: ${displayStatus(status)}`,
    `Score: ${Number.isFinite(score) ? score : 0}/100`,
    `Flags: ${flags}`,
    `Archive action: ${safeText(record.archiveAction, "none")}`,
    `Recommended next action: ${action}`,
    `Generated by: ${normalizeHandle(generatedBy)}`,
  ];
  if (reviewerNotes) lines.splice(6, 0, `Reviewer note: ${reviewerNotes}`);
  return lines.join("\n");
}

function summarize(records, hiveChatPayloads, discordMessages) {
  const byStatus = {};
  const flags = {};
  for (const record of records) {
    const status = normalizeStatus(record.reviewStatus);
    byStatus[status] = (byStatus[status] || 0) + 1;
    for (const flag of asArray(record.reviewFlags)) {
      const key = safeText(flag);
      if (key) flags[key] = (flags[key] || 0) + 1;
    }
  }
  return {
    ok: true,
    schema: OUTPUT_SCHEMA,
    generatedAt: new Date().toISOString(),
    unnotifiedRecords: records.length,
    hivePayloads: hiveChatPayloads.length,
    discordMessages: discordMessages.length,
    byStatus,
    flags,
    taskIds: records.map((record) => safeText(record.taskId)).filter(Boolean),
  };
}

async function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) throw new Error(`Ledger not found: ${ledgerPath}`);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.records)) {
    throw new Error("Ledger must be a JSON object with records[]");
  }
  return ledger;
}

function buildOutput(ledger, options) {
  const generatedBy = safeText(options["generated-by"], "grashnuk").replace(/^@/, "");
  const records = ledger.records.filter(isUnnotified);
  const hiveChatPayloads = records.map((record) => buildHivePayload(record, generatedBy));
  const discordMessages = records.map((record) => ({
    taskId: safeText(record.taskId),
    recipientAccountId: findRecipientAccountId(record),
    recipientHandle: findRecipientHandle(record),
    message: buildDiscordMessage(record, generatedBy),
  }));
  const summary = summarize(records, hiveChatPayloads, discordMessages);
  return {
    ok: true,
    schema: OUTPUT_SCHEMA,
    sourceLedgerSchema: safeText(ledger.schema, "unknown"),
    generatedBy,
    summary,
    hiveChatPayloads,
    discordMessages,
  };
}

async function writeBatch(output, outDir) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "hive_payloads.json"), `${JSON.stringify(output.hiveChatPayloads, null, 2)}\n`);
  await writeFile(
    path.join(outDir, "discord_messages.md"),
    `${output.discordMessages.map((entry) => entry.message).join("\n\n---\n\n")}\n`
  );
  await writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(output.summary, null, 2)}\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (!["batch", "generate"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const ledgerPath = requireOption(options, "ledger");
  const ledger = await readLedger(ledgerPath);
  const output = buildOutput(ledger, options);
  if (command === "batch") {
    const outDir = requireOption(options, "out");
    await writeBatch(output, outDir);
    console.log(JSON.stringify({ ...output.summary, outputDir: outDir }, null, 2));
    return;
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
