#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";

const LEDGER_SCHEMA = "pf.orc.submitted_work_review_ledger.v1";
const VALID_STATUSES = new Set(["verified", "unverified", "self_attested"]);
const VALID_ARCHIVE_ACTIONS = new Set([
  "archive_hot",
  "archive_cold",
  "needs_followup",
  "reject",
  "hold",
]);

function usage() {
  return `Usage:
  node scripts/orc-submitted-work-review-ledger.mjs add --ledger <file> --task-id <id> --reviewer <handle> --status <verified|unverified|self_attested> --score <0-100> --archive-action <action> [--flag <flag>] [--note <text>]
  node scripts/orc-submitted-work-review-ledger.mjs query --ledger <file> (--task-id <id> | --reviewer <handle>)
  node scripts/orc-submitted-work-review-ledger.mjs list --ledger <file> [--status <status>] [--flag <flag>]
  node scripts/orc-submitted-work-review-ledger.mjs report --ledger <file>

Statuses: ${[...VALID_STATUSES].join(", ")}
Archive actions: ${[...VALID_ARCHIVE_ACTIONS].join(", ")}`;
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
    if (options[key] === undefined) {
      options[key] = next;
    } else if (Array.isArray(options[key])) {
      options[key].push(next);
    } else {
      options[key] = [options[key], next];
    }
  }
  return { command, options };
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (!VALID_STATUSES.has(normalized)) {
    throw new Error(`Invalid review status: ${value}`);
  }
  return normalized;
}

function normalizeArchiveAction(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (!VALID_ARCHIVE_ACTIONS.has(normalized)) {
    throw new Error(`Invalid archive action: ${value}`);
  }
  return normalized;
}

function normalizeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`Score must be a number from 0 to 100: ${value}`);
  }
  return Number(score.toFixed(2));
}

function stableHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 20);
}

function nowIso() {
  return new Date().toISOString();
}

function blankLedger() {
  return {
    schema: LEDGER_SCHEMA,
    updatedAt: nowIso(),
    records: [],
  };
}

async function readLedger(path) {
  if (!path) throw new Error("--ledger is required");
  if (!existsSync(path)) return blankLedger();
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Ledger must be a JSON object");
  if (!Array.isArray(parsed.records)) throw new Error("Ledger must contain records[]");
  if (!parsed.schema) parsed.schema = LEDGER_SCHEMA;
  return parsed;
}

async function writeLedger(path, ledger) {
  ledger.schema = LEDGER_SCHEMA;
  ledger.updatedAt = nowIso();
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function buildRecord(options) {
  const taskId = requireOption(options, "task-id");
  const reviewer = requireOption(options, "reviewer").replace(/^@/, "");
  const reviewStatus = normalizeStatus(requireOption(options, "status"));
  const score = normalizeScore(requireOption(options, "score"));
  const archiveAction = normalizeArchiveAction(requireOption(options, "archive-action"));
  const reviewFlags = asArray(options.flag).map((flag) =>
    String(flag).trim().toLowerCase().replaceAll(" ", "_")
  ).filter(Boolean);
  const timestamp = options.timestamp ? new Date(String(options.timestamp)).toISOString() : nowIso();
  const reviewerNotes = String(options.note || "").trim();
  const sourceCid = String(options["source-cid"] || "").trim();
  const sourceTxHash = String(options["source-tx-hash"] || "").trim();
  const rewardRecommendation = String(options["reward-recommendation"] || "").trim();
  const taskGrade = String(options["task-grade"] || "").trim();
  const id = `swrev_${stableHash(`${taskId}|${reviewer}|${timestamp}|${reviewStatus}`)}`;
  return {
    id,
    taskId,
    reviewer,
    reviewStatus,
    score,
    reviewFlags,
    archiveAction,
    timestamp,
    source: {
      cid: sourceCid,
      txHash: sourceTxHash,
    },
    parserOutput: {
      taskGrade,
      rewardRecommendation,
      flagIndicators: reviewFlags,
      archivalInstructions: archiveAction,
      reviewerNotes,
    },
  };
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    const timeCompare = String(left.timestamp || "").localeCompare(String(right.timestamp || ""));
    if (timeCompare !== 0) return timeCompare;
    return String(left.taskId || "").localeCompare(String(right.taskId || ""));
  });
}

