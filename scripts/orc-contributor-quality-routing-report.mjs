#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const INPUT_LEDGER_SCHEMA = "pf.orc.submitted_work_review_ledger.v1";
const OUTPUT_SCHEMA = "pf.orc.contributor_quality_routing_report.v1";
const RECOMMEND_ONLY = "recommend_only_no_enforcement";

function usage() {
  return `Usage:
  node scripts/orc-contributor-quality-routing-report.mjs batch --ledger <file> --out <dir> [threshold options]
  node scripts/orc-contributor-quality-routing-report.mjs generate --ledger <file> [threshold options]

Threshold options:
  --min-total-for-ratio <n>              Default: 3
  --min-verified-ratio <0-1>            Default: 0.3
  --max-unverifiable <n>                Default: 2
  --max-refusals <n>                    Default: 1
  --refusal-window-days <n>             Default: 7
  --max-consecutive-unverifiable <n>    Default: 2
  --generated-by <handle>               Default: grashnuk
  --generated-at <iso timestamp>        Default: current time

The script reads records compatible with ${INPUT_LEDGER_SCHEMA} and produces a
recommend-only routing-review report. It does not mutate routing state.`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { command: "help", options: {} };
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

function safeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function numberOption(options, key, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const raw = options[key] === undefined ? fallback : options[key];
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${key} must be a number from ${min} to ${max}`);
  }
  return value;
}

function normalizeKey(value, fallback = "unknown") {
  const normalized = safeText(value)
    .toLowerCase()
    .replace(/^@/, "")
    .replaceAll(/[^a-z0-9_ -]/g, "")
    .replaceAll(/[ -]+/g, "_");
  return normalized || fallback;
}

function normalizeHandle(value) {
  return safeText(value).replace(/^@/, "");
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function readNested(record, paths) {
  for (const pathSpec of paths) {
    const parts = pathSpec.split(".");
    let current = record;
    for (const part of parts) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return "";
}

function contributorIdentity(record) {
  const walletAddress = safeText(readNested(record, [
    "walletAddress",
    "assigneeWallet",
    "contributor.walletAddress",
    "recipient.walletAddress",
  ]));
  const accountId = safeText(readNested(record, [
    "accountId",
    "assigneeAccountId",
    "recipientAccountId",
    "contributor.accountId",
    "recipient.accountId",
  ]));
  const handle = normalizeHandle(readNested(record, [
    "contributor.handle",
    "recipient.handle",
    "recipientHandle",
    "assigneeHandle",
    "submitterHandle",
  ]));
  const contributorKey = walletAddress || accountId || handle || "unknown_contributor";
  return { contributorKey, walletAddress, accountId, handle };
}

function normalizeOutcome(record) {
  const raw = normalizeKey(
    readNested(record, ["reviewStatus", "review_status", "outcome", "taskStatus", "status"]),
    "unknown"
  );
  const archiveAction = normalizeKey(readNested(record, ["archiveAction", "parserOutput.archivalInstructions"]), "");
  if (["verified", "accepted", "rewarded", "complete", "completed"].includes(raw)) return "verified";
  if (["unverified", "unverifiable", "needs_evidence", "insufficient_evidence"].includes(raw)) return "unverifiable";
  if (["self_attested", "self_attested_only"].includes(raw)) return "self_attested";
  if (["refused", "rejected"].includes(raw) || archiveAction === "reject") return "refused";
  if (["cancelled", "canceled"].includes(raw)) return "cancelled";
  return raw;
}

function recordTimestamp(record) {
  const value = safeText(readNested(record, ["timestamp", "reviewedAt", "updatedAt", "createdAt"]));
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function buildThresholds(options) {
  return {
    minTotalForRatio: numberOption(options, "min-total-for-ratio", 3, { min: 1 }),
    minVerifiedRatio: numberOption(options, "min-verified-ratio", 0.3, { min: 0, max: 1 }),
    maxUnverifiable: numberOption(options, "max-unverifiable", 2, { min: 0 }),
    maxRefusals: numberOption(options, "max-refusals", 1, { min: 0 }),
    refusalWindowDays: numberOption(options, "refusal-window-days", 7, { min: 1 }),
    maxConsecutiveUnverifiable: numberOption(options, "max-consecutive-unverifiable", 2, { min: 0 }),
  };
}

function compactRecord(record) {
  const identity = contributorIdentity(record);
  return {
    taskId: safeText(record.taskId),
    reviewId: safeText(record.id),
    outcome: normalizeOutcome(record),
    timestamp: recordTimestamp(record),
    score: Number(record.score ?? 0),
    flags: [
      ...asArray(record.reviewFlags),
      ...asArray(record.integritySignals),
      ...asArray(record.parserOutput?.flagIndicators),
    ].map((flag) => normalizeKey(flag, "")).filter(Boolean),
    identity,
  };
}

function countOutcomes(records) {
  const counts = { verified: 0, unverifiable: 0, self_attested: 0, refused: 0, cancelled: 0, other: 0 };
  for (const record of records) {
    if (counts[record.outcome] === undefined) counts.other += 1;
    else counts[record.outcome] += 1;
  }
  return counts;
}

function maxConsecutive(records, outcome) {
  let current = 0;
  let max = 0;
  for (const record of records) {
    if (record.outcome === outcome) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function refusalWindowCount(records, windowDays, generatedAt) {
  const end = Date.parse(generatedAt);
  const start = end - windowDays * 24 * 60 * 60 * 1000;
  return records.filter((record) => {
    if (record.outcome !== "refused") return false;
    const time = Date.parse(record.timestamp);
    return Number.isFinite(time) && time >= start && time <= end;
  }).length;
}

function evaluateContributor(contributorKey, records, thresholds, generatedAt) {
  const sortedRecords = [...records].sort((left, right) => {
    const byTime = String(left.timestamp).localeCompare(String(right.timestamp));
    if (byTime !== 0) return byTime;
    return String(left.taskId).localeCompare(String(right.taskId));
  });
  const counts = countOutcomes(sortedRecords);
  const total = sortedRecords.length;
  const verifiedRatio = total ? Number((counts.verified / total).toFixed(4)) : 0;
  const refusalCountWindow = refusalWindowCount(sortedRecords, thresholds.refusalWindowDays, generatedAt);
  const consecutiveUnverifiable = maxConsecutive(sortedRecords, "unverifiable");
  const violations = [];
  if (counts.unverifiable > thresholds.maxUnverifiable) {
    violations.push({
      rule: "repeated_unverifiable_submissions",
      observed: counts.unverifiable,
      threshold: thresholds.maxUnverifiable,
      taskIds: sortedRecords.filter((record) => record.outcome === "unverifiable").map((record) => record.taskId),
    });
  }
  if (consecutiveUnverifiable > thresholds.maxConsecutiveUnverifiable) {
    violations.push({
      rule: "consecutive_unverifiable_submissions",
      observed: consecutiveUnverifiable,
      threshold: thresholds.maxConsecutiveUnverifiable,
      taskIds: sortedRecords.filter((record) => record.outcome === "unverifiable").map((record) => record.taskId),
    });
  }
  if (refusalCountWindow > thresholds.maxRefusals) {
    violations.push({
      rule: "recent_refusals",
      observed: refusalCountWindow,
      threshold: thresholds.maxRefusals,
      windowDays: thresholds.refusalWindowDays,
      taskIds: sortedRecords.filter((record) => record.outcome === "refused").map((record) => record.taskId),
    });
  }
  if (total >= thresholds.minTotalForRatio && verifiedRatio < thresholds.minVerifiedRatio) {
    violations.push({
      rule: "low_verified_to_total_ratio",
      observed: verifiedRatio,
      threshold: thresholds.minVerifiedRatio,
      taskIds: sortedRecords.map((record) => record.taskId),
    });
  }
  const firstIdentity = sortedRecords[0]?.identity || {};
  return {
    contributorKey,
    accountId: firstIdentity.accountId || "",
    walletAddress: firstIdentity.walletAddress || "",
    handle: firstIdentity.handle || "",
    recommendation: violations.length ? "routing_review_recommended" : "no_routing_action_recommended",
    enforcementMode: RECOMMEND_ONLY,
    metrics: {
      total,
      verified: counts.verified,
      unverifiable: counts.unverifiable,
      selfAttested: counts.self_attested,
      refused: counts.refused,
      cancelled: counts.cancelled,
      other: counts.other,
      verifiedRatio,
      refusalCountWindow,
      maxConsecutiveUnverifiable: consecutiveUnverifiable,
    },
    violations,
    supportingTaskIds: sortedRecords.map((record) => record.taskId).filter(Boolean),
    records: sortedRecords.map(({ identity, ...record }) => record),
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

function buildReport(ledger, options) {
  const generatedAt = safeText(options["generated-at"]) || new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("--generated-at must be an ISO timestamp");
  const generatedBy = normalizeHandle(options["generated-by"] || "grashnuk") || "grashnuk";
  const thresholds = buildThresholds(options);
  const groups = new Map();
  for (const rawRecord of ledger.records) {
    const record = compactRecord(rawRecord);
    if (!groups.has(record.identity.contributorKey)) groups.set(record.identity.contributorKey, []);
    groups.get(record.identity.contributorKey).push(record);
  }
  const contributors = [...groups.entries()]
    .map(([contributorKey, records]) => evaluateContributor(contributorKey, records, thresholds, generatedAt))
    .sort((left, right) => {
      if (right.violations.length !== left.violations.length) return right.violations.length - left.violations.length;
      if (left.recommendation !== right.recommendation) return left.recommendation.localeCompare(right.recommendation);
      return left.contributorKey.localeCompare(right.contributorKey);
    });
  const flagged = contributors.filter((contributor) => contributor.recommendation === "routing_review_recommended");
  return {
    schema: OUTPUT_SCHEMA,
    generatedAt,
    generatedBy,
    sourceLedgerSchema: safeText(ledger.schema, INPUT_LEDGER_SCHEMA),
    enforcementMode: RECOMMEND_ONLY,
    note: "This report recommends human routing review only. It does not execute pauses, bans, blocklists, clawbacks, or payment actions.",
    thresholds,
    summary: {
      totalRecords: ledger.records.length,
      contributors: contributors.length,
      flaggedForRoutingReview: flagged.length,
      noActionRecommended: contributors.length - flagged.length,
      violationCounts: flagged.reduce((acc, contributor) => {
        for (const violation of contributor.violations) {
          acc[violation.rule] = (acc[violation.rule] || 0) + 1;
        }
        return acc;
      }, {}),
    },
    flaggedContributors: flagged,
    contributors,
  };
}

function buildDiscordSummary(report) {
  const lines = [
    "@goodalexander Contributor quality routing report is ready.",
    "",
    `Mode: ${report.enforcementMode} (no live routing changes executed)`,
    `Records reviewed: ${report.summary.totalRecords}`,
    `Contributors evaluated: ${report.summary.contributors}`,
    `Flagged for routing review: ${report.summary.flaggedForRoutingReview}`,
    "",
  ];
  if (report.flaggedContributors.length === 0) {
    lines.push("No contributors crossed the configured quality-review thresholds.");
  } else {
    lines.push("Flagged contributors:");
    for (const contributor of report.flaggedContributors) {
      const label = contributor.handle ? `@${contributor.handle}` : contributor.contributorKey;
      const rules = contributor.violations.map((violation) => violation.rule).join(", ");
      lines.push(
        `- ${label}: ${rules}; verified ratio ${contributor.metrics.verifiedRatio}; tasks ${contributor.supportingTaskIds.join(", ")}`
      );
    }
  }
  lines.push("", "Recommended action: review the flagged contributors before any routing policy change.");
  return `${lines.join("\n")}\n`;
}

async function writeBatch(report, outDir) {
  await mkdir(outDir, { recursive: true });
  const summary = buildDiscordSummary(report);
  await writeFile(path.join(outDir, "quality_routing_report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outDir, "discord_summary.md"), summary);
  return {
    ok: true,
    schema: OUTPUT_SCHEMA,
    outDir,
    files: ["quality_routing_report.json", "discord_summary.md"],
    summary: report.summary,
    enforcementMode: report.enforcementMode,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help") {
    console.log(usage());
    return;
  }
  if (!["batch", "generate"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const ledger = await readLedger(requireOption(options, "ledger"));
  const report = buildReport(ledger, options);
  if (command === "generate") {
    console.log(JSON.stringify({
      ok: true,
      schema: OUTPUT_SCHEMA,
      report,
      discordSummary: buildDiscordSummary(report),
    }, null, 2));
    return;
  }
  const result = await writeBatch(report, requireOption(options, "out"));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
