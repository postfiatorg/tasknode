#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RISK_MATRIX_SCHEMA = "tasknode.xrpl_sybil_risk_matrix.v1";
const SUPPRESSION_CONFIG_SCHEMA = "pf.orc.contributor_routing_suppression_config.v1";
const ENFORCEMENT_STATE_SCHEMA = "pf.orc.sybil_enforcement_state.v1";
const AUDIT_REPORT_SCHEMA = "pf.orc.sybil_enforcement_provenance_audit.v1";
const TIMELINES_SCHEMA = "pf.orc.sybil_enforcement_wallet_timelines.v1";
const METRICS_SCHEMA = "pf.orc.sybil_enforcement_provenance_metrics.v1";

const SOURCE_DEFAULTS = {
  riskMatrix: {
    taskId: "task_78bc0498dfcc292ed909b1da6743a1ba",
    cid: "QmcLKpe9ckisrEhc4tps4xiwuQLsBM7rD5eBRWhBJUkEgB",
  },
  suppressionConfig: {
    taskId: "task_e2473aa56887d24f354d008c553ffc57",
    cid: "QmczB9qF2TfMs9ZDsLbx8gasowsp92EmAXzAj4Cej26xRL",
  },
  enforcementState: {
    taskId: "task_237cd8157cf717e90bdaf5c889d36356",
    cid: "QmfPtUP4hDUejirB1FRmaW1faNmxrKpwBnCDsRekiRZhCR",
  },
};

function usage() {
  return `Usage:
  node scripts/orc-sybil-provenance-audit-trail.mjs audit \\
    --risk-matrix <risk-matrix.json> \\
    --suppression-config <suppression-config.json> \\
    --enforcement-state <enforcement-state.json> \\
    --out <dir> [--generated-by grashnuk] [--generated-at ISO]

Outputs:
  provenance_audit_report.json
  wallet_timelines.json
  provenance_metrics.json
  discord_summary.md

This is a read-only provenance audit. It never mutates live routing, signs
transactions, bans accounts, moves funds, claws back rewards, deploys, or
executes enforcement.`;
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
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
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

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : fallback;
}