async function addRecord(options) {
  const ledger = await readLedger(options.ledger);
  const record = buildRecord(options);
  const existingIndex = ledger.records.findIndex((entry) => entry.id === record.id);
  if (existingIndex >= 0) {
    ledger.records[existingIndex] = record;
  } else {
    ledger.records.push(record);
  }
  ledger.records = sortRecords(ledger.records);
  await writeLedger(options.ledger, ledger);
  return {
    ok: true,
    operation: "add",
    ledger: options.ledger,
    inserted: existingIndex < 0,
    record,
  };
}

async function queryLedger(options) {
  const ledger = await readLedger(options.ledger);
  const taskId = options["task-id"] ? String(options["task-id"]) : "";
  const reviewer = options.reviewer ? String(options.reviewer).replace(/^@/, "") : "";
  if (!taskId && !reviewer) throw new Error("query requires --task-id or --reviewer");
  const records = sortRecords(ledger.records).filter((entry) => {
    if (taskId && entry.taskId !== taskId) return false;
    if (reviewer && entry.reviewer !== reviewer) return false;
    return true;
  });
  return {
    ok: true,
    operation: "query",
    filters: { taskId, reviewer },
    count: records.length,
    records,
  };
}

async function listLedger(options) {
  const ledger = await readLedger(options.ledger);
  const status = options.status ? normalizeStatus(options.status) : "";
  const flag = options.flag ? String(options.flag).trim().toLowerCase().replaceAll(" ", "_") : "";
  const records = sortRecords(ledger.records).filter((entry) => {
    if (status && entry.reviewStatus !== status) return false;
    if (flag && !asArray(entry.reviewFlags).includes(flag)) return false;
    return true;
  });
  return {
    ok: true,
    operation: "list",
    filters: { status, flag },
    count: records.length,
    records,
  };
}

function summarizeLedger(ledger) {
  const byStatus = Object.fromEntries([...VALID_STATUSES].map((status) => [status, 0]));
  const byReviewer = {};
  const flagCounts = {};
  const archiveActions = {};
  let scoreTotal = 0;
  for (const entry of ledger.records) {
    byStatus[entry.reviewStatus] = (byStatus[entry.reviewStatus] || 0) + 1;
    byReviewer[entry.reviewer] = (byReviewer[entry.reviewer] || 0) + 1;
    archiveActions[entry.archiveAction] = (archiveActions[entry.archiveAction] || 0) + 1;
    for (const flag of asArray(entry.reviewFlags)) {
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
    }
    scoreTotal += Number(entry.score || 0);
  }
  const total = ledger.records.length;
  return {
    ok: true,
    operation: "report",
    schema: LEDGER_SCHEMA,
    totalRecords: total,
    averageScore: total ? Number((scoreTotal / total).toFixed(2)) : 0,
    byStatus,
    byReviewer,
    flagCounts,
    archiveActions,
    tasksWithFlags: sortRecords(ledger.records)
      .filter((entry) => asArray(entry.reviewFlags).length > 0)
      .map((entry) => ({
        taskId: entry.taskId,
        reviewer: entry.reviewer,
        reviewStatus: entry.reviewStatus,
        reviewFlags: entry.reviewFlags,
        archiveAction: entry.archiveAction,
      })),
    generatedAt: nowIso(),
  };
}

async function reportLedger(options) {
  const ledger = await readLedger(options.ledger);
  return summarizeLedger(ledger);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  let result;
  if (command === "add") result = await addRecord(options);
  else if (command === "query") result = await queryLedger(options);
  else if (command === "list") result = await listLedger(options);
  else if (command === "report") result = await reportLedger(options);
  else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
