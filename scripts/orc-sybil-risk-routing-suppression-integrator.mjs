#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const RISK_MATRIX_SCHEMA = "tasknode.xrpl_sybil_risk_matrix.v1";
const SUPPRESSION_CONFIG_SCHEMA = "pf.orc.contributor_routing_suppression_config.v1";
const RECONCILIATION_SCHEMA = "pf.orc.sybil_risk_routing_suppression_reconciliation.v1";
const BATCH_SCHEMA = "pf.orc.sybil_risk_routing_suppression_batch.v1";
const MODE = "recommend_only_no_enforcement";
const DEFAULT_THRESHOLD = 60;
const DEFAULT_SCORE_FIELD = "reviewPriorityScore";

function usage() {
  return `Usage:
  node scripts/orc-sybil-risk-routing-suppression-integrator.mjs integrate \\
    --risk-matrix <risk-matrix.json> \\
    --suppression-config <suppression-config.json> \\
    [--out <enhanced-config.json>] \\
    [--report <reconciliation-report.json>] \\
    [--summary-out <discord-summary.md>] \\
    [--threshold 60] \\
    [--score-field reviewPriorityScore]

  node scripts/orc-sybil-risk-routing-suppression-integrator.mjs batch \\
    --risk-matrix <risk-matrix.json> \\
    --suppression-config <suppression-config.json> \\
    --out <dir> [options]

Options:
  --generated-by <handle>            Default: grashnuk
  --generated-at <iso timestamp>     Default: current time
  --expiry-days <n>                  Default: 14
  --expires-at <iso timestamp>       Overrides --expiry-days
  --risk-task-id <task_id>           Default: task_78bc0498dfcc292ed909b1da6743a1ba
  --risk-matrix-cid <cid>            Default: QmcLKpe9ckisrEhc4tps4xiwuQLsBM7rD5eBRWhBJUkEgB
  --suppression-task-id <task_id>    Default: task_c4682ae05cbc47f9669a58d5121cf38d
  --suppression-config-cid <cid>     Default: QmczB9qF2TfMs9ZDsLbx8gasowsp92EmAXzAj4Cej26xRL

This script produces inspectable JSON artifacts only. It never mutates live
routing, signs transactions, bans accounts, moves funds, clawbacks rewards, or
deploys anything.`;
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

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
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

function normalizeHandle(value) {
  return safeText(value).replace(/^@+/, "");
}

function normalizeKey(value, fallback = "unknown") {
  const normalized = safeText(value)
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^@+/, "")
    .replaceAll(/[^a-z0-9_ -]/g, "")
    .replaceAll(/[ -]+/g, "_");
  return normalized || fallback;
}

