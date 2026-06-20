#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UPDATE_SCHEMA = "pf.hive_secretary.context_update.v1";
const BATCH_SCHEMA = "pf.hive_secretary.context_update_batch.v1";

function usage() {
  return `Usage:
  node scripts/orc-hive-secretary-context-converter.mjs batch --ledger <review_ledger.json> --digest <action_digest.json> --out <dir> [--generated-by grashnuk] [--generated-at ISO]
  node scripts/orc-hive-secretary-context-converter.mjs single --ledger <review_ledger.json> --digest <action_digest.json> --review-id <id> --out <dir> [--generated-by grashnuk] [--generated-at ISO]

Converts Orc review-ledger records plus Orc review action digest rows into Hive Secretary context-update payloads.

Outputs:
  batch:  hive_secretary_batch_payload.json, hive_secretary_context_updates.json, discord_summary.md
  single: hive_secretary_single_update.json, discord_summary.md

This script prepares payloads only. It does not submit to Hive Secretary, sign transactions, move funds, or apply enforcement.`;
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

function normalizeKey(value, fallback = "uncategorized") {
  const normalized = safeText(value)
    .toLowerCase()
    .replace(/^@/, "")
    .replaceAll(/[^a-z0-9_ -]/g, "")
    .replaceAll(/[ -]+/g, "_");
  return normalized || fallback;
}

async function readJson(filePath) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeLedger(raw) {
  const records = asArray(raw.records || raw.reviews || raw.items);
  if (!records.length) throw new Error("Review ledger must contain records[]/reviews[]/items[]");
  return {
    schema: safeText(raw.schema || "pf.orc.submitted_work_review_ledger.v1"),
    source: raw.source || {},
    records,
  };
}

function normalizeDigest(raw) {
  const digest = raw.digest && typeof raw.digest === "object" ? raw.digest : raw;
  const items = [
    ...asArray(digest.highestPriorityItems),
    ...asArray(digest.actionItems),
    ...asArray(digest.items),
    ...asArray(digest.tasks),
  ];
  const byTaskId = new Map();
  for (const item of items) {
    const taskId = safeText(item.taskId, 180);
    if (!taskId || byTaskId.has(taskId)) continue;
    byTaskId.set(taskId, item);
  }
  return {
    schema: safeText(digest.schema || raw.schema || "pf.orc.review_action_digest.v1"),
    counts: digest.counts || {},
    routingPacketFiles: asArray(digest.routingPacketFiles),
    byTaskId,
  };
}

function contributor(record) {
  return {
    handle: safeText(record.recipientHandle || record.assigneeHandle || record.contributor?.handle, 120).replace(/^@/, ""),
    accountId: safeText(record.recipientAccountId || record.assigneeAccountId || record.contributor?.accountId, 180),
    walletAddress: safeText(record.walletAddress || record.assigneeWallet || record.contributor?.walletAddress, 180),
  };
}

function dispositionState(record) {
  const disposition = normalizeKey(record.disposition || record.reviewDisposition || record.routing?.disposition, "reviewed_unclear");
  if (disposition.includes("negative")) return "reviewed_negative_follow_up";
  if (disposition.includes("integrity")) return "reviewed_integrity_follow_up";
  if (disposition.includes("follow_up")) return "reviewed_follow_up";
  if (disposition.includes("no_action")) return "reviewed_no_action";
  if (record.actionRequired === false) return "reviewed_no_action";
  return disposition;
}

function actionRequired(record, digestItem) {
  if (record.actionRequired === true || record.requiresAction === true) return true;
  if (record.actionRequired === false || record.requiresAction === false) return false;
  const state = dispositionState(record);
  if (state === "reviewed_no_action") return false;
  if (digestItem) return true;
  return state.includes("follow_up");
}

function actionOwner(record, digestItem) {
  return normalizeKey(
    record.actionOwner ||
      record.owner ||
      record.routing?.actionOwner ||
      digestItem?.actionOwner ||
      digestItem?.owner ||
      "unassigned_owner"
  );
}

function integritySignals(record, digestItem) {
  return [
    ...asArray(record.integritySignals),
    ...asArray(record.reviewFlags),
    ...asArray(record.flags),
    ...asArray(digestItem?.integritySignals),
  ]
    .map((signal) => normalizeKey(signal, ""))
    .filter(Boolean)
    .filter((signal, index, signals) => signals.indexOf(signal) === index);
}

function recommendedAction(record, digestItem) {
  return safeText(
    record.recommendedAction ||
      record.nextAction ||
      record.routing?.recommendedAction ||
      digestItem?.recommendedAction ||
      "No action required."
  );
}

function priority(record, digestItem) {
  return Math.max(0, Math.min(100, safeNumber(record.priority ?? digestItem?.priority, actionRequired(record, digestItem) ? 60 : 10)));
}

function clawbackFlag(record, digestItem) {
  return normalizeKey(
    record.clawbackFlag ||
      record.clawbackRecommendation ||
      record.integrityPolicy?.clawbackFlag ||
      digestItem?.clawbackFlag ||
      digestItem?.integrityPolicy?.clawbackFlag ||
      "none"
  );
}

function archivalDirective(record, digestItem) {
  return normalizeKey(
    record.archivalDirective ||
      record.archiveAction ||
      record.integrityPolicy?.archivalDirective ||
      digestItem?.archivalDirective ||
      digestItem?.archiveAction ||
      digestItem?.integrityPolicy?.archivalDirective ||
      (actionRequired(record, digestItem) ? "keep_active_for_follow_up" : "archive_as_reviewed")
  );
}

function contextBody({ record, digestItem, state, required, owner, action, signals }) {
  const who = contributor(record).handle || contributor(record).walletAddress || "unknown contributor";
  const lines = [
    `Orc review ${safeText(record.id || "unknown_review")} for task ${safeText(record.taskId || "unknown_task")} is ${state}.`,
    `Contributor: ${who}.`,
    `Review status: ${safeText(record.reviewStatus || "unknown")}.`,
    `Category: ${normalizeKey(record.category || digestItem?.category, "uncategorized")}.`,
    `Action required: ${required ? "yes" : "no"}.`,
  ];
  if (required) {
    lines.push(`Action owner: ${owner}.`, `Recommended action: ${action}`);
  }
  if (signals.length) lines.push(`Integrity/routing signals: ${signals.join(", ")}.`);
  return lines.join("\n");
}

function buildUpdate({ record, digest, generatedAt, generatedBy }) {
  const digestItem = digest.byTaskId.get(safeText(record.taskId, 180));
  const state = dispositionState(record);
  const required = actionRequired(record, digestItem);
  const owner = actionOwner(record, digestItem);
  const signals = integritySignals(record, digestItem);
  const action = recommendedAction(record, digestItem);
  const category = normalizeKey(record.category || digestItem?.category, "uncategorized");
  return {
    schema: UPDATE_SCHEMA,
    updateId: `hivesecretary_${safeText(record.id || record.taskId, 160)}`,
    generatedAt,
    generatedBy,
    target: {
      service: "hive_secretary",
      operation: "append_context_update",
      channel: required ? "orc_review_follow_up" : "orc_review_accounting",
    },
    source: {
      reviewLedgerSchema: safeText(record.sourceLedgerSchema || ""),
      actionDigestSchema: digest.schema,
      reviewId: safeText(record.id, 180),
      taskId: safeText(record.taskId, 180),
      sourceCid: safeText(record.source?.cid || record.sourceCid, 180),
      sourceTxHash: safeText(record.source?.txHash || record.sourceTxHash, 180),
    },
    subject: {
      contributor: contributor(record),
      taskTitle: safeText(record.title || record.taskTitle, 300),
    },
    review: {
      status: normalizeKey(record.reviewStatus, "unknown"),
      disposition: state,
      category,
      score: safeNumber(record.score, null),
      grading: {
        score: safeNumber(record.score, null),
        scale: 100,
        source: "orc_review_ledger",
      },
      evidenceClass: normalizeKey(record.evidenceClass || record.evidenceType || record.reviewStatus, "unknown"),
      confidence: normalizeKey(record.confidence || (record.reviewStatus === "verified" ? "high" : "medium"), "unknown"),
      integritySignals: signals,
    },
    action: {
      required,
      owner: required ? owner : "none",
      priority: priority(record, digestItem),
      recommendedAction: action,
      routingPacketHint: required ? `routing_packets/${owner}.json` : "",
      integrityPolicy: {
        clawbackFlag: clawbackFlag(record, digestItem),
        archivalDirective: archivalDirective(record, digestItem),
        enforcementAllowed: false,
      },
    },
    contextUpdate: {
      title: `${state}: ${safeText(record.taskId, 180)}`,
      body: contextBody({ record, digestItem, state, required, owner, action, signals }),
      tags: ["orc_review", state, category, required ? owner : "no_action"].filter(Boolean),
      visibility: "operator_internal",
      status: "ready_for_hive_secretary",
    },
  };
}

function countBy(items, finder) {
  const counts = {};
  for (const item of items) {
    const key = finder(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function buildBatch({ ledger, digest, generatedAt, generatedBy, records }) {
  const updates = records.map((record) =>
    buildUpdate({
      record: { ...record, sourceLedgerSchema: ledger.schema },
      digest,
      generatedAt,
      generatedBy,
    })
  );
  return {
    schema: BATCH_SCHEMA,
    generatedAt,
    generatedBy,
    mode: "batch",
    source: {
      reviewLedgerSchema: ledger.schema,
      actionDigestSchema: digest.schema,
      sourceTaskIds: [
        "task_01ba5f1d70d620780c333693c99a0cab",
        "task_2ea6b10ba3e3ae2cc3c3cd7b59431ee8",
      ],
    },
    summary: {
      totalUpdates: updates.length,
      actionRequired: updates.filter((update) => update.action.required).length,
      noAction: updates.filter((update) => !update.action.required).length,
      byDisposition: countBy(updates, (update) => update.review.disposition),
      byActionOwner: countBy(updates.filter((update) => update.action.required), (update) => update.action.owner),
      byReviewStatus: countBy(updates, (update) => update.review.status),
    },
    updates,
  };
}

function discordSummary(batch, mode) {
  const lines = [
    "@goodalexander Hive Secretary context-update payloads are ready.",
    "",
    `Mode: ${mode}`,
    `Total updates: ${batch.summary.totalUpdates}`,
    `Action required: ${batch.summary.actionRequired}`,
    `No action: ${batch.summary.noAction}`,
    "",
    "Action owners:",
  ];
  for (const [owner, count] of Object.entries(batch.summary.byActionOwner)) {
    lines.push(`- ${owner}: ${count}`);
  }
  lines.push("", "Payload examples:");
  for (const update of batch.updates.slice(0, 5)) {
    lines.push(
      `- ${update.source.taskId}: ${update.review.disposition} -> ${update.action.owner} / p${update.action.priority}`
    );
  }
  const generatedFiles =
    mode === "single"
      ? ["- hive_secretary_single_update.json", "- discord_summary.md"]
      : ["- hive_secretary_batch_payload.json", "- hive_secretary_context_updates.json", "- discord_summary.md"];
  lines.push("", "Generated files:", ...generatedFiles);
  return `${lines.join("\n")}\n`;
}

async function run(command, options) {
  const ledger = normalizeLedger(await readJson(requireOption(options, "ledger")));
  const digest = normalizeDigest(await readJson(requireOption(options, "digest")));
  const outDir = requireOption(options, "out");
  const generatedAt = safeText(options["generated-at"] || new Date().toISOString(), 80);
  const generatedBy = safeText(options["generated-by"] || "grashnuk", 80).replace(/^@/, "");
  const records =
    command === "single"
      ? ledger.records.filter((record) => safeText(record.id || record.reviewId, 180) === requireOption(options, "review-id"))
      : ledger.records;
  if (command === "single" && records.length !== 1) {
    throw new Error(`Expected exactly one record for --review-id ${options["review-id"]}, found ${records.length}`);
  }
  const batch = buildBatch({ ledger, digest, generatedAt, generatedBy, records });
  await mkdir(outDir, { recursive: true });
  if (command === "single") {
    await writeJson(path.join(outDir, "hive_secretary_single_update.json"), batch.updates[0]);
  } else {
    await writeJson(path.join(outDir, "hive_secretary_batch_payload.json"), batch);
    await writeJson(path.join(outDir, "hive_secretary_context_updates.json"), batch.updates);
  }
  await writeFile(path.join(outDir, "discord_summary.md"), discordSummary(batch, command), "utf8");
  return {
    ok: true,
    schema: command === "single" ? UPDATE_SCHEMA : BATCH_SCHEMA,
    mode: command,
    outDir,
    summary: batch.summary,
    files:
      command === "single"
        ? ["hive_secretary_single_update.json", "discord_summary.md"]
        : ["hive_secretary_batch_payload.json", "hive_secretary_context_updates.json", "discord_summary.md"],
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h" || options.help || options.h) {
    console.log(usage());
    return;
  }
  if (!["batch", "single"].includes(command)) throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(await run(command, options), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
