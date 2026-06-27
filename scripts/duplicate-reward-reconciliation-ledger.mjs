#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEDGER_SCHEMA = "tasknode.duplicate_reward_manual_reconciliation_ledger.v1";
const DEFAULT_HARVEST_TASK_ID = "task_b1850294f50ed777c7b0eb29a75e7d4a";
const DEFAULT_OUTPUT = "docs/verification/duplicate_reward_manual_reconciliation_ledger_task_b1850294.json";
const DEFAULT_SUMMARY = "docs/verification/duplicate_reward_manual_reconciliation_ledger_task_b1850294.md";
const OPERATOR_OWNER = "accounting_operator_review";

function usage() {
  return `Usage:
  node scripts/duplicate-reward-reconciliation-ledger.mjs --report <scanner_report.json|-> [options]

Options:
  --report <path|->       Duplicate reward scanner JSON report. Use - for stdin.
  --output <path>         Write manual reconciliation ledger JSON. Default: ${DEFAULT_OUTPUT}
  --summary <path>        Write operator markdown summary. Default: ${DEFAULT_SUMMARY}
  --harvest-task <id>     Source harvest task id. Default: ${DEFAULT_HARVEST_TASK_ID}
  --source-ref <text>     Source report reference, for example a commit and path.
  --generated-at <iso>    Override generated timestamp.
  --json                  Print command result JSON to stdout.

Read-only converter. It creates review ledger entries only. It does not sign,
publish task events, mutate database state, approve rewards, claw back rewards,
ban users, or move funds.`;
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  return argv[index + 1] || "";
}

function parseArgs(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const report = readArg(argv, "--report");
  if (!report) throw new Error("report_required");
  return {
    report,
    output: readArg(argv, "--output") || DEFAULT_OUTPUT,
    summary: readArg(argv, "--summary") || DEFAULT_SUMMARY,
    harvestTaskId: readArg(argv, "--harvest-task") || DEFAULT_HARVEST_TASK_ID,
    sourceRef: readArg(argv, "--source-ref"),
    generatedAt: readArg(argv, "--generated-at") || new Date().toISOString(),
    json: argv.includes("--json"),
  };
}

function safeText(value = "", max = 1000) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function decimalText(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0.000000";
  return parsed.toFixed(6);
}