function ensureIsoTimestamp(value, label) {
  const timestamp = safeText(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function generatedAt(options) {
  return options["generated-at"]
    ? ensureIsoTimestamp(options["generated-at"], "--generated-at")
    : new Date().toISOString();
}

function expiryTimestamp(options, baseTimestamp) {
  if (options["expires-at"]) return ensureIsoTimestamp(options["expires-at"], "--expires-at");
  const expiryDays = numberOption(options, "expiry-days", 14, { min: 1 });
  return new Date(Date.parse(baseTimestamp) + expiryDays * 24 * 60 * 60 * 1000).toISOString();
}

async function readJson(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function writeJson(filePath, payload) {
  await writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readRiskRows(matrix) {
  if (!matrix || typeof matrix !== "object") throw new Error("Risk matrix must be a JSON object");
  if (matrix.schema !== RISK_MATRIX_SCHEMA) {
    throw new Error(`Risk matrix schema must be ${RISK_MATRIX_SCHEMA}; got ${safeText(matrix.schema, "missing")}`);
  }
  if (!Array.isArray(matrix.riskMatrix)) throw new Error("Risk matrix must include riskMatrix[]");
  return matrix.riskMatrix;
}

function readSuppressionEntries(config) {
  if (!config || typeof config !== "object") throw new Error("Suppression config must be a JSON object");
  if (config.schema !== SUPPRESSION_CONFIG_SCHEMA) {
    throw new Error(`Suppression config schema must be ${SUPPRESSION_CONFIG_SCHEMA}; got ${safeText(config.schema, "missing")}`);
  }
  if (!Array.isArray(config.entries)) throw new Error("Suppression config must include entries[]");
  return config.entries;
}

function entryKey(entry) {
  return safeText(entry.walletAddress || entry.contributorKey || entry.accountId || entry.handle).toLowerCase();
}

function riskWallet(row) {
  return safeText(row.wallet || row.walletAddress || row.contributorKey);
}

function riskScore(row, scoreField) {
  const value = Number(row?.[scoreField]);
  if (Number.isFinite(value)) return Number(value.toFixed(4));
  const fallback = Number(row?.reviewPriorityScore ?? row?.compositeScore ?? 0);
  return Number.isFinite(fallback) ? Number(fallback.toFixed(4)) : 0;
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => safeText(value)).filter(Boolean))].sort();
}

function signalSources(row) {
  const scores = row.componentScores && typeof row.componentScores === "object" ? row.componentScores : {};
  const sources = [];
  for (const [signal, payload] of Object.entries(scores)) {
    if (!payload || typeof payload !== "object") continue;
    sources.push({
      signal: normalizeKey(signal),
      score: Number(Number(payload.score ?? 0).toFixed(4)),
      source: safeText(payload.source),
      weight: Number(Number(payload.weight ?? 0).toFixed(4)),
    });
  }
  if (!sources.length) {
    sources.push({ signal: "risk_matrix_row", score: riskScore(row, DEFAULT_SCORE_FIELD), source: "riskMatrix", weight: 1 });
  }
  return sources;
}

function riskLevels(rows) {
  return rows.reduce((acc, row) => {
    const band = normalizeKey(row.riskBand || "unknown");
    acc[band] = (acc[band] || 0) + 1;
    return acc;
  }, {});
}

function riskEntry(row, matrix, options, runGeneratedAt, expiresAt) {
  const threshold = numberOption(options, "threshold", DEFAULT_THRESHOLD, { min: 0, max: 100 });
  const scoreField = safeText(options["score-field"] || DEFAULT_SCORE_FIELD);
  const wallet = riskWallet(row);
  const score = riskScore(row, scoreField);
  return {
    contributorKey: wallet,
    walletAddress: wallet,
    accountId: "",
    handle: "",
    status: "routing_suppression_recommended",
    mode: MODE,
    suppressionScope: "network_task_routing_review",
    suppressionReason: `sybil_risk_threshold:${scoreField}=${score}>=${threshold}`,
    sourceRecommendation: safeText(row.recommendation, "review raw transactions and operator identity before any enforcement decision"),
    sourceRiskMatrix: {
      schema: safeText(matrix.schema),
      taskId: safeText(options["risk-task-id"] || "task_78bc0498dfcc292ed909b1da6743a1ba"),
      cid: safeText(options["risk-matrix-cid"] || "QmcLKpe9ckisrEhc4tps4xiwuQLsBM7rD5eBRWhBJUkEgB"),
      generatedAt: safeText(matrix.generatedAt),
      scoreField,
      threshold,
    },
    sybilRisk: {
      automaticEntry: true,
      riskBand: safeText(row.riskBand),
      role: safeText(row.role),
      compositeScore: Number(Number(row.compositeScore ?? 0).toFixed(4)),
      reviewPriorityScore: Number(Number(row.reviewPriorityScore ?? 0).toFixed(4)),
      selectedScore: score,
      selectedScoreField: scoreField,
      signalSources: signalSources(row),
      reasons: uniqueStrings(row.reasons),
    },
    supportingTaskIds: uniqueStrings([
      options["risk-task-id"] || "task_78bc0498dfcc292ed909b1da6743a1ba",
      ...asArray(row.supportingTaskIds),
    ]),
    generatedAt: runGeneratedAt,
    expiresAt,
    requiresHumanApproval: true,
    operationalUseAllowed: false,
    enforcementBoundary: {
      readOnly: true,
      wouldMutateLiveRouting: false,
      wouldMoveFunds: false,
      wouldBanAccounts: false,
      wouldDeploy: false,
    },
  };
}

function mergeEntry(existingEntry, automaticEntry) {
  const existingReasons = uniqueStrings([
    existingEntry.suppressionReason,
    ...(asArray(existingEntry.sybilRisk?.reasons)),
  ]);
  return {
    ...existingEntry,
    status: existingEntry.status || "routing_suppression_recommended",
    mode: MODE,
    suppressionScope: existingEntry.suppressionScope || "network_task_routing_review",
    suppressionReason: uniqueStrings([...existingReasons, automaticEntry.suppressionReason]).join(";"),
    sourceRecommendation: existingEntry.sourceRecommendation || automaticEntry.sourceRecommendation,
    sourceRiskMatrix: automaticEntry.sourceRiskMatrix,
    sybilRisk: automaticEntry.sybilRisk,
    supportingTaskIds: uniqueStrings([
      ...asArray(existingEntry.supportingTaskIds),
      ...asArray(automaticEntry.supportingTaskIds),
    ]),
    requiresHumanApproval: true,
    operationalUseAllowed: false,
    enforcementBoundary: automaticEntry.enforcementBoundary,
    updatedBySybilRiskIntegrator: true,
  };
}

function comparableEntry(entry) {
  return JSON.stringify({
    key: entryKey(entry),
    suppressionReason: safeText(entry.suppressionReason),
    sourceRiskMatrix: entry.sourceRiskMatrix || null,
    sybilRisk: entry.sybilRisk || null,
    supportingTaskIds: uniqueStrings(entry.supportingTaskIds),
    operationalUseAllowed: Boolean(entry.operationalUseAllowed),
  });
}

function summarizeEntry(entry) {
  return {
    key: entryKey(entry),
    contributorKey: safeText(entry.contributorKey),
    walletAddress: safeText(entry.walletAddress),
    accountId: safeText(entry.accountId),
    handle: normalizeHandle(entry.handle),
    suppressionReason: safeText(entry.suppressionReason),
    riskBand: safeText(entry.sybilRisk?.riskBand),
    selectedScore: entry.sybilRisk?.selectedScore ?? null,
    sourceTaskIds: uniqueStrings(entry.supportingTaskIds),
  };
}

function buildArtifacts(riskMatrix, suppressionConfig, options) {
  const rows = readRiskRows(riskMatrix);
  const existingEntries = readSuppressionEntries(suppressionConfig);
  const threshold = numberOption(options, "threshold", DEFAULT_THRESHOLD, { min: 0, max: 100 });
  const scoreField = safeText(options["score-field"] || DEFAULT_SCORE_FIELD);
  const runGeneratedAt = generatedAt(options);
  const expiresAt = expiryTimestamp(options, runGeneratedAt);
  const generatedBy = normalizeHandle(options["generated-by"] || "grashnuk") || "grashnuk";

  const nextByKey = new Map(existingEntries.map((entry) => [entryKey(entry), { ...entry }]));
  const qualifyingRows = rows
    .filter((row) => riskWallet(row))
    .filter((row) => riskScore(row, scoreField) >= threshold)
    .sort((left, right) => riskWallet(left).localeCompare(riskWallet(right)));
  const belowThresholdRows = rows.filter((row) => riskWallet(row) && riskScore(row, scoreField) < threshold);

  for (const row of qualifyingRows) {
    const automaticEntry = riskEntry(row, riskMatrix, options, runGeneratedAt, expiresAt);
    const key = entryKey(automaticEntry);
    const existingEntry = nextByKey.get(key);
    nextByKey.set(key, existingEntry ? mergeEntry(existingEntry, automaticEntry) : automaticEntry);
  }

  const entries = [...nextByKey.values()].sort((left, right) => entryKey(left).localeCompare(entryKey(right)));
  const enhancedConfig = {
    ...suppressionConfig,
    schema: SUPPRESSION_CONFIG_SCHEMA,
    generatedAt: runGeneratedAt,
    generatedBy,
    mode: MODE,
    dryRunOnly: true,
    operationalUseAllowed: false,
    note: "Sybil risk-enriched suppression config. Human review is required before any live routing change. This file does not execute bans, blocklists, clawbacks, payment actions, or deploys.",
    sourceIntegrations: [
      ...(Array.isArray(suppressionConfig.sourceIntegrations) ? suppressionConfig.sourceIntegrations : []),
      {
        schema: RISK_MATRIX_SCHEMA,
        taskId: safeText(options["risk-task-id"] || "task_78bc0498dfcc292ed909b1da6743a1ba"),
        cid: safeText(options["risk-matrix-cid"] || "QmcLKpe9ckisrEhc4tps4xiwuQLsBM7rD5eBRWhBJUkEgB"),
        threshold,
        scoreField,
        integratedAt: runGeneratedAt,
      },
    ],
    summary: {
      ...(suppressionConfig.summary || {}),
      existingSuppressionEntryCount: existingEntries.length,
      riskMatrixWallets: rows.length,
      riskLevels: riskLevels(rows),
      riskThreshold: threshold,
      riskScoreField: scoreField,
      qualifyingRiskWallets: qualifyingRows.length,
      belowThresholdWallets: belowThresholdRows.length,
      enhancedSuppressionEntryCount: entries.length,
      automaticSybilRiskEntryCount: qualifyingRows.length,
      requiresHumanApproval: true,
    },
    entries,
    enforcementBoundary: {
      readOnly: true,
      wouldMutateLiveRouting: false,
      wouldMoveFunds: false,
      wouldBanAccounts: false,
      wouldDeploy: false,
    },
  };

  const previous = new Map(existingEntries.map((entry) => [entryKey(entry), entry]));
  const added = [];
  const updated = [];
  const unchanged = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    const existingEntry = previous.get(key);
    if (!existingEntry) {
      added.push(summarizeEntry(entry));
    } else if (comparableEntry(existingEntry) === comparableEntry(entry)) {
      unchanged.push(summarizeEntry(entry));
    } else {
      updated.push({ before: summarizeEntry(existingEntry), after: summarizeEntry(entry) });
    }
  }

  const reconciliation = {
    schema: RECONCILIATION_SCHEMA,
    generatedAt: runGeneratedAt,
    generatedBy,
    mode: MODE,
    dryRunOnly: true,
    threshold,
    scoreField,
    sourceRiskMatrix: {
      schema: safeText(riskMatrix.schema),
      taskId: safeText(options["risk-task-id"] || "task_78bc0498dfcc292ed909b1da6743a1ba"),
      cid: safeText(options["risk-matrix-cid"] || "QmcLKpe9ckisrEhc4tps4xiwuQLsBM7rD5eBRWhBJUkEgB"),
    },
    sourceSuppressionConfig: {
      schema: safeText(suppressionConfig.schema),
      taskId: safeText(options["suppression-task-id"] || "task_c4682ae05cbc47f9669a58d5121cf38d"),
      cid: safeText(options["suppression-config-cid"] || "QmczB9qF2TfMs9ZDsLbx8gasowsp92EmAXzAj4Cej26xRL"),
    },
    counts: {
      riskMatrixWallets: rows.length,
      existingSuppressionEntries: existingEntries.length,
      enhancedSuppressionEntries: entries.length,
      qualifyingRiskWallets: qualifyingRows.length,
      belowThresholdWallets: belowThresholdRows.length,
      added: added.length,
      updated: updated.length,
      unchanged: unchanged.length,
    },
    added,
    updated,
    unchanged,
    belowThreshold: belowThresholdRows.map((row) => ({
      walletAddress: riskWallet(row),
      riskBand: safeText(row.riskBand),
      selectedScore: riskScore(row, scoreField),
      role: safeText(row.role),
    })),
    warnings: [
      "Recommendation artifact only. No live routing mutation occurred.",
      "Do not use these entries for bans, clawbacks, fund movement, or production routing until reviewed by a human operator.",
    ],
  };

  return { enhancedConfig, reconciliation };
}