function ensureIsoTimestamp(value, label) {
  const timestamp = safeText(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function timestampOrFallback(value, fallback) {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function hoursBetween(left, right) {
  if (!left || !right) return null;
  const delta = Date.parse(right) - Date.parse(left);
  if (!Number.isFinite(delta) || delta < 0) return null;
  return Number((delta / 36e5).toFixed(4));
}

async function readJson(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

async function writeJson(filePath, payload) {
  await writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function validateSchema(payload, expected, label) {
  if (payload?.schema !== expected) {
    throw new Error(`${label} schema must be ${expected}; got ${safeText(payload?.schema || "missing")}`);
  }
}

function identityWallet(row = {}) {
  return safeText(row.wallet || row.walletAddress || row.contributorKey || row.accountId || row.handle, 200);
}

function mapByWallet(rows) {
  const mapped = new Map();
  for (const row of rows) {
    const wallet = identityWallet(row);
    if (wallet) mapped.set(wallet.toLowerCase(), row);
  }
  return mapped;
}

function sourceMeta(payload, sourceName, options) {
  const defaults = SOURCE_DEFAULTS[sourceName];
  return {
    taskId: safeText(options[`${sourceName}-task-id`] || defaults.taskId),
    cid: safeText(options[`${sourceName}-cid`] || defaults.cid),
    schema: safeText(payload.schema),
    generatedAt: safeText(payload.generatedAt),
  };
}

function fieldMap() {
  return {
    riskMatrix: {
      flagging: [
        "riskMatrix[].wallet",
        "riskMatrix[].riskBand",
        "riskMatrix[].reviewPriorityScore",
        "riskMatrix[].firstSeen",
        "riskMatrix[].reasons",
        "riskMatrix[].recommendation",
      ],
    },
    suppressionConfig: {
      suppression: [
        "entries[].walletAddress",
        "entries[].status",
        "entries[].generatedAt",
        "entries[].expiresAt",
        "entries[].suppressionReason",
        "entries[].requiresHumanApproval",
        "entries[].operationalUseAllowed",
      ],
      clearance: [
        "entries[].status = cleared|suppression_cleared|expired",
        "entries[].updatedAt",
        "entries[].expiresAt",
      ],
    },
    enforcementState: {
      enforcement: [
        "records[].verification.status",
        "records[].verification.lastVerifiedAt",
        "records[].verification.finding",
        "records[].verification.activePostSuppressionAllocations",
      ],
      gaps: [
        "records[].detectedGaps[]",
        "records[].recommendedNextAction",
      ],
    },
  };
}

function riskRows(payload) {
  validateSchema(payload, RISK_MATRIX_SCHEMA, "Risk matrix");
  if (!Array.isArray(payload.riskMatrix)) throw new Error("Risk matrix must include riskMatrix[]");
  return payload.riskMatrix;
}

function suppressionRows(payload) {
  validateSchema(payload, SUPPRESSION_CONFIG_SCHEMA, "Suppression config");
  if (!Array.isArray(payload.entries)) throw new Error("Suppression config must include entries[]");
  return payload.entries;
}

function enforcementRows(payload) {
  validateSchema(payload, ENFORCEMENT_STATE_SCHEMA, "Enforcement state");
  if (!Array.isArray(payload.records)) throw new Error("Enforcement state must include records[]");
  return payload.records;
}

function riskScore(row) {
  return numberValue(row?.reviewPriorityScore ?? row?.risk?.reviewPriorityScore ?? row?.risk?.riskScore ?? row?.compositeScore, 0);
}

function riskBand(row) {
  return normalizeKey(row?.riskBand || row?.risk?.riskBand || "unknown");
}

function suppressionStatus(row) {
  if (!row) return "not_suppressed";
  const status = normalizeKey(row.status || row.suppression?.status || "unknown");
  if (status.includes("clear")) return "cleared";
  if (status.includes("expired")) return "expired";
  if (status.includes("recommended")) return "suppression_recommended";
  if (status.includes("suppressed")) return "suppressed";
  return status;
}

function verificationStatus(row) {
  if (!row) return "missing_verification";
  return normalizeKey(row.verification?.status || row.verificationStatus || "missing_verification");
}

function isClearanceStatus(status) {
  return ["cleared", "expired", "clearance_recorded", "suppression_cleared"].includes(normalizeKey(status));
}

function event({ type, at, source, summary, status = "", severity = "", fields = {} }) {
  return {
    type,
    at,
    source,
    status,
    severity,
    summary,
    fields,
  };
}

function walletEvents({ wallet, risk, suppression, enforcement, sources, generatedAt }) {
  const events = [];
  if (risk) {
    events.push(event({
      type: "flagging",
      at: timestampOrFallback(risk.firstSeen || risk.generatedAt, sources.riskMatrix.generatedAt || generatedAt),
      source: sources.riskMatrix,
      status: riskBand(risk),
      severity: riskBand(risk),
      summary: `Risk matrix flagged ${wallet} as ${riskBand(risk)} with score ${riskScore(risk)}.`,
      fields: {
        wallet,
        riskBand: riskBand(risk),
        riskScore: riskScore(risk),
        reasons: asArray(risk.reasons),
        recommendation: safeText(risk.recommendation),
      },
    }));
  }
  if (suppression) {
    const status = suppressionStatus(suppression);
    events.push(event({
      type: isClearanceStatus(status) ? "clearance" : "suppression",
      at: timestampOrFallback(suppression.updatedAt || suppression.generatedAt || suppression.expiresAt, sources.suppressionConfig.generatedAt || generatedAt),
      source: sources.suppressionConfig,
      status,
      severity: status,
      summary: isClearanceStatus(status)
        ? `Suppression clearance state recorded for ${wallet}: ${status}.`
        : `Suppression state recorded for ${wallet}: ${status}.`,
      fields: {
        wallet,
        status,
        reason: safeText(suppression.suppressionReason),
        expiresAt: safeText(suppression.expiresAt),
        requiresHumanApproval: suppression.requiresHumanApproval !== false,
        operationalUseAllowed: Boolean(suppression.operationalUseAllowed),
        supportingTaskIds: asArray(suppression.supportingTaskIds),
      },
    }));
  }
  if (enforcement?.verification?.present !== false && enforcement?.verification) {
    const status = verificationStatus(enforcement);
    events.push(event({
      type: isClearanceStatus(status) ? "clearance" : "enforcement_verification",
      at: timestampOrFallback(enforcement.verification.lastVerifiedAt, sources.enforcementState.generatedAt || generatedAt),
      source: sources.enforcementState,
      status,
      severity: status === "violated" ? "high" : status,
      summary: `Enforcement verification for ${wallet}: ${status}.`,
      fields: {
        wallet,
        status,
        finding: safeText(enforcement.verification.finding),
        activePostSuppressionAllocations: asArray(enforcement.verification.activePostSuppressionAllocations),
        allocationCounts: enforcement.verification.allocationCounts || {},
      },
    }));
  }
  for (const gap of asArray(enforcement?.detectedGaps)) {
    events.push(event({
      type: "gap_detected",
      at: timestampOrFallback(enforcement.updatedAt, sources.enforcementState.generatedAt || generatedAt),
      source: sources.enforcementState,
      status: normalizeKey(gap),
      severity: normalizeKey(gap).includes("violated") ? "high" : "medium",
      summary: `Detected gap for ${wallet}: ${gap}.`,
      fields: {
        wallet,
        gap,
        recommendedNextAction: safeText(enforcement.recommendedNextAction),
      },
    }));
  }
  return events.sort((left, right) => {
    const byTime = Date.parse(left.at) - Date.parse(right.at);
    if (byTime !== 0) return byTime;
    return left.type.localeCompare(right.type);
  });
}

function currentAction({ risk, suppression, enforcement, events }) {
  const gaps = asArray(enforcement?.detectedGaps);
  if (verificationStatus(enforcement) === "violated" || gaps.some((gap) => normalizeKey(gap).includes("violated"))) {
    return "Escalate suspected post-suppression allocation to Nazgul/Sauron for human review; do not auto-enforce.";
  }
  if (gaps.length > 0) {
    return "Review detected provenance gaps before operational use; do not auto-enforce.";
  }
  if (!suppression && riskScore(risk) >= 60) {
    return "Prepare recommend-only suppression review packet; do not operationalize without approval.";
  }
  if (suppression && verificationStatus(enforcement) === "missing_verification") {
    return "Refresh allocation verification before making any enforcement claim.";
  }
  if (events.some((item) => item.type === "clearance")) return "Clearance path recorded; continue monitoring.";
  return "No action beyond continued monitoring.";
}

function velocity(events) {
  const flag = events.find((item) => item.type === "flagging")?.at || "";
  const suppression = events.find((item) => item.type === "suppression")?.at || "";
  const verification = events.find((item) => item.type === "enforcement_verification")?.at || "";
  const clearance = events.find((item) => item.type === "clearance")?.at || "";
  return {
    flagToSuppressionHours: hoursBetween(flag, suppression),
    suppressionToVerificationHours: hoursBetween(suppression, verification),
    flagToClearanceHours: hoursBetween(flag, clearance),
  };
}

function timelineRow({ wallet, risk, suppression, enforcement, events }) {
  return {
    wallet,
    riskBand: riskBand(risk),
    riskScore: riskScore(risk),
    suppressionStatus: suppressionStatus(suppression),
    verificationStatus: verificationStatus(enforcement),
    eventCount: events.length,
    firstEventAt: events[0]?.at || "",
    lastEventAt: events[events.length - 1]?.at || "",
    velocityHours: velocity(events),
    recommendedNextAction: currentAction({ risk, suppression, enforcement, events }),
    events,
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

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return null;
  return Number((filtered.reduce((sum, value) => sum + value, 0) / filtered.length).toFixed(4));
}

function metrics(timelines) {
  const events = timelines.flatMap((timeline) => timeline.events);
  return {
    schema: METRICS_SCHEMA,
    summary: {
      walletCount: timelines.length,
      eventCount: events.length,
      riskLevelCounts: countBy(timelines, (timeline) => timeline.riskBand),
      suppressionStatusCounts: countBy(timelines, (timeline) => timeline.suppressionStatus),
      verificationStatusCounts: countBy(timelines, (timeline) => timeline.verificationStatus),
      eventTypeCounts: countBy(events, (item) => item.type),
      clearanceWallets: timelines.filter((timeline) => timeline.events.some((item) => item.type === "clearance")).length,
      violationWallets: timelines.filter((timeline) => timeline.verificationStatus === "violated").length,
      walletsNeedingHumanReview: timelines.filter((timeline) =>
        /Escalate|Refresh|Prepare|Review/.test(timeline.recommendedNextAction)
      ).length,
      averageVelocityHours: {
        flagToSuppression: average(timelines.map((timeline) => timeline.velocityHours.flagToSuppressionHours)),
        suppressionToVerification: average(timelines.map((timeline) => timeline.velocityHours.suppressionToVerificationHours)),
        flagToClearance: average(timelines.map((timeline) => timeline.velocityHours.flagToClearanceHours)),
      },
    },
  };
}

function discordSummary(report) {
  const lines = [
    "@goodalexander Sybil enforcement provenance audit trail is ready.",
    "",
    `Wallets audited: ${report.metrics.summary.walletCount}`,
    `Timeline events: ${report.metrics.summary.eventCount}`,
    `Clearance wallets: ${report.metrics.summary.clearanceWallets}`,
    `Violation wallets: ${report.metrics.summary.violationWallets}`,
    `Wallets needing human review: ${report.metrics.summary.walletsNeedingHumanReview}`,
    "",
    "Risk levels:",
  ];
  for (const [risk, count] of Object.entries(report.metrics.summary.riskLevelCounts)) {
    lines.push(`- ${risk}: ${count}`);
  }
  lines.push("", "Top human-review timelines:");
  for (const timeline of report.timelines
    .filter((item) => /Escalate|Refresh|Prepare|Review/.test(item.recommendedNextAction))
    .slice(0, 5)) {
    lines.push(`- ${timeline.wallet}: ${timeline.recommendedNextAction}`);
  }
  lines.push(
    "",
    "Generated artifacts:",
    "- provenance_audit_report.json",
    "- wallet_timelines.json",
    "- provenance_metrics.json",
    "- discord_summary.md",
    "",
    "Safety: read-only, recommend-only, no live routing mutation, no bans, no clawbacks, no fund movement."
  );
  return `${lines.join("\n")}\n`;
}

function buildReport({ riskMatrix, suppressionConfig, enforcementState, options }) {
  const generatedAt = options["generated-at"]
    ? ensureIsoTimestamp(options["generated-at"], "--generated-at")
    : new Date().toISOString();
  const generatedBy = safeText(options["generated-by"] || "grashnuk").replace(/^@+/, "") || "grashnuk";
  const risk = riskRows(riskMatrix);
  const suppression = suppressionRows(suppressionConfig);
  const enforcement = enforcementRows(enforcementState);
  const sources = {
    riskMatrix: sourceMeta(riskMatrix, "riskMatrix", options),
    suppressionConfig: sourceMeta(suppressionConfig, "suppressionConfig", options),
    enforcementState: sourceMeta(enforcementState, "enforcementState", options),
  };
  const riskByWallet = mapByWallet(risk);
  const suppressionByWallet = mapByWallet(suppression);
  const enforcementByWallet = mapByWallet(enforcement);
  const wallets = [...new Set([
    ...riskByWallet.keys(),
    ...suppressionByWallet.keys(),
    ...enforcementByWallet.keys(),
  ])].sort();
  const timelines = wallets.map((walletKey) => {
    const riskRow = riskByWallet.get(walletKey);
    const suppressionRow = suppressionByWallet.get(walletKey);
    const enforcementRow = enforcementByWallet.get(walletKey);
    const wallet = identityWallet(riskRow || suppressionRow || enforcementRow);
    const events = walletEvents({
      wallet,
      risk: riskRow,
      suppression: suppressionRow,
      enforcement: enforcementRow,
      sources,
      generatedAt,
    });
    return timelineRow({
      wallet,
      risk: riskRow,
      suppression: suppressionRow,
      enforcement: enforcementRow,
      events,
    });
  });
  const reportMetrics = metrics(timelines);
  return {
    schema: AUDIT_REPORT_SCHEMA,
    generatedAt,
    generatedBy,
    mode: "read_only_recommend_only_provenance_audit",
    readOnly: true,
    operationalUseAllowed: false,
    sourceFieldMap: fieldMap(),
    sources,
    coverage: {
      riskRows: risk.length,
      suppressionEntries: suppression.length,
      enforcementRecords: enforcement.length,
      walletCount: timelines.length,
    },
    metrics: reportMetrics,
    timelines,
    enforcementBoundary: {
      wouldMutateLiveRouting: false,
      wouldMoveFunds: false,
      wouldBanAccounts: false,
      wouldClawBackRewards: false,
      wouldDeploy: false,
      requiresHumanApprovalForAnyOperationalUse: true,
    },
  };
}

async function audit(options) {
  const riskMatrix = await readJson(requireOption(options, "risk-matrix"), "Risk matrix");
  const suppressionConfig = await readJson(requireOption(options, "suppression-config"), "Suppression config");
  const enforcementState = await readJson(requireOption(options, "enforcement-state"), "Enforcement state");
  const outDir = requireOption(options, "out");
  const report = buildReport({ riskMatrix, suppressionConfig, enforcementState, options });
  const timelines = {
    schema: TIMELINES_SCHEMA,
    generatedAt: report.generatedAt,
    generatedBy: report.generatedBy,
    sources: report.sources,
    timelines: report.timelines,
  };
  await mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, "provenance_audit_report.json"), report);
  await writeJson(path.join(outDir, "wallet_timelines.json"), timelines);
  await writeJson(path.join(outDir, "provenance_metrics.json"), report.metrics);
  await writeText(path.join(outDir, "discord_summary.md"), discordSummary(report));
  return {
    ok: true,
    schema: AUDIT_REPORT_SCHEMA,
    outDir,
    walletCount: report.metrics.summary.walletCount,
    eventCount: report.metrics.summary.eventCount,
    clearanceWallets: report.metrics.summary.clearanceWallets,
    violationWallets: report.metrics.summary.violationWallets,
    walletsNeedingHumanReview: report.metrics.summary.walletsNeedingHumanReview,
    files: [
      "provenance_audit_report.json",
      "wallet_timelines.json",
      "provenance_metrics.json",
      "discord_summary.md",
    ],
    safety: report.enforcementBoundary,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help || options.h) {
    console.log(usage());
    return;
  }
  if (command !== "audit") throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(await audit(options), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
