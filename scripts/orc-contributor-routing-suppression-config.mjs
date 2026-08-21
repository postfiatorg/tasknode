#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const INPUT_SCHEMA = "pf.orc.contributor_quality_routing_report.v1";
const OUTPUT_SCHEMA = "pf.orc.contributor_routing_suppression_config.v1";
const DRY_RUN_SCHEMA = "pf.orc.contributor_routing_suppression_dry_run.v1";
const RECONCILIATION_SCHEMA = "pf.orc.contributor_routing_suppression_reconciliation.v1";
const MODE = "recommend_only_no_enforcement";

function usage() {
  return `Usage:
  node scripts/orc-contributor-routing-suppression-config.mjs generate --report <file> [--out <file>] [--dry-run] [options]
  node scripts/orc-contributor-routing-suppression-config.mjs reconcile --existing-config <file> --report <file> [--out <file>] [options]
  node scripts/orc-contributor-routing-suppression-config.mjs batch --report <file> --existing-config <file> --out <dir> [options]

Options:
  --generated-by <handle>         Default: grashnuk
  --generated-at <iso timestamp>  Default: current time
  --expiry-days <n>               Default: 14
  --expires-at <iso timestamp>    Overrides --expiry-days

The script consumes ${INPUT_SCHEMA} reports and produces ${OUTPUT_SCHEMA}
artifacts. It is intentionally recommend-only: it never mutates live routing,
executes bans, signs enforcement transactions, clawbacks funds, or deploys.`;
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

function numberOption(options, key, fallback, { min = Number.NEGATIVE_INFINITY } = {}) {
  const raw = options[key] === undefined ? fallback : options[key];
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`--${key} must be a number >= ${min}`);
  return value;
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

function expiryTimestamp(options, generatedAt) {
  if (options["expires-at"]) return ensureIsoTimestamp(options["expires-at"], "--expires-at");
  const expiryDays = numberOption(options, "expiry-days", 14, { min: 1 });
  return new Date(Date.parse(generatedAt) + expiryDays * 24 * 60 * 60 * 1000).toISOString();
}

function contributorLabel(contributor) {
  if (contributor.handle) return `@${contributor.handle}`;
  if (contributor.walletAddress) return contributor.walletAddress;
  if (contributor.accountId) return contributor.accountId;
  return contributor.contributorKey;
}

function entryKey(entry) {
  return safeText(entry.accountId || entry.contributorKey || entry.walletAddress || entry.handle).toLowerCase();
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

async function readJson(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readReport(reportPath) {
  const report = await readJson(reportPath, "Report");
  if (!report || typeof report !== "object") throw new Error("Report must be a JSON object");
  if (report.schema !== INPUT_SCHEMA) {
    throw new Error(`Report schema must be ${INPUT_SCHEMA}; got ${safeText(report.schema, "missing")}`);
  }
  if (!Array.isArray(report.flaggedContributors)) {
    throw new Error("Report must include flaggedContributors[]");
  }
  return report;
}

function violationRules(contributor) {
  return asArray(contributor.violations)
    .map((violation) => normalizeKey(violation.rule, "unknown_rule"))
    .filter(Boolean);
}

function suppressionReason(contributor) {
  const rules = violationRules(contributor);
  if (rules.length === 0) return "routing_review_recommended";
  return `quality_threshold_failures:${rules.join(",")}`;
}

function buildEntry(contributor, report, expiresAt) {
  const contributorKey = safeText(contributor.contributorKey || contributor.walletAddress || contributor.accountId || contributor.handle);
  return {
    contributorKey,
    walletAddress: safeText(contributor.walletAddress),
    walletAddresses: asArray(contributor.walletAddresses).map(String).filter(Boolean),
    accountId: safeText(contributor.accountId),
    accountIds: asArray(contributor.accountIds).map(String).filter(Boolean),
    handle: normalizeHandle(contributor.handle),
    handles: asArray(contributor.handles).map(normalizeHandle).filter(Boolean),
    status: "routing_suppression_recommended",
    mode: MODE,
    suppressionScope: "network_task_routing_review",
    suppressionReason: suppressionReason(contributor),
    qualityMetrics: contributor.metrics || {},
    thresholdFailures: asArray(contributor.violations).map((violation) => ({
      rule: normalizeKey(violation.rule, "unknown_rule"),
      observed: violation.observed ?? null,
      threshold: violation.threshold ?? null,
      windowDays: violation.windowDays ?? null,
      taskIds: asArray(violation.taskIds).map(String).filter(Boolean),
    })),
    supportingTaskIds: asArray(contributor.supportingTaskIds).map(String).filter(Boolean),
    sourceRecommendation: safeText(contributor.recommendation, "routing_review_recommended"),
    sourceReportGeneratedAt: safeText(report.generatedAt),
    sourceReportGeneratedBy: safeText(report.generatedBy),
    expiresAt,
    requiresHumanApproval: true,
    operationalUseAllowed: false,
  };
}

function buildConfig(report, options) {
  const generatedAt = options["generated-at"]
    ? ensureIsoTimestamp(options["generated-at"], "--generated-at")
    : new Date().toISOString();
  const generatedBy = normalizeHandle(options["generated-by"] || "grashnuk") || "grashnuk";
  const expiresAt = expiryTimestamp(options, generatedAt);
  const entries = report.flaggedContributors
    .map((contributor) => buildEntry(contributor, report, expiresAt))
    .sort((left, right) => entryKey(left).localeCompare(entryKey(right)));
  const violationCounts = entries.reduce((acc, entry) => {
    for (const failure of entry.thresholdFailures) acc[failure.rule] = (acc[failure.rule] || 0) + 1;
    return acc;
  }, {});
  return {
    schema: OUTPUT_SCHEMA,
    generatedAt,
    generatedBy,
    mode: MODE,
    dryRunOnly: true,
    operationalUseAllowed: false,
    note: "Recommend-only routing suppression configuration. Human review is required before any live routing change. This file does not execute bans, blocklists, clawbacks, payment actions, or deploys.",
    sourceReport: {
      schema: report.schema,
      generatedAt: safeText(report.generatedAt),
      generatedBy: safeText(report.generatedBy),
      sourceLedgerSchema: safeText(report.sourceLedgerSchema),
      summary: report.summary || {},
    },
    summary: {
      contributorsEvaluated: Number(report.summary?.contributors ?? report.contributors?.length ?? 0),
      flaggedForRoutingReview: Number(report.summary?.flaggedForRoutingReview ?? entries.length),
      suppressionEntryCount: entries.length,
      expiresAt,
      violationCounts,
    },
    entries,
  };
}

function buildDryRun(config, targetPath = "") {
  return {
    schema: DRY_RUN_SCHEMA,
    generatedAt: config.generatedAt,
    mode: MODE,
    wouldWrite: Boolean(targetPath),
    targetPath,
    wouldMutateLiveRouting: false,
    proposedSuppressionCount: config.entries.length,
    proposedSuppressions: config.entries.map((entry) => ({
      key: entryKey(entry),
      label: contributorLabel(entry),
      walletAddress: entry.walletAddress,
      walletAddresses: asArray(entry.walletAddresses).map(String).filter(Boolean),
      accountId: entry.accountId,
      accountIds: asArray(entry.accountIds).map(String).filter(Boolean),
      expiresAt: entry.expiresAt,
      thresholdFailureRules: entry.thresholdFailures.map((failure) => failure.rule),
      supportingTaskIds: entry.supportingTaskIds,
    })),
    warnings: [
      "Dry-run output only. Do not feed directly into live routing without human approval.",
      "No bans, clawbacks, fund movement, signing, deployment, or task-routing mutation occurred.",
    ],
  };
}

async function readExistingConfig(configPath) {
  const config = await readJson(configPath, "Existing config");
  if (!config || typeof config !== "object" || !Array.isArray(config.entries)) {
    throw new Error("Existing config must be a JSON object with entries[]");
  }
  return config;
}

function summarizeEntry(entry) {
  return {
    key: entryKey(entry),
    contributorKey: safeText(entry.contributorKey),
    walletAddress: safeText(entry.walletAddress),
    walletAddresses: asArray(entry.walletAddresses).map(String).filter(Boolean),
    accountId: safeText(entry.accountId),
    accountIds: asArray(entry.accountIds).map(String).filter(Boolean),
    handle: normalizeHandle(entry.handle),
    handles: asArray(entry.handles).map(normalizeHandle).filter(Boolean),
    expiresAt: safeText(entry.expiresAt),
    thresholdFailureRules: asArray(entry.thresholdFailures).map((failure) => normalizeKey(failure.rule, "")),
    supportingTaskIds: asArray(entry.supportingTaskIds).map(String).filter(Boolean),
  };
}

function comparableEntry(entry) {
  return JSON.stringify({
    walletAddress: safeText(entry.walletAddress),
    walletAddresses: asArray(entry.walletAddresses).map(String).filter(Boolean).sort(),
    accountId: safeText(entry.accountId),
    accountIds: asArray(entry.accountIds).map(String).filter(Boolean).sort(),
    handle: normalizeHandle(entry.handle),
    handles: asArray(entry.handles).map(normalizeHandle).filter(Boolean).sort(),
    thresholdFailureRules: asArray(entry.thresholdFailures).map((failure) => normalizeKey(failure.rule, "")).sort(),
    supportingTaskIds: asArray(entry.supportingTaskIds).map(String).filter(Boolean).sort(),
  });
}

function buildReconciliation(existingConfig, nextConfig) {
  const existing = new Map(asArray(existingConfig.entries).map((entry) => [entryKey(entry), entry]));
  const next = new Map(asArray(nextConfig.entries).map((entry) => [entryKey(entry), entry]));
  const added = [];
  const removed = [];
  const unchanged = [];
  const changed = [];

  for (const [key, nextEntry] of next.entries()) {
    const existingEntry = existing.get(key);
    if (!existingEntry) {
      added.push(summarizeEntry(nextEntry));
      continue;
    }
    if (comparableEntry(existingEntry) === comparableEntry(nextEntry)) unchanged.push(summarizeEntry(nextEntry));
    else changed.push({ before: summarizeEntry(existingEntry), after: summarizeEntry(nextEntry) });
  }
  for (const [key, existingEntry] of existing.entries()) {
    if (!next.has(key)) removed.push(summarizeEntry(existingEntry));
  }

  return {
    schema: RECONCILIATION_SCHEMA,
    generatedAt: nextConfig.generatedAt,
    mode: MODE,
    dryRunOnly: true,
    existingGeneratedAt: safeText(existingConfig.generatedAt),
    nextGeneratedAt: safeText(nextConfig.generatedAt),
    counts: {
      existing: existing.size,
      next: next.size,
      added: added.length,
      removed: removed.length,
      unchanged: unchanged.length,
      changed: changed.length,
    },
    added,
    removed,
    unchanged,
    changed,
    warnings: [
      "Reconciliation only compares inspectable JSON artifacts.",
      "No live routing suppression, bans, clawbacks, signing, fund movement, or deploy occurred.",
    ],
  };
}

function buildDiscordSummary(config, reconciliation) {
  const lines = [
    "@goodalexander Contributor routing suppression config is ready for review.",
    "",
    `Mode: ${config.mode} (dry-run only; no live routing changes executed)`,
    `Suppression entries recommended: ${config.summary.suppressionEntryCount}`,
    `Contributors evaluated upstream: ${config.summary.contributorsEvaluated}`,
    `Expiry for recommendations: ${config.summary.expiresAt}`,
    "",
    "Current recommended suppressions:",
  ];

  if (config.entries.length === 0) {
    lines.push("- None.");
  } else {
    for (const entry of config.entries) {
      const rules = entry.thresholdFailures.map((failure) => failure.rule).join(", ") || "routing_review_recommended";
      lines.push(`- ${contributorLabel(entry)}: ${rules}; tasks ${entry.supportingTaskIds.join(", ") || "none listed"}`);
    }
  }

  if (reconciliation) {
    lines.push(
      "",
      "Reconciliation vs existing config:",
      `- Added: ${reconciliation.counts.added}`,
      `- Removed: ${reconciliation.counts.removed}`,
      `- Unchanged: ${reconciliation.counts.unchanged}`,
      `- Changed: ${reconciliation.counts.changed}`
    );
  }

  lines.push(
    "",
    "Recommended action: have a human operator inspect these entries before any routing policy change. This artifact is not an enforcement execution."
  );
  return `${lines.join("\n")}\n`;
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function runGenerate(options) {
  const report = await readReport(requireOption(options, "report"));
  const config = buildConfig(report, options);
  const outPath = options.out && options.out !== true ? String(options.out) : "";
  const dryRun = buildDryRun(config, outPath);
  if (outPath && !options["dry-run"]) await writeJson(outPath, config);
  if (options["dry-run"]) {
    console.log(JSON.stringify({ ok: true, schema: DRY_RUN_SCHEMA, dryRun, config }, null, 2));
    return;
  }
  console.log(JSON.stringify({ ok: true, schema: OUTPUT_SCHEMA, outPath, summary: config.summary }, null, 2));
}

async function runReconcile(options) {
  const report = await readReport(requireOption(options, "report"));
  const existingConfig = await readExistingConfig(requireOption(options, "existing-config"));
  const nextConfig = buildConfig(report, options);
  const reconciliation = buildReconciliation(existingConfig, nextConfig);
  const outPath = options.out && options.out !== true ? String(options.out) : "";
  if (outPath) await writeJson(outPath, reconciliation);
  console.log(JSON.stringify({ ok: true, schema: RECONCILIATION_SCHEMA, outPath, counts: reconciliation.counts }, null, 2));
}

async function runBatch(options) {
  const outDir = requireOption(options, "out");
  const report = await readReport(requireOption(options, "report"));
  const existingConfig = await readExistingConfig(requireOption(options, "existing-config"));
  const config = buildConfig(report, options);
  const dryRun = buildDryRun(config, path.join(outDir, "suppression_config.json"));
  const reconciliation = buildReconciliation(existingConfig, config);
  const discordSummary = buildDiscordSummary(config, reconciliation);
  await mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, "suppression_config.json"), config);
  await writeJson(path.join(outDir, "dry_run_output.json"), dryRun);
  await writeJson(path.join(outDir, "reconciliation_output.json"), reconciliation);
  await writeFile(path.join(outDir, "discord_summary.md"), discordSummary);
  console.log(JSON.stringify({
    ok: true,
    schema: OUTPUT_SCHEMA,
    outDir,
    files: [
      "suppression_config.json",
      "dry_run_output.json",
      "reconciliation_output.json",
      "discord_summary.md",
    ],
    summary: config.summary,
    reconciliation: reconciliation.counts,
    mode: MODE,
  }, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help") {
    console.log(usage());
    return;
  }
  if (command === "generate") {
    await runGenerate(options);
    return;
  }
  if (command === "reconcile") {
    await runReconcile(options);
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