function buildDiscordSummary(enhancedConfig, reconciliation) {
  const lines = [
    "@goodalexander Sybil risk routing suppression integration is ready for review.",
    "",
    `Mode: ${enhancedConfig.mode} (read-only artifact generation; no live routing changes)`,
    `Risk threshold: ${reconciliation.threshold} using ${reconciliation.scoreField}`,
    `Risk matrix wallets scanned: ${reconciliation.counts.riskMatrixWallets}`,
    `Existing suppression entries: ${reconciliation.counts.existingSuppressionEntries}`,
    `Enhanced suppression entries: ${reconciliation.counts.enhancedSuppressionEntries}`,
    "",
    "Reconciliation:",
    `- Added automatic Sybil-risk entries: ${reconciliation.counts.added}`,
    `- Updated existing entries with Sybil risk: ${reconciliation.counts.updated}`,
    `- Unchanged entries: ${reconciliation.counts.unchanged}`,
    `- Below threshold / not added: ${reconciliation.counts.belowThresholdWallets}`,
    "",
    "Top added/updated entries:",
  ];

  const changed = [
    ...reconciliation.added.map((entry) => ({ type: "added", after: entry })),
    ...reconciliation.updated.map((entry) => ({ type: "updated", after: entry.after })),
  ];
  if (!changed.length) {
    lines.push("- None.");
  } else {
    for (const row of changed.slice(0, 10)) {
      lines.push(`- ${row.type}: ${row.after.walletAddress || row.after.contributorKey} ${row.after.riskBand} score ${row.after.selectedScore}`);
    }
  }

  lines.push(
    "",
    "Recommended next step: inspect the enhanced config and reconciliation report before any routing policy consumes it. This run did not ban accounts, move funds, claw back rewards, sign enforcement payloads, deploy code, or mutate live routing."
  );
  return `${lines.join("\n")}\n`;
}