function numberFrom(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumPft(values = []) {
  return decimalText(values.reduce((sum, value) => sum + numberFrom(value), 0));
}

function uniqueTexts(values = []) {
  return [...new Set(values.map((value) => safeText(value, 180)).filter(Boolean))];
}

function hashText(value = "") {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readReport(reportPath) {
  const raw = reportPath === "-" ? await readStdin() : await readFile(reportPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.incidents)) {
    throw new Error("invalid_duplicate_reward_report");
  }
  return parsed;
}

function eventTxHashes(incident = {}) {
  const events = [
    ...(Array.isArray(incident.decisions) ? incident.decisions : []),
    ...(Array.isArray(incident.payments) ? incident.payments : []),
  ];
  return uniqueTexts(events.map((event) => event.txHash));
}

function eventCids(incident = {}) {
  const events = [
    ...(Array.isArray(incident.decisions) ? incident.decisions : []),
    ...(Array.isArray(incident.payments) ? incident.payments : []),
  ];
  return uniqueTexts(events.map((event) => event.cid));
}

function duplicatePaymentTxHashes(incident = {}) {
  const events = Array.isArray(incident.duplicatePayments) ? incident.duplicatePayments : [];
  return uniqueTexts(events.map((event) => event.txHash));
}

function entryReviewType(incident = {}) {
  const action = safeText(incident.recommendation?.action, 120);
  if (action) return action;
  if (numberFrom(incident.duplicatePaymentAfterFirstPft) > 0) return "manual_reward_accounting_review";
  return "review_duplicate_decision_only";
}

function buildEntry(incident = {}, options = {}) {
  const allocationReference = incident.allocationReference && typeof incident.allocationReference === "object"
    ? {
        type: safeText(incident.allocationReference.type, 80),
        value: safeText(incident.allocationReference.value, 240),
      }
    : { type: "task_id_fallback", value: safeText(incident.taskId, 180) };
  const reviewType = entryReviewType(incident);
  const duplicatePaymentAfterFirstPft = decimalText(incident.duplicatePaymentAfterFirstPft);
  const scannerRecommendedOffsetPft = decimalText(incident.recommendation?.recommendedReconciliationPft);
  const id = `dup_reward_recon_${hashText(`${incident.groupKey || ""}:${incident.taskId || ""}:${allocationReference.type}:${allocationReference.value}`)}`;

  return {
    id,
    schema: "tasknode.duplicate_reward_manual_reconciliation_entry.v1",
    harvestTaskId: options.harvestTaskId,
    status: "manual_review_required",
    actionOwner: OPERATOR_OWNER,
    reviewType,
    taskId: safeText(incident.taskId, 180),
    title: safeText(incident.title, 240),
    taskKind: safeText(incident.taskKind, 80),
    allocationReference,
    decisionCount: Number(incident.decisionCount) || 0,
    paymentCount: Number(incident.paymentCount) || 0,
    duplicateDecisionCount: Number(incident.duplicateDecisionCount) || 0,
    duplicatePaymentCount: Number(incident.duplicatePaymentCount) || 0,
    projectionRewardPft: decimalText(incident.projectionRewardPft),
    paymentTotalPft: decimalText(incident.paymentTotalPft),
    duplicatePaymentAfterFirstPft,
    scannerRecommendedOffsetPft,
    paymentProjectionDeltaPft: decimalText(incident.paymentProjectionDeltaPft),
    flags: Array.isArray(incident.flags) ? incident.flags.map((flag) => safeText(flag, 120)).filter(Boolean) : [],
    duplicatePaymentTxHashes: duplicatePaymentTxHashes(incident),
    sourceEventTxHashes: eventTxHashes(incident),
    sourceEventCids: eventCids(incident),
    sourceReportGroupKey: safeText(incident.groupKey, 500),
    sourceReportGeneratedAt: safeText(options.sourceReportGeneratedAt, 80),
    sourceReportReference: safeText(options.sourceRef, 500),
    operatorInstruction: {
      action: "manual_accounting_review_only",
      boundary: "This entry is review evidence, not a clawback, offset execution, reward approval, ban, or enforcement decision.",
      checks: [
        "Confirm canonical reward intent for the task allocation.",
        "Confirm chain-settled payment events and current projection before any accounting adjustment.",
        "Apply only the accounting operator's approved reconciliation policy.",
      ],
    },
    scannerRecommendation: {
      action: safeText(incident.recommendation?.action, 120),
      note: safeText(incident.recommendation?.note, 1000),
    },
  };
}

function buildLedger(report = {}, options = {}) {
  const entries = report.incidents.map((incident) => buildEntry(incident, {
    harvestTaskId: options.harvestTaskId,
    sourceRef: options.sourceRef,
    sourceReportGeneratedAt: report.generatedAt,
  }));
  const duplicatePaymentEntries = entries.filter((entry) => numberFrom(entry.duplicatePaymentAfterFirstPft) > 0);
  const decisionOnlyEntries = entries.filter((entry) => numberFrom(entry.duplicatePaymentAfterFirstPft) === 0);
  return {
    schema: LEDGER_SCHEMA,
    generatedAt: options.generatedAt,
    generatedBy: "grashnuk",
    sourceHarvestTaskId: options.harvestTaskId,
    sourceReport: {
      schema: safeText(report.schema, 180),
      source: safeText(report.source, 240),
      generatedAt: safeText(report.generatedAt, 80),
      sourceMode: safeText(report.sourceMode, 80),
      reference: safeText(options.sourceRef, 500),
    },
    readOnly: true,
    noSigning: true,
    noFundMovement: true,
    noLiveMutation: true,
    noRewardApproval: true,
    noClawbackExecution: true,
    operatorBoundary: "Manual accounting review ledger only. Entries assign investigation work to the accounting operator and do not execute policy.",
    aggregate: {
      sourceIncidentCount: Number(report.aggregate?.incidentCount) || report.incidents.length,
      ledgerEntryCount: entries.length,
      duplicatePaymentEntryCount: duplicatePaymentEntries.length,
      duplicateDecisionOnlyEntryCount: decisionOnlyEntries.length,
      totalDuplicatePaymentAfterFirstPft: sumPft(entries.map((entry) => entry.duplicatePaymentAfterFirstPft)),
      totalScannerRecommendedOffsetPft: sumPft(entries.map((entry) => entry.scannerRecommendedOffsetPft)),
      actionOwner: OPERATOR_OWNER,
    },
    entries,
    secretPrinted: false,
  };
}

function summaryRow(entry = {}) {
  return `| \`${entry.taskId}\` | ${entry.paymentCount} | ${entry.decisionCount} | ${entry.duplicatePaymentAfterFirstPft} | ${entry.scannerRecommendedOffsetPft} | ${entry.actionOwner} | ${entry.reviewType} |`;
}

function buildSummary(ledger = {}) {
  const rows = ledger.entries.length ? ledger.entries.map(summaryRow).join("\n") : "| none | 0 | 0 | 0.000000 | 0.000000 | accounting_operator_review | none |";
  return `# Duplicate Reward Manual Reconciliation Ledger

Generated: ${ledger.generatedAt}
Source harvest: \`${ledger.sourceHarvestTaskId}\`
Source report: ${ledger.sourceReport.reference || ledger.sourceReport.source || "duplicate reward scanner report"}

This ledger is an operator review artifact only. It does not sign, publish task
events, mutate database state, approve rewards, execute clawbacks, apply offsets,
ban users, or move funds.

## Aggregate

- Ledger entries: ${ledger.aggregate.ledgerEntryCount}
- Duplicate-payment entries: ${ledger.aggregate.duplicatePaymentEntryCount}
- Duplicate-decision-only entries: ${ledger.aggregate.duplicateDecisionOnlyEntryCount}
- Duplicate payment after first payment: ${ledger.aggregate.totalDuplicatePaymentAfterFirstPft} PFT
- Scanner recommended offset amount: ${ledger.aggregate.totalScannerRecommendedOffsetPft} PFT
- Assigned owner: \`${ledger.aggregate.actionOwner}\`

## Entries

| Task | Payments | Decisions | Duplicate-after-first PFT | Scanner recommended offset PFT | Owner | Review type |
| --- | ---: | ---: | ---: | ---: | --- | --- |
${rows}

## Review Boundary

Each entry requires manual accounting review. The scanner amounts are inputs for
operator reconciliation only and must be checked against canonical reward intent,
chain-settled payments, current projections, and the project's approved
reconciliation policy before any adjustment is made.
`;
}

async function writeFileWithParents(filePath, contents) {
  if (!filePath) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

export async function runDuplicateRewardReconciliationLedger(options = {}) {
  const report = await readReport(options.report);
  const ledger = buildLedger(report, options);
  const summary = buildSummary(ledger);
  await writeFileWithParents(options.output, `${JSON.stringify(ledger, null, 2)}\n`);
  await writeFileWithParents(options.summary, summary);
  return { ledger, summary };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { ledger } = await runDuplicateRewardReconciliationLedger(args);
  const result = {
    ok: true,
    output: args.output,
    summary: args.summary,
    aggregate: ledger.aggregate,
    secretPrinted: false,
  };
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message, secretPrinted: false }, null, 2));
    process.exitCode = 1;
  });
}
