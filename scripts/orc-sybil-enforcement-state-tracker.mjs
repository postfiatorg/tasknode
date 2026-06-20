#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const RISK_MATRIX_SCHEMA = "tasknode.xrpl_sybil_risk_matrix.v1";
const SUPPRESSION_CONFIG_SCHEMA = "pf.orc.contributor_routing_suppression_config.v1";
const VERIFIER_REPORT_SCHEMA = "pf.orc.routing_suppression_enforcement_verification.v1";
const STATE_SCHEMA = "pf.orc.sybil_enforcement_state.v1";
const REPORT_SCHEMA = "pf.orc.sybil_enforcement_state_report.v1";
const BATCH_SCHEMA = "pf.orc.sybil_enforcement_state_batch.v1";
const MODE = "recommend_only_state_tracking";
const DEFAULT_GENERATED_BY = "grashnuk";
const DEFAULT_RISK_TASK_ID = "task_78bc0498dfcc292ed909b1da6743a1ba";
const DEFAULT_RISK_CID = "QmcLKpe9ckisrEhc4tps4xiwuQLsBM7rD5eBRWhBJUkEgB";
const DEFAULT_SUPPRESSION_TASK_ID = "task_e2473aa56887d24f354d008c553ffc57";
const DEFAULT_SUPPRESSION_CID = "Qme8s5wg6C69EnUbEZ6hCahNYN9vNocaJRdxWNak2KX4gc";
const DEFAULT_VERIFIER_TASK_ID = "task_06376269c285c93f098d02f585d2dc92";
const DEFAULT_VERIFIER_CID = "QmdUzjpPXHm2kLjEBxxMJ5drxCFKUqWCvwbj92MhzyAAJe";

function usage() {
  return `Usage:
  node scripts/orc-sybil-enforcement-state-tracker.mjs generate \\
    --risk-matrix <risk-matrix.json> \\
    --suppression-config <suppression-config.json> \\
    --verifier-report <verification-report.json> \\
    [--state-out <enforcement-state.json>] \\
    [--report-out <state-report.json>] \\
    [--summary-out <discord-summary.md>]

  node scripts/orc-sybil-enforcement-state-tracker.mjs batch \\
    --risk-matrix <risk-matrix.json> \\
    --suppression-config <suppression-config.json> \\
    --verifier-report <verification-report.json> \\
    --out <dir>

  node scripts/orc-sybil-enforcement-state-tracker.mjs query --state <state.json> --wallet <wallet>
  node scripts/orc-sybil-enforcement-state-tracker.mjs list --state <state.json> [--gap-only]
  node scripts/orc-sybil-enforcement-state-tracker.mjs add --state <state.json> --wallet <wallet> [options] [--out <state.json>]
  node scripts/orc-sybil-enforcement-state-tracker.mjs update --state <state.json> --wallet <wallet> [options] [--out <state.json>]

Add/update options:
  --risk-score <number>             Risk score for manual records.
  --risk-band <label>               Risk band for manual records.
  --suppression-status <status>     Example: suppression_recommended, not_suppressed.
  --verification-status <status>    Example: enforced, violated, not_tested.
  --last-verified-at <iso time>     Last verifier timestamp.
  --gap <label>                     Repeatable gap labels for manual records.

Metadata options:
  --generated-by <handle>           Default: grashnuk
  --generated-at <iso timestamp>    Default: current time
  --risk-task-id <task_id>          Default: ${DEFAULT_RISK_TASK_ID}
  --risk-matrix-cid <cid>           Default: ${DEFAULT_RISK_CID}
  --suppression-task-id <task_id>   Default: ${DEFAULT_SUPPRESSION_TASK_ID}
  --suppression-config-cid <cid>    Default: ${DEFAULT_SUPPRESSION_CID}
  --verifier-task-id <task_id>      Default: ${DEFAULT_VERIFIER_TASK_ID}
  --verifier-report-cid <cid>       Default: ${DEFAULT_VERIFIER_CID}

This is a read-only state tracker. It writes local JSON/Markdown artifacts only;
it does not mutate live routing, sign transactions, ban accounts, claw back
rewards, move PFT, or deploy.`;
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

function generatedBy(options) {
  return normalizeHandle(options["generated-by"] || DEFAULT_GENERATED_BY) || DEFAULT_GENERATED_BY;
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : fallback;
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => safeText(value)).filter(Boolean))].sort();
}