async function runIntegrate(options) {
  const riskMatrix = await readJson(requireOption(options, "risk-matrix"), "Risk matrix");
  const suppressionConfig = await readJson(requireOption(options, "suppression-config"), "Suppression config");
  const { enhancedConfig, reconciliation } = buildArtifacts(riskMatrix, suppressionConfig, options);
  const summary = buildDiscordSummary(enhancedConfig, reconciliation);
  const outPath = options.out && options.out !== true ? String(options.out) : "";
  const reportPath = options.report && options.report !== true ? String(options.report) : "";
  const summaryPath = options["summary-out"] && options["summary-out"] !== true ? String(options["summary-out"]) : "";
  if (outPath) await writeJson(outPath, enhancedConfig);
  if (reportPath) await writeJson(reportPath, reconciliation);
  if (summaryPath) await writeText(summaryPath, summary);
  console.log(JSON.stringify({
    ok: true,
    schema: SUPPRESSION_CONFIG_SCHEMA,
    outPath,
    reportPath,
    summaryPath,
    summary: enhancedConfig.summary,
    reconciliation: reconciliation.counts,
    mode: MODE,
    enforcementBoundary: enhancedConfig.enforcementBoundary,
  }, null, 2));
}

async function runBatch(options) {
  const outDir = requireOption(options, "out");
  const enhancedPath = path.join(outDir, "enhanced_suppression_config.json");
  const reportPath = path.join(outDir, "reconciliation_report.json");
  const summaryPath = path.join(outDir, "discord_summary.md");
  const stdoutPath = path.join(outDir, "batch_output.json");
  const riskMatrix = await readJson(requireOption(options, "risk-matrix"), "Risk matrix");
  const suppressionConfig = await readJson(requireOption(options, "suppression-config"), "Suppression config");
  const { enhancedConfig, reconciliation } = buildArtifacts(riskMatrix, suppressionConfig, options);
  const summary = buildDiscordSummary(enhancedConfig, reconciliation);
  const batchOutput = {
    ok: true,
    schema: BATCH_SCHEMA,
    generatedAt: enhancedConfig.generatedAt,
    mode: MODE,
    files: [
      "enhanced_suppression_config.json",
      "reconciliation_report.json",
      "discord_summary.md",
      "batch_output.json",
    ],
    summary: enhancedConfig.summary,
    reconciliation: reconciliation.counts,
    enforcementBoundary: enhancedConfig.enforcementBoundary,
  };
  await mkdir(outDir, { recursive: true });
  await writeJson(enhancedPath, enhancedConfig);
  await writeJson(reportPath, reconciliation);
  await writeText(summaryPath, summary);
  await writeJson(stdoutPath, batchOutput);
  console.log(JSON.stringify(batchOutput, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help") {
    console.log(usage());
    return;
  }
  if (command === "integrate") {
    await runIntegrate(options);
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
