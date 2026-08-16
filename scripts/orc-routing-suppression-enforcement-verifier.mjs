#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const CONFIG_SCHEMA = "pf.orc.contributor_routing_suppression_config.v1";
const ALLOCATION_SCHEMA = "pf.orc.routing_suppression_allocation_sample.v1";
const REPORT_SCHEMA = "pf.orc.routing_suppression_enforcement_verification.v1";
const MODE = "verification_only_no_enforcement";
const ACTIVE_ALLOCATION_STATUSES = new Set([
  "proposed",
  "accepted",
  "assigned",
  "submitted",
  "verification_requested",
  "awaiting_review",
  "rewarded",
]);
const BLOCKED_ALLOCATION_STATUSES = new Set(["blocked", "suppressed", "rejected_by_routing_gate"]);

function usage() {
  return `Usage:
  node scripts/orc-routing-suppression-enforcement-verifier.mjs verify --config <file> --allocations <file> [--out <file>] [--summary-out <file>] [options]
  node scripts/orc-routing-suppression-enforcement-verifier.mjs batch --config <file> --allocations <file> --out <dir> [options]

Options:
  --generated-by <handle>         Default: grashnuk
  --generated-at <iso timestamp>  Default: current time

The verifier reads ${CONFIG_SCHEMA} plus board allocation data and emits a
${REPORT_SCHEMA} report. It is read-only: it does not mutate live routing, sign
enforcement transactions, ban accounts, claw back rewards, move funds, or deploy.`;
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

function normalizeHandle(value) {
  return safeText(value).replace(/^@/, "");
}

function normalizeKey(value, fallback = "unknown") {
  const normalized = safeText(value)
    .toLowerCase()
    .replace(/^@/, "")
    .replaceAll(/[^a-z0-9_ -]/g, "")
    .replaceAll(/[ -]+/g, "_");
  return normalized || fallback;
}

function ensureIsoTimestamp(value, label) {
  const timestamp = safeText(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

async function readJson(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readConfig(configPath) {
  const config = await readJson(configPath, "Suppression config");
  if (!config || typeof config !== "object") throw new Error("Suppression config must be a JSON object");
  if (config.schema !== CONFIG_SCHEMA) {
    throw new Error(`Suppression config schema must be ${CONFIG_SCHEMA}; got ${safeText(config.schema, "missing")}`);
  }
  if (!Array.isArray(config.entries)) throw new Error("Suppression config must include entries[]");
  return config;
}

async function readAllocations(allocationsPath) {
  const data = await readJson(allocationsPath, "Allocation data");
  if (!data || typeof data !== "object") throw new Error("Allocation data must be a JSON object");
  if (data.schema !== ALLOCATION_SCHEMA) {
    throw new Error(`Allocation data schema must be ${ALLOCATION_SCHEMA}; got ${safeText(data.schema, "missing")}`);
  }
  if (!Array.isArray(data.allocations)) throw new Error("Allocation data must include allocations[]");
  return data;
}

function identityKeys(record) {
  return [
    safeText(record.walletAddress).toLowerCase(),
    safeText(record.accountId).toLowerCase(),
    normalizeHandle(record.handle).toLowerCase(),
    safeText(record.contributorKey).toLowerCase(),
  ].filter(Boolean);
}

function allocationStatus(allocation) {
  return normalizeKey(allocation.status || allocation.routingDecision || allocation.state, "unknown");
}

function allocationTimestamp(allocation) {
  const raw = safeText(allocation.allocatedAt || allocation.createdAt || allocation.updatedAt);
  if (!raw) return "";
  if (!Number.isFinite(Date.parse(raw))) throw new Error(`Allocation ${safeText(allocation.allocationId || allocation.taskId)} has invalid timestamp`);
  return new Date(Date.parse(raw)).toISOString();
}

function suppressionEffectiveAt(entry, config) {
  return ensureIsoTimestamp(
    entry.suppressionEffectiveAt || config.generatedAt || entry.sourceReportGeneratedAt,
    "suppression effective timestamp"
  );
}

function suppressionExpiresAt(entry) {
  const expiresAt = safeText(entry.expiresAt);
  return expiresAt ? ensureIsoTimestamp(expiresAt, "suppression expiration timestamp") : "";
}

function compactAllocation(allocation) {
  return {
    allocationId: safeText(allocation.allocationId),
    taskId: safeText(allocation.taskId),
    title: safeText(allocation.title),
    walletAddress: safeText(allocation.walletAddress),
    accountId: safeText(allocation.accountId),
    handle: normalizeHandle(allocation.handle),
    status: allocationStatus(allocation),
    allocatedAt: allocationTimestamp(allocation),
    routingDecision: normalizeKey(allocation.routingDecision || allocation.status, "unknown"),
    source: safeText(allocation.source || "mock_board_state"),
  };
}

function allocationMs(allocation) {
  const parsed = Date.parse(allocation.allocatedAt);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function classifyContributor(entry, config, allocations, { generatedAt } = {}) {
  const effectiveAt = suppressionEffectiveAt(entry, config);
  const effectiveMs = Date.parse(effectiveAt);
  const expiresAt = suppressionExpiresAt(entry);
  const expiresMs = expiresAt ? Date.parse(expiresAt) : Infinity;
  const generatedMs = Date.parse(generatedAt);
  const expiredAtVerification = Number.isFinite(generatedMs) && expiresAt ? expiresMs <= generatedMs : false;
  const matches = allocations.filter((allocation) => {
    const entryKeys = new Set(identityKeys(entry));
    return identityKeys(allocation).some((key) => entryKeys.has(key));
  });
  const compactMatches = matches.map(compactAllocation).sort((left, right) => {
    const byTime = left.allocatedAt.localeCompare(right.allocatedAt);
    if (byTime !== 0) return byTime;
    return left.taskId.localeCompare(right.taskId);
  });
  const preSuppressionAllocations = compactMatches.filter((allocation) => allocationMs(allocation) < effectiveMs);
  const inSuppressionWindowAllocations = compactMatches.filter((allocation) => {
    const ms = allocationMs(allocation);
    return ms >= effectiveMs && ms < expiresMs;
  });
  const postExpiryAllocations = compactMatches.filter((allocation) => {
    const ms = allocationMs(allocation);
    return Number.isFinite(expiresMs) && ms >= expiresMs;
  });
  const activePostSuppressionAllocations = inSuppressionWindowAllocations.filter((allocation) =>
    ACTIVE_ALLOCATION_STATUSES.has(allocation.status)
  );
  const blockedPostSuppressionAllocations = inSuppressionWindowAllocations.filter((allocation) =>
    BLOCKED_ALLOCATION_STATUSES.has(allocation.status)
  );

  let enforcementStatus = "not_tested";
  let finding = "No matching allocation records were present for this suppressed contributor.";
  if (activePostSuppressionAllocations.length > 0) {
    enforcementStatus = "violated";
    finding = "Suppressed contributor received at least one active allocation during the active suppression window.";
  } else if (expiredAtVerification) {
    enforcementStatus = "expired";
    finding = "Suppression entry expired before this verification run; post-expiry allocations are not counted as violations.";
  } else if (inSuppressionWindowAllocations.length > 0 || preSuppressionAllocations.length > 0) {
    enforcementStatus = "enforced";
    finding = "No active allocations were found during the active suppression window.";
  }

  return {
    contributorKey: safeText(entry.contributorKey),
    walletAddress: safeText(entry.walletAddress),
    accountId: safeText(entry.accountId),
    handle: normalizeHandle(entry.handle),
    suppressionEffectiveAt: effectiveAt,
    expiresAt,
    expiredAtVerification,
    suppressionReason: safeText(entry.suppressionReason),
    sourceRecommendation: safeText(entry.sourceRecommendation),
    status: enforcementStatus,
    finding,
    qualityMetrics: entry.qualityMetrics || {},
    thresholdFailureRules: asArray(entry.thresholdFailures).map((failure) => normalizeKey(failure.rule, "unknown_rule")),
    allocationCounts: {
      totalMatched: compactMatches.length,
      preSuppression: preSuppressionAllocations.length,
      inSuppressionWindow: inSuppressionWindowAllocations.length,
      postSuppression: inSuppressionWindowAllocations.length,
      postExpiry: postExpiryAllocations.length,
      activePostSuppression: activePostSuppressionAllocations.length,
      blockedPostSuppression: blockedPostSuppressionAllocations.length,
    },
    activePostSuppressionAllocations,
    blockedPostSuppressionAllocations,
    postExpiryAllocations,
    preSuppressionAllocations,
    allMatchedAllocations: compactMatches,
    recommendedAction:
      enforcementStatus === "violated"
        ? "Escalate to human operator for routing investigation; do not auto-enforce."
        : enforcementStatus === "expired"
          ? "Refresh the suppression decision before making any current routing claim."
        : enforcementStatus === "not_tested"
          ? "Add live board allocation data before making an enforcement claim."
          : "No follow-up needed unless live data changes.",
  };
}

function nonSuppressedAllocations(config, allocations) {
  const suppressedKeys = new Set(config.entries.flatMap(identityKeys));
  return allocations
    .filter((allocation) => !identityKeys(allocation).some((key) => suppressedKeys.has(key)))
    .map(compactAllocation)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function buildReport(config, allocationData, options) {
  const generatedAt = options["generated-at"]
    ? ensureIsoTimestamp(options["generated-at"], "--generated-at")
    : new Date().toISOString();
  const generatedBy = normalizeHandle(options["generated-by"] || "grashnuk") || "grashnuk";
  const contributors = config.entries.map((entry) => classifyContributor(entry, config, allocationData.allocations, { generatedAt }));
  const counts = contributors.reduce((acc, contributor) => {
    acc[contributor.status] = (acc[contributor.status] || 0) + 1;
    return acc;
  }, {});
  const nonSuppressed = nonSuppressedAllocations(config, allocationData.allocations);
  return {
    schema: REPORT_SCHEMA,
    generatedAt,
    generatedBy,
    mode: MODE,
    readOnly: true,
    wouldMutateLiveRouting: false,
    wouldMoveFunds: false,
    wouldBanAccounts: false,
    wouldDeploy: false,
    note: "Verification report only. It detects routing-suppression status and possible violations; it does not execute enforcement.",
    sourceConfig: {
      schema: config.schema,
      generatedAt: safeText(config.generatedAt),
      generatedBy: safeText(config.generatedBy),
      mode: safeText(config.mode),
      dryRunOnly: Boolean(config.dryRunOnly),
      operationalUseAllowed: Boolean(config.operationalUseAllowed),
      entryCount: config.entries.length,
    },
    sourceAllocations: {
      schema: allocationData.schema,
      generatedAt: safeText(allocationData.generatedAt),
      allocationCount: allocationData.allocations.length,
    },
    rules: {
      suppressionEffectiveAt: "entry.suppressionEffectiveAt || config.generatedAt || entry.sourceReportGeneratedAt",
      suppressionWindow: "Allocations are checked from suppressionEffectiveAt inclusive until expiresAt exclusive when expiresAt is present.",
      activeAllocationStatuses: [...ACTIVE_ALLOCATION_STATUSES].sort(),
      blockedAllocationStatuses: [...BLOCKED_ALLOCATION_STATUSES].sort(),
      violatedDefinition: "Any active allocation with suppressionEffectiveAt <= allocatedAt < expiresAt when expiresAt is present; otherwise allocatedAt >= suppressionEffectiveAt.",
      enforcedDefinition: "Matching allocation evidence exists in an active suppression window and no active allocation exists in that window.",
      expiredDefinition: "The suppression entry's expiresAt is at or before report generatedAt and no active allocation occurred inside the suppression window.",
      notTestedDefinition: "No matching allocation evidence exists for the suppressed contributor.",
    },
    summary: {
      suppressedContributors: contributors.length,
      allocationRecords: allocationData.allocations.length,
      enforced: counts.enforced || 0,
      violated: counts.violated || 0,
      expired: counts.expired || 0,
      notTested: counts.not_tested || 0,
      nonSuppressedAllocationRecords: nonSuppressed.length,
      violationContributorHandles: contributors.filter((contributor) => contributor.status === "violated").map((contributor) => contributor.handle),
    },
    contributors,
    nonSuppressedAllocations: nonSuppressed,
  };
}

function buildDiscordSummary(report) {
  const lines = [
    "@goodalexander Routing suppression verification report is ready.",
    "",
    `Mode: ${report.mode} (read-only; no routing changes executed)`,
    `Suppressed contributors checked: ${report.summary.suppressedContributors}`,
    `Board allocation records scanned: ${report.summary.allocationRecords}`,
    `Enforced: ${report.summary.enforced}`,
    `Violated: ${report.summary.violated}`,
    `Expired: ${report.summary.expired}`,
    `Not tested: ${report.summary.notTested}`,
    "",
  ];

  for (const contributor of report.contributors) {
    const label = contributor.handle ? `@${contributor.handle}` : contributor.walletAddress || contributor.accountId;
    lines.push(
      `- ${label}: ${contributor.status}; active post-suppression allocations ${contributor.allocationCounts.activePostSuppression}; effective ${contributor.suppressionEffectiveAt}`
    );
  }

  if (report.summary.violated > 0) {
    lines.push(
      "",
      `Escalation recommended: ${report.summary.violationContributorHandles.join(", ")} had active post-suppression allocation evidence. Human review required before any routing action.`
    );
  } else {
    lines.push("", "No active post-suppression allocation violations were found in this data set.");
  }

  lines.push("", "No enforcement, bans, clawbacks, fund movement, signing, deployment, or live routing mutation occurred.");
  return `${lines.join("\n")}\n`;
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function runVerify(options) {
  const config = await readConfig(requireOption(options, "config"));
  const allocations = await readAllocations(requireOption(options, "allocations"));
  const report = buildReport(config, allocations, options);
  const summary = buildDiscordSummary(report);
  if (options.out && options.out !== true) await writeJson(String(options.out), report);
  if (options["summary-out"] && options["summary-out"] !== true) {
    await mkdir(path.dirname(String(options["summary-out"])), { recursive: true });
    await writeFile(String(options["summary-out"]), summary);
  }
  console.log(JSON.stringify({ ok: true, schema: REPORT_SCHEMA, summary: report.summary, mode: MODE }, null, 2));
}

async function runBatch(options) {
  const outDir = requireOption(options, "out");
  const config = await readConfig(requireOption(options, "config"));
  const allocations = await readAllocations(requireOption(options, "allocations"));
  const report = buildReport(config, allocations, options);
  const summary = buildDiscordSummary(report);
  await mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, "verification_report.json"), report);
  await writeFile(path.join(outDir, "discord_summary.md"), summary);
  console.log(JSON.stringify({
    ok: true,
    schema: REPORT_SCHEMA,
    outDir,
    files: ["verification_report.json", "discord_summary.md"],
    summary: report.summary,
    mode: MODE,
  }, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help") {
    console.log(usage());
    return;
  }
  if (command === "verify") {
    await runVerify(options);
    return;
  }
  if (command === "batch") {
    await runBatch(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