function walletKey(value) {
  return safeText(value).toLowerCase();
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

function readVerifierContributors(report) {
  if (!report || typeof report !== "object") throw new Error("Verifier report must be a JSON object");
  if (report.schema !== VERIFIER_REPORT_SCHEMA) {
    throw new Error(`Verifier report schema must be ${VERIFIER_REPORT_SCHEMA}; got ${safeText(report.schema, "missing")}`);
  }
  if (!Array.isArray(report.contributors)) throw new Error("Verifier report must include contributors[]");
  return report.contributors;
}

function identityWallet(record) {
  return safeText(record.wallet || record.walletAddress || record.contributorKey || record.accountId || record.handle);
}

function mapByWallet(rows) {
  const mapped = new Map();
  for (const row of rows) {
    const key = walletKey(identityWallet(row));
    if (key) mapped.set(key, row);
  }
  return mapped;
}

function riskScore(row) {
  return numberValue(row?.reviewPriorityScore ?? row?.compositeScore ?? row?.riskScore, 0);
}

function riskBand(row) {
  return normalizeKey(row?.riskBand || "unknown");
}

function isSuppressionRecommended(entry) {
  const status = normalizeKey(entry?.status || entry?.suppressionStatus);
  return Boolean(entry) && !["cleared", "not_suppressed", "none"].includes(status);
}

function suppressionStatus(entry) {
  if (!entry) return "not_suppressed";
  const status = normalizeKey(entry.status || "routing_suppression_recommended");
  if (status.includes("active")) return "suppressed";
  if (status.includes("expired")) return "expired_recommendation";
  if (status.includes("recommended")) return "suppression_recommended";
  return status;
}

function sourceMeta(options) {
  return {
    riskMatrix: {
      taskId: safeText(options["risk-task-id"] || DEFAULT_RISK_TASK_ID),
      cid: safeText(options["risk-matrix-cid"] || DEFAULT_RISK_CID),
    },
    suppressionConfig: {
      taskId: safeText(options["suppression-task-id"] || DEFAULT_SUPPRESSION_TASK_ID),
      cid: safeText(options["suppression-config-cid"] || DEFAULT_SUPPRESSION_CID),
    },
    verifierReport: {
      taskId: safeText(options["verifier-task-id"] || DEFAULT_VERIFIER_TASK_ID),
      cid: safeText(options["verifier-report-cid"] || DEFAULT_VERIFIER_CID),
    },
  };
}

function buildGapLabels({ risk, suppression, verification }) {
  const gaps = [];
  const band = risk ? riskBand(risk) : "unknown";
  const score = risk ? riskScore(risk) : 0;
  const hasSuppression = isSuppressionRecommended(suppression);
  const verificationStatus = normalizeKey(verification?.status || "missing_verification");

  if (!risk) gaps.push("missing_risk_matrix_row");
  if (["high_review_priority", "high", "critical"].includes(band) && !hasSuppression) {
    gaps.push("high_risk_missing_suppression_entry");
  }
  if (score >= 60 && !hasSuppression) gaps.push("risk_score_above_threshold_without_suppression");
  if (hasSuppression && !verification) gaps.push("suppression_entry_missing_verification");
  if (hasSuppression && verificationStatus === "not_tested") gaps.push("suppression_not_tested_by_allocation_sample");
  if (verificationStatus === "violated") gaps.push("post_suppression_active_allocation_detected");
  if (["low", "watch"].includes(band) && hasSuppression) gaps.push(`${band}_risk_has_suppression_entry_review_boundary`);
  if (suppression && suppression.operationalUseAllowed === true) gaps.push("suppression_config_allows_operational_use_review_required");

  return uniqueStrings(gaps);
}

function recommendedAction(gaps) {
  if (gaps.includes("post_suppression_active_allocation_detected")) {
    return "Escalate to Nazgul/Sauron for human routing investigation; do not auto-enforce.";
  }
  if (gaps.includes("high_risk_missing_suppression_entry") || gaps.includes("risk_score_above_threshold_without_suppression")) {
    return "Prepare a recommend-only routing review packet for human approval.";
  }
  if (gaps.includes("suppression_entry_missing_verification") || gaps.includes("suppression_not_tested_by_allocation_sample")) {
    return "Run or refresh allocation verification before making any enforcement claim.";
  }
  if (gaps.includes("watch_risk_has_suppression_entry_review_boundary") || gaps.includes("low_risk_has_suppression_entry_review_boundary")) {
    return "Review whether suppression remains justified for this risk level.";
  }
  if (gaps.length > 0) return "Review detected gap manually before any operational use.";
  return "No action beyond continued monitoring.";
}

function compactRisk(row, meta) {
  if (!row) {
    return {
      sourceTaskId: meta.riskMatrix.taskId,
      sourceCid: meta.riskMatrix.cid,
      present: false,
      riskScore: 0,
      riskBand: "unknown",
      role: "",
      reasons: [],
      recommendation: "",
    };
  }
  return {
    sourceTaskId: meta.riskMatrix.taskId,
    sourceCid: meta.riskMatrix.cid,
    present: true,
    riskScore: riskScore(row),
    riskBand: riskBand(row),
    role: safeText(row.role),
    compositeScore: numberValue(row.compositeScore, 0),
    reviewPriorityScore: numberValue(row.reviewPriorityScore, 0),
    reasons: uniqueStrings(row.reasons),
    recommendation: safeText(row.recommendation),
  };
}

function compactSuppression(entry, meta) {
  if (!entry) {
    return {
      sourceTaskId: meta.suppressionConfig.taskId,
      sourceCid: meta.suppressionConfig.cid,
      present: false,
      status: "not_suppressed",
      reason: "",
      mode: "",
      operationalUseAllowed: false,
      requiresHumanApproval: true,
      expiresAt: "",
      supportingTaskIds: [],
    };
  }
  return {
    sourceTaskId: meta.suppressionConfig.taskId,
    sourceCid: meta.suppressionConfig.cid,
    present: true,
    status: suppressionStatus(entry),
    rawStatus: safeText(entry.status),
    reason: safeText(entry.suppressionReason),
    scope: safeText(entry.suppressionScope),
    mode: safeText(entry.mode),
    effectiveAt: safeText(entry.suppressionEffectiveAt || entry.generatedAt || entry.sourceReportGeneratedAt),
    expiresAt: safeText(entry.expiresAt),
    operationalUseAllowed: Boolean(entry.operationalUseAllowed),
    requiresHumanApproval: entry.requiresHumanApproval !== false,
    supportingTaskIds: uniqueStrings(entry.supportingTaskIds),
  };
}

function compactVerification(contributor, report, meta) {
  if (!contributor) {
    return {
      sourceTaskId: meta.verifierReport.taskId,
      sourceCid: meta.verifierReport.cid,
      present: false,
      status: "missing_verification",
      lastVerifiedAt: "",
      finding: "",
      allocationCounts: {},
      activePostSuppressionAllocations: [],
    };
  }
  return {
    sourceTaskId: meta.verifierReport.taskId,
    sourceCid: meta.verifierReport.cid,
    present: true,
    status: normalizeKey(contributor.status || "unknown"),
    lastVerifiedAt: safeText(report.generatedAt),
    finding: safeText(contributor.finding),
    allocationCounts: contributor.allocationCounts || {},
    activePostSuppressionAllocations: asArray(contributor.activePostSuppressionAllocations),
    blockedPostSuppressionAllocations: asArray(contributor.blockedPostSuppressionAllocations),
  };
}

function buildRecord(wallet, { risk, suppression, verification, report, meta }) {
  const gaps = buildGapLabels({ risk, suppression, verification });
  return {
    walletAddress: wallet,
    accountId: safeText(suppression?.accountId || verification?.accountId),
    handle: normalizeHandle(suppression?.handle || verification?.handle),
    contributorKey: safeText(suppression?.contributorKey || verification?.contributorKey || wallet),
    risk: compactRisk(risk, meta),
    suppression: compactSuppression(suppression, meta),
    verification: compactVerification(verification, report, meta),
    detectedGaps: gaps,
    recommendedNextAction: recommendedAction(gaps),
  };
}

function buildState({ matrix, config, verifier, options }) {
  const runGeneratedAt = generatedAt(options);
  const meta = sourceMeta(options);
  const riskRows = readRiskRows(matrix);
  const suppressionEntries = readSuppressionEntries(config);
  const verifierContributors = readVerifierContributors(verifier);
  const riskByWallet = mapByWallet(riskRows);
  const suppressionByWallet = mapByWallet(suppressionEntries);
  const verifierByWallet = mapByWallet(verifierContributors);
  const walletsByKey = new Map();
  for (const row of [...riskRows, ...suppressionEntries, ...verifierContributors]) {
    const wallet = identityWallet(row);
    const key = walletKey(wallet);
    if (key && !walletsByKey.has(key)) walletsByKey.set(key, wallet);
  }
  const walletKeys = [...walletsByKey.keys()].sort();
  const records = walletKeys.map((key) =>
    buildRecord(walletsByKey.get(key), {
      risk: riskByWallet.get(key),
      suppression: suppressionByWallet.get(key),
      verification: verifierByWallet.get(key),
      report: verifier,
      meta,
    })
  );
  return withSummary({
    schema: STATE_SCHEMA,
    generatedAt: runGeneratedAt,
    generatedBy: generatedBy(options),
    mode: MODE,
    readOnly: true,
    enforcementBoundary: {
      wouldMutateLiveRouting: false,
      wouldMoveFunds: false,
      wouldBanAccounts: false,
      wouldClawBackRewards: false,
      wouldDeploy: false,
      requiresHumanApprovalForAnyOperationalUse: true,
    },
    sources: {
      riskMatrix: {
        ...meta.riskMatrix,
        schema: safeText(matrix.schema),
        generatedAt: safeText(matrix.generatedAt),
        rows: riskRows.length,
      },
      suppressionConfig: {
        ...meta.suppressionConfig,
        schema: safeText(config.schema),
        generatedAt: safeText(config.generatedAt),
        entries: suppressionEntries.length,
      },
      verifierReport: {
        ...meta.verifierReport,
        schema: safeText(verifier.schema),
        generatedAt: safeText(verifier.generatedAt),
        contributors: verifierContributors.length,
      },
    },
    records,
  });
}

function summarizeRecords(records) {
  const byRiskBand = {};
  const bySuppressionStatus = {};
  const byVerificationStatus = {};
  const gapCounts = {};
  for (const record of records) {
    byRiskBand[record.risk.riskBand] = (byRiskBand[record.risk.riskBand] || 0) + 1;
    bySuppressionStatus[record.suppression.status] = (bySuppressionStatus[record.suppression.status] || 0) + 1;
    byVerificationStatus[record.verification.status] = (byVerificationStatus[record.verification.status] || 0) + 1;
    for (const gap of record.detectedGaps) gapCounts[gap] = (gapCounts[gap] || 0) + 1;
  }
  return {
    walletCount: records.length,
    riskBandCounts: byRiskBand,
    suppressionStatusCounts: bySuppressionStatus,
    verificationStatusCounts: byVerificationStatus,
    detectedGapCounts: gapCounts,
    walletsWithDetectedGaps: records.filter((record) => record.detectedGaps.length > 0).length,
    violatedWallets: records
      .filter((record) => record.verification.status === "violated")
      .map((record) => record.walletAddress)
      .sort(),
    noActionWallets: records
      .filter((record) => record.detectedGaps.length === 0)
      .map((record) => record.walletAddress)
      .sort(),
  };
}

function withSummary(state) {
  return {
    ...state,
    summary: summarizeRecords(state.records || []),
  };
}

function buildReport(state, options = {}) {
  const generated = generatedAt(options);
  const gapWallets = state.records
    .filter((record) => record.detectedGaps.length > 0)
    .map((record) => ({
      walletAddress: record.walletAddress,
      riskBand: record.risk.riskBand,
      riskScore: record.risk.riskScore,
      suppressionStatus: record.suppression.status,
      verificationStatus: record.verification.status,
      detectedGaps: record.detectedGaps,
      recommendedNextAction: record.recommendedNextAction,
    }));
  return {
    schema: REPORT_SCHEMA,
    generatedAt: generated,
    generatedBy: generatedBy(options),
    mode: MODE,
    readOnly: true,
    sourceState: {
      schema: state.schema,
      generatedAt: state.generatedAt,
      walletCount: state.summary.walletCount,
    },
    coverage: {
      walletCount: state.summary.walletCount,
      riskRows: state.sources?.riskMatrix?.rows ?? 0,
      suppressionEntries: state.sources?.suppressionConfig?.entries ?? 0,
      verifierContributors: state.sources?.verifierReport?.contributors ?? 0,
      riskBandsCovered: Object.keys(state.summary.riskBandCounts).sort(),
    },
    summary: state.summary,
    gapWallets,
    noActionWallets: state.summary.noActionWallets,
    enforcementBoundary: state.enforcementBoundary,
  };
}

function buildDiscordSummary(report) {
  const lines = [
    "@goodalexander Sybil enforcement state tracker report is ready.",
    "",
    `Mode: ${report.mode} (read-only; no enforcement executed)`,
    `Wallets tracked: ${report.coverage.walletCount}`,
    `Risk bands covered: ${report.coverage.riskBandsCovered.join(", ") || "none"}`,
    `Suppression entries: ${report.coverage.suppressionEntries}`,
    `Verifier contributor rows: ${report.coverage.verifierContributors}`,
    `Wallets with detected gaps: ${report.summary.walletsWithDetectedGaps}`,
    `Violated wallets: ${report.summary.violatedWallets.length}`,
    "",
  ];

  for (const item of report.gapWallets.slice(0, 12)) {
    lines.push(
      `- ${item.walletAddress}: ${item.riskBand}/${item.riskScore}; suppression=${item.suppressionStatus}; verification=${item.verificationStatus}; gaps=${item.detectedGaps.join(", ")}`
    );
  }
  if (report.gapWallets.length > 12) lines.push(`- ${report.gapWallets.length - 12} additional gap wallets omitted from this summary.`);

  lines.push(
    "",
    "Operational boundary: this package is for state tracking and human review only. No routing mutation, ban, blacklist, clawback, fund movement, signing, deployment, or live enforcement occurred."
  );
  return `${lines.join("\n")}\n`;
}

async function readState(filePath) {
  const state = await readJson(filePath, "State file");
  if (state.schema !== STATE_SCHEMA) {
    throw new Error(`State schema must be ${STATE_SCHEMA}; got ${safeText(state.schema, "missing")}`);
  }
  if (!Array.isArray(state.records)) throw new Error("State file must include records[]");
  return withSummary(state);
}

function manualRecord(options) {
  const wallet = requireOption(options, "wallet");
  const riskScoreOption = options["risk-score"] === undefined ? 0 : Number(options["risk-score"]);
  if (!Number.isFinite(riskScoreOption)) throw new Error("--risk-score must be numeric");
  const now = generatedAt(options);
  const gaps = uniqueStrings(options.gap);
  return {
    walletAddress: wallet,
    accountId: safeText(options["account-id"]),
    handle: normalizeHandle(options.handle),
    contributorKey: wallet,
    risk: {
      sourceTaskId: "manual",
      sourceCid: "",
      present: true,
      riskScore: numberValue(riskScoreOption, 0),
      riskBand: normalizeKey(options["risk-band"] || "unknown"),
      role: safeText(options.role),
      compositeScore: numberValue(options["risk-score"], 0),
      reviewPriorityScore: numberValue(options["risk-score"], 0),
      reasons: uniqueStrings(options.reason),
      recommendation: safeText(options.recommendation),
    },
    suppression: {
      sourceTaskId: "manual",
      sourceCid: "",
      present: options["suppression-status"] !== "not_suppressed",
      status: normalizeKey(options["suppression-status"] || "not_suppressed"),
      reason: safeText(options["suppression-reason"]),
      mode: MODE,
      operationalUseAllowed: false,
      requiresHumanApproval: true,
      supportingTaskIds: uniqueStrings(options["supporting-task-id"]),
    },
    verification: {
      sourceTaskId: "manual",
      sourceCid: "",
      present: Boolean(options["verification-status"]),
      status: normalizeKey(options["verification-status"] || "missing_verification"),
      lastVerifiedAt: options["last-verified-at"] ? ensureIsoTimestamp(options["last-verified-at"], "--last-verified-at") : now,
      finding: safeText(options.finding),
      allocationCounts: {},
      activePostSuppressionAllocations: [],
    },
    detectedGaps: gaps,
    recommendedNextAction: gaps.length ? recommendedAction(gaps) : "Manual record added; review before operational use.",
  };
}

async function runGenerate(options) {
  const matrix = await readJson(requireOption(options, "risk-matrix"), "Risk matrix");
  const config = await readJson(requireOption(options, "suppression-config"), "Suppression config");
  const verifier = await readJson(requireOption(options, "verifier-report"), "Verifier report");
  const state = buildState({ matrix, config, verifier, options });
  const report = buildReport(state, options);
  const summary = buildDiscordSummary(report);
  if (options["state-out"] && options["state-out"] !== true) await writeJson(String(options["state-out"]), state);
  if (options["report-out"] && options["report-out"] !== true) await writeJson(String(options["report-out"]), report);
  if (options["summary-out"] && options["summary-out"] !== true) await writeText(String(options["summary-out"]), summary);
  console.log(JSON.stringify({ ok: true, schema: STATE_SCHEMA, summary: state.summary, mode: MODE }, null, 2));
}

async function runBatch(options) {
  const outDir = requireOption(options, "out");
  const stateOut = path.join(outDir, "enforcement_state.json");
  const reportOut = path.join(outDir, "state_report.json");
  const summaryOut = path.join(outDir, "discord_summary.md");
  const matrix = await readJson(requireOption(options, "risk-matrix"), "Risk matrix");
  const config = await readJson(requireOption(options, "suppression-config"), "Suppression config");
  const verifier = await readJson(requireOption(options, "verifier-report"), "Verifier report");
  const state = buildState({ matrix, config, verifier, options });
  const report = buildReport(state, options);
  await mkdir(outDir, { recursive: true });
  await writeJson(stateOut, state);
  await writeJson(reportOut, report);
  await writeText(summaryOut, buildDiscordSummary(report));
  console.log(
    JSON.stringify(
      {
        ok: true,
        schema: BATCH_SCHEMA,
        outDir,
        files: ["enforcement_state.json", "state_report.json", "discord_summary.md"],
        summary: state.summary,
        mode: MODE,
      },
      null,
      2
    )
  );
}

async function runQuery(options) {
  const state = await readState(requireOption(options, "state"));
  const wallet = walletKey(requireOption(options, "wallet"));
  const record = state.records.find((item) => walletKey(item.walletAddress) === wallet);
  if (!record) throw new Error(`Wallet not found in state: ${options.wallet}`);
  console.log(JSON.stringify(record, null, 2));
}

async function runList(options) {
  const state = await readState(requireOption(options, "state"));
  const records = options["gap-only"] ? state.records.filter((record) => record.detectedGaps.length > 0) : state.records;
  console.log(
    JSON.stringify(
      {
        schema: `${STATE_SCHEMA}.list.v1`,
        count: records.length,
        records: records.map((record) => ({
          walletAddress: record.walletAddress,
          riskBand: record.risk.riskBand,
          riskScore: record.risk.riskScore,
          suppressionStatus: record.suppression.status,
          verificationStatus: record.verification.status,
          detectedGaps: record.detectedGaps,
        })),
      },
      null,
      2
    )
  );
}

async function runAdd(options) {
  const statePath = requireOption(options, "state");
  const state = await readState(statePath);
  const record = manualRecord(options);
  if (state.records.some((item) => walletKey(item.walletAddress) === walletKey(record.walletAddress))) {
    throw new Error(`Wallet already exists; use update instead: ${record.walletAddress}`);
  }
  const updated = withSummary({
    ...state,
    generatedAt: generatedAt(options),
    records: [...state.records, record].sort((left, right) => left.walletAddress.localeCompare(right.walletAddress)),
  });
  const outPath = options.out && options.out !== true ? String(options.out) : statePath;
  await writeJson(outPath, updated);
  console.log(JSON.stringify({ ok: true, action: "add", outPath, walletAddress: record.walletAddress, summary: updated.summary }, null, 2));
}

async function runUpdate(options) {
  const statePath = requireOption(options, "state");
  const state = await readState(statePath);
  const wallet = walletKey(requireOption(options, "wallet"));
  let matched = false;
  const updatedRecords = state.records.map((record) => {
    if (walletKey(record.walletAddress) !== wallet) return record;
    matched = true;
    const next = structuredClone(record);
    if (options["risk-score"] !== undefined) next.risk.riskScore = numberValue(options["risk-score"], next.risk.riskScore);
    if (options["risk-band"] !== undefined) next.risk.riskBand = normalizeKey(options["risk-band"]);
    if (options["suppression-status"] !== undefined) {
      next.suppression.status = normalizeKey(options["suppression-status"]);
      next.suppression.present = next.suppression.status !== "not_suppressed";
    }
    if (options["verification-status"] !== undefined) {
      next.verification.status = normalizeKey(options["verification-status"]);
      next.verification.present = next.verification.status !== "missing_verification";
    }
    if (options["last-verified-at"] !== undefined) {
      next.verification.lastVerifiedAt = ensureIsoTimestamp(options["last-verified-at"], "--last-verified-at");
    }
    if (options.gap !== undefined) next.detectedGaps = uniqueStrings(options.gap);
    next.recommendedNextAction = recommendedAction(next.detectedGaps);
    return next;
  });
  if (!matched) throw new Error(`Wallet not found in state: ${options.wallet}`);
  const updated = withSummary({ ...state, generatedAt: generatedAt(options), records: updatedRecords });
  const outPath = options.out && options.out !== true ? String(options.out) : statePath;
  await writeJson(outPath, updated);
  console.log(JSON.stringify({ ok: true, action: "update", outPath, walletAddress: options.wallet, summary: updated.summary }, null, 2));
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
  if (command === "batch") {
    await runBatch(options);
    return;
  }
  if (command === "query") {
    await runQuery(options);
    return;
  }
  if (command === "list") {
    await runList(options);
    return;
  }
  if (command === "add") {
    await runAdd(options);
    return;
  }
  if (command === "update") {
    await runUpdate(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
