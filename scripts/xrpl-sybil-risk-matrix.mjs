#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const XRPL_WALLET_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const DEFAULT_WEIGHTS = {
  centrality: 0.3,
  clusterDensity: 0.2,
  contagion: 0.5,
};
const DEFAULT_HIGH_RISK_THRESHOLD = 60;
const DEFAULT_WATCH_THRESHOLD = 40;

const LINEAGE = [
  {
    taskId: "task_bab6bd892538d7d4fa0f7ac586b89929",
    description: "XRPL Wallet Linkage Graph Analyzer",
    rewardCid: "QmefkU6HW2okwUeuVVNuuDkwcNzGqfu7dyX3358RCX7QRr",
  },
  {
    taskId: "task_d77a9dc367ff181ff9463f58d01362c9",
    description: "XRPL Contagion Risk Monitoring Script",
    rewardCid: "QmVpLdsySyxwrPY27kn5wmGp7nRpW4vF4X2W7NkU2FKwvW",
  },
  {
    taskId: "task_78bc0498dfcc292ed909b1da6743a1ba",
    description: "Unified XRPL Sybil Risk Matrix Script",
  },
];

function usage() {
  return `Usage:
  node scripts/xrpl-sybil-risk-matrix.mjs \\
    --linkage <xrpl-wallet-linkage-report.json> \\
    --contagion <xrpl-contagion-alerts.json> \\
    [--matrix <risk-matrix.json>] \\
    [--summary <summary.md>] \\
    [--centrality-weight 0.30] \\
    [--cluster-density-weight 0.20] \\
    [--contagion-weight 0.50] \\
    [--high-risk-threshold 60] \\
    [--watch-threshold 40]

The matrix is read-only and recommend-only. It combines linkage centrality,
cluster density, and contagion proximity into reviewer triage scores. It never
emits bans, blocklist mutations, clawback instructions, signing payloads, or
fund-movement actions.`;
}

function parseArgs(argv) {
  const args = {
    centralityWeight: DEFAULT_WEIGHTS.centrality,
    clusterDensityWeight: DEFAULT_WEIGHTS.clusterDensity,
    contagion: null,
    contagionWeight: DEFAULT_WEIGHTS.contagion,
    highRiskThreshold: DEFAULT_HIGH_RISK_THRESHOLD,
    linkage: null,
    matrix: null,
    summary: null,
    watchThreshold: DEFAULT_WATCH_THRESHOLD,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--centrality-weight") {
      args.centralityWeight = parseNonNegativeNumber(arg, next);
    } else if (arg === "--cluster-density-weight") {
      args.clusterDensityWeight = parseNonNegativeNumber(arg, next);
    } else if (arg === "--contagion") {
      args.contagion = next;
    } else if (arg === "--contagion-weight") {
      args.contagionWeight = parseNonNegativeNumber(arg, next);
    } else if (arg === "--high-risk-threshold") {
      args.highRiskThreshold = parseThreshold(arg, next);
    } else if (arg === "--linkage") {
      args.linkage = next;
    } else if (arg === "--matrix") {
      args.matrix = next;
    } else if (arg === "--summary") {
      args.summary = next;
    } else if (arg === "--watch-threshold") {
      args.watchThreshold = parseThreshold(arg, next);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  if (!args.linkage) {
    throw new Error("--linkage is required");
  }
  if (!args.contagion) {
    throw new Error("--contagion is required");
  }
  if (args.watchThreshold > args.highRiskThreshold) {
    throw new Error("--watch-threshold cannot exceed --high-risk-threshold");
  }

  const weightSum = args.centralityWeight + args.clusterDensityWeight + args.contagionWeight;
  if (weightSum <= 0) {
    throw new Error("At least one weight must be greater than zero");
  }

  return {
    ...args,
    weights: {
      centrality: args.centralityWeight / weightSum,
      clusterDensity: args.clusterDensityWeight / weightSum,
      contagion: args.contagionWeight / weightSum,
    },
  };
}

function parseThreshold(arg, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${arg} must be a number from 0 to 100`);
  }
  return value;
}

function parseNonNegativeNumber(arg, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${arg} must be a non-negative number`);
  }
  return value;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read JSON from ${filePath}: ${error.message}`);
  }
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function writeJson(filePath, payload) {
  await writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function isWallet(value) {
  return typeof value === "string" && XRPL_WALLET_RE.test(value);
}

function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function arrayByWallet(rows, key = "wallet") {
  const result = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const wallet = row?.[key];
    if (isWallet(wallet)) {
      result.set(wallet, row);
    }
  }
  return result;
}

function collectAlertsByWallet(alerts) {
  const result = new Map();
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    if (!isWallet(alert?.wallet)) {
      continue;
    }
    const walletAlerts = result.get(alert.wallet) || [];
    walletAlerts.push(alert);
    result.set(alert.wallet, walletAlerts);
  }
  return result;
}

function componentMetricsById(report) {
  const result = new Map();
  for (const metric of Array.isArray(report?.graph?.clusterMetrics) ? report.graph.clusterMetrics : []) {
    if (metric?.componentId) {
      result.set(metric.componentId, metric);
    }
  }
  for (const component of Array.isArray(report?.graph?.components) ? report.graph.components : []) {
    if (component?.componentId && !result.has(component.componentId)) {
      result.set(component.componentId, component);
    }
  }
  return result;
}

function walletComponents(report) {
  const result = new Map();
  const metrics = componentMetricsById(report);
  for (const component of Array.isArray(report?.graph?.components) ? report.graph.components : []) {
    const componentId = component?.componentId;
    const members = Array.isArray(component?.members) ? component.members : [];
    if (!componentId || !members.length) {
      continue;
    }
    const metric = metrics.get(componentId) || component;
    for (const wallet of members) {
      if (!isWallet(wallet)) {
        continue;
      }
      result.set(wallet, {
        amountPft: Number(metric.amountPft || 0),
        componentId,
        density: Number(metric.density || 0),
        directedEdgeCount: Number(metric.directedEdgeCount || 0),
        knownWalletCount: Number(metric.knownWalletCount || 0),
        possibleDirectedEdges: Number(metric.possibleDirectedEdges || 0),
        walletCount: Number(metric.walletCount || members.length),
      });
    }
  }
  return result;
}

function collectWallets(...sources) {
  const wallets = new Set();
  for (const source of sources) {
    if (source instanceof Map) {
      for (const wallet of source.keys()) {
        if (isWallet(wallet)) {
          wallets.add(wallet);
        }
      }
      continue;
    }
    for (const row of Array.isArray(source) ? source : []) {
      if (isWallet(row?.wallet)) {
        wallets.add(row.wallet);
      }
    }
  }
  return [...wallets].sort();
}

function maxAlertScore(alerts) {
  return Math.max(0, ...alerts.map((alert) => Number(alert.riskScore || 0)));
}

function mergeUniqueStrings(...values) {
  const merged = new Set();
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : []) {
      if (typeof item === "string" && item.trim()) {
        merged.add(item.trim());
      }
    }
  }
  return [...merged].sort();
}

function preferredNode(linkageNode, contagionNode) {
  return linkageNode || contagionNode || {};
}

function buildRiskRole({ alertScore, compositeScore, isKnownSource, riskLedgerRow, secondaryRiskRow }, args) {
  if (isKnownSource) {
    return "known_source_wallet";
  }
  if (alertScore >= args.highRiskThreshold || Number(riskLedgerRow?.riskScore || 0) >= args.highRiskThreshold) {
    return "contagion_review_lead";
  }
  if (secondaryRiskRow && compositeScore >= args.watchThreshold) {
    return "linkage_secondary_candidate";
  }
  if (compositeScore >= args.watchThreshold) {
    return "watch_wallet";
  }
  return "connected_wallet";
}

function riskBand(score, args) {
  if (score >= args.highRiskThreshold) {
    return "high_review_priority";
  }
  if (score >= args.watchThreshold) {
    return "watch";
  }
  return "low";
}

function recommendationFor(row) {
  if (row.role === "known_source_wallet") {
    return "confirm source labeling and raw transaction lineage before using as a seed risk source";
  }
  if (row.riskBand === "high_review_priority") {
    return "review raw transactions and operator identity before any enforcement decision";
  }
  if (row.riskBand === "watch") {
    return "monitor in future streams or sample raw evidence if the cluster expands";
  }
  return "no immediate action from this matrix alone";
}

function buildMatrix({ args, contagion, linkage }) {
  const linkageNodes = arrayByWallet(linkage?.graph?.nodes);
  const contagionNodes = arrayByWallet(contagion?.graph?.nodes);
  const secondaryRisk = arrayByWallet(linkage?.secondaryRisk);
  const riskLedger = arrayByWallet(contagion?.riskLedger);
  const alertsByWallet = collectAlertsByWallet(contagion?.alerts);
  const linkageComponents = walletComponents(linkage);
  const contagionComponents = walletComponents(contagion);
  const wallets = collectWallets(linkageNodes, contagionNodes, secondaryRisk, riskLedger, alertsByWallet);

  const rows = wallets.map((wallet) => {
    const linkageNode = linkageNodes.get(wallet);
    const contagionNode = contagionNodes.get(wallet);
    const node = preferredNode(linkageNode, contagionNode);
    const secondaryRiskRow = secondaryRisk.get(wallet);
    const riskLedgerRow = riskLedger.get(wallet);
    const alerts = alertsByWallet.get(wallet) || [];
    const linkageComponent = linkageComponents.get(wallet);
    const contagionComponent = contagionComponents.get(wallet);
    const component = contagionComponent || linkageComponent || {};
    const isKnownSource = Boolean(linkageNode?.flaggedKnown || contagionNode?.flaggedKnown);

    const centralityRaw = Number(linkageNode?.degreeCentrality ?? contagionNode?.degreeCentrality ?? 0);
    const centralityScore = clampScore(centralityRaw * 100);
    const clusterDensityRaw = Math.max(Number(linkageComponent?.density || 0), Number(contagionComponent?.density || 0));
    const clusterDensityScore = clampScore(clusterDensityRaw * 100);
    const alertScore = maxAlertScore(alerts);
    const riskLedgerScore = Number(riskLedgerRow?.riskScore || 0);
    const sourceScore = isKnownSource ? 100 : 0;
    const secondaryRiskScore = Number(secondaryRiskRow?.riskScore || 0);
    const contagionScore = clampScore(Math.max(alertScore, riskLedgerScore, sourceScore, secondaryRiskScore * 0.75));
    const compositeScore = round(
      centralityScore * args.weights.centrality +
        clusterDensityScore * args.weights.clusterDensity +
        contagionScore * args.weights.contagion,
      1
    );
    const reviewPriorityScore = round(Math.max(compositeScore, alertScore, riskLedgerScore, isKnownSource ? args.highRiskThreshold : 0), 1);

    const reasons = mergeUniqueStrings(
      isKnownSource ? ["known risk-source wallet from input artifact"] : [],
      alerts.flatMap((alert) => alert.reasons || []),
      riskLedgerRow?.reasons,
      secondaryRiskRow?.reasons,
      centralityScore >= 40 ? [`linkage centrality score ${round(centralityScore, 1)}`] : [],
      clusterDensityScore >= 15 ? [`cluster density score ${round(clusterDensityScore, 1)}`] : []
    );

    const role = buildRiskRole({ alertScore, compositeScore, isKnownSource, riskLedgerRow, secondaryRiskRow }, args);
    const row = {
      wallet,
      role,
      riskBand: riskBand(reviewPriorityScore, args),
      compositeScore,
      reviewPriorityScore,
      component: {
        amountPft: round(component.amountPft || 0, 6),
        componentId: component.componentId || null,
        directedEdgeCount: Number(component.directedEdgeCount || 0),
        knownWalletCount: Number(component.knownWalletCount || 0),
        walletCount: Number(component.walletCount || 0),
      },
      componentScores: {
        linkageCentrality: {
          rawDegreeCentrality: round(centralityRaw, 4),
          score: round(centralityScore, 1),
          source: linkageNode ? "linkage.graph.nodes" : contagionNode ? "contagion.graph.nodes" : "missing",
          weight: round(args.weights.centrality, 4),
        },
        clusterDensity: {
          rawDensity: round(clusterDensityRaw, 4),
          score: round(clusterDensityScore, 1),
          source: contagionComponent ? "contagion.graph.components" : linkageComponent ? "linkage.graph.components" : "missing",
          weight: round(args.weights.clusterDensity, 4),
        },
        contagionProximity: {
          alertIds: alerts.map((alert) => alert.alertId).filter(Boolean),
          knownPeers: mergeUniqueStrings(riskLedgerRow?.knownPeers, ...alerts.map((alert) => alert.knownPeers)),
          priorRiskPeers: mergeUniqueStrings(riskLedgerRow?.priorRiskPeers, ...alerts.map((alert) => alert.priorRiskPeers)),
          riskLedgerScore: round(riskLedgerScore, 1),
          score: round(contagionScore, 1),
          source: alerts.length
            ? "contagion.alerts"
            : riskLedgerRow
              ? "contagion.riskLedger"
              : isKnownSource
                ? "known_source_artifact"
                : secondaryRiskRow
                  ? "linkage.secondaryRisk_discounted"
                  : "missing",
          weight: round(args.weights.contagion, 4),
        },
      },
      firstSeen: node.firstSeen || null,
      lastSeen: node.lastSeen || null,
      reasons,
      recommendation: "",
      transactionMetrics: {
        inPft: round(node.inPft || 0, 6),
        inTx: Number(node.inTx || 0),
        outPft: round(node.outPft || 0, 6),
        outTx: Number(node.outTx || 0),
        weightedDegreePft: round(node.weightedDegreePft || 0, 6),
      },
    };
    row.recommendation = recommendationFor(row);
    return row;
  });

  rows.sort((a, b) => b.reviewPriorityScore - a.reviewPriorityScore || b.compositeScore - a.compositeScore || a.wallet.localeCompare(b.wallet));
  return rows;
}

function buildReport({ args, contagion, linkage }) {
  const riskMatrix = buildMatrix({ args, contagion, linkage });
  const highReviewPriority = riskMatrix.filter((row) => row.riskBand === "high_review_priority");
  const watch = riskMatrix.filter((row) => row.riskBand === "watch");
  const knownSourceWallets = riskMatrix.filter((row) => row.role === "known_source_wallet");
  const contagionReviewLeads = riskMatrix.filter((row) => row.role === "contagion_review_lead");

  return {
    schema: "tasknode.xrpl_sybil_risk_matrix.v1",
    generatedAt: new Date().toISOString(),
    lineage: LINEAGE,
    inputs: {
      contagion: path.resolve(args.contagion),
      contagionSchema: contagion?.schema || null,
      linkage: path.resolve(args.linkage),
      linkageSchema: linkage?.schema || null,
    },
    policy: {
      enforcementAllowed: false,
      highRiskThreshold: args.highRiskThreshold,
      mode: "recommend_only_read_only_matrix",
      note:
        "Scores are review triage leads only. They are not bans, blocklist entries, clawback instructions, proof of sybil behavior, or fund-movement actions.",
      watchThreshold: args.watchThreshold,
    },
    weights: args.weights,
    stats: {
      contagionAlerts: Array.isArray(contagion?.alerts) ? contagion.alerts.length : 0,
      contagionReviewLeads: contagionReviewLeads.length,
      highReviewPriority: highReviewPriority.length,
      knownSourceWallets: knownSourceWallets.length,
      linkageNodes: Array.isArray(linkage?.graph?.nodes) ? linkage.graph.nodes.length : 0,
      totalWallets: riskMatrix.length,
      watch: watch.length,
    },
    riskMatrix,
    summary: {
      highestRiskWallets: riskMatrix.slice(0, 8).map((row) => ({
        wallet: row.wallet,
        compositeScore: row.compositeScore,
        reviewPriorityScore: row.reviewPriorityScore,
        role: row.role,
        riskBand: row.riskBand,
      })),
      interpretation:
        highReviewPriority.length > 0
          ? "The unified matrix found high-priority review leads. Review raw transaction lineage and operator identity before any enforcement."
          : "No wallet crossed the configured high-priority threshold in this matrix.",
      status: highReviewPriority.length > 0 ? "review_required" : "no_high_priority_wallets",
    },
  };
}

function buildSummary(report) {
  const lines = [];
  lines.push("# Unified XRPL Sybil Risk Matrix Summary");
  lines.push("");
  lines.push("@goodalexander review note: this is a recommend-only aggregation output. It contains no blocklist mutation, ban, clawback, signing path, or fund movement.");
  lines.push("");
  lines.push(`Status: ${report.summary.status}`);
  lines.push(`Wallets scored: ${report.stats.totalWallets}`);
  lines.push(`Known source wallets: ${report.stats.knownSourceWallets}`);
  lines.push(`Contagion review leads: ${report.stats.contagionReviewLeads}`);
  lines.push(`High-priority rows: ${report.stats.highReviewPriority}`);
  lines.push(`Watch rows: ${report.stats.watch}`);
  lines.push(
    `Weights: centrality ${round(report.weights.centrality, 2)}, cluster density ${round(
      report.weights.clusterDensity,
      2
    )}, contagion proximity ${round(report.weights.contagion, 2)}`
  );
  lines.push("");
  lines.push("## Top Wallets");
  lines.push("");
  lines.push("| Wallet | Composite | Priority | Band | Role | Centrality | Density | Contagion | Recommendation |");
  lines.push("| --- | ---: | ---: | --- | --- | ---: | ---: | ---: | --- |");
  for (const row of report.riskMatrix.slice(0, 10)) {
    lines.push(
      `| ${row.wallet} | ${row.compositeScore} | ${row.reviewPriorityScore} | ${row.riskBand} | ${row.role} | ${row.componentScores.linkageCentrality.score} | ${row.componentScores.clusterDensity.score} | ${row.componentScores.contagionProximity.score} | ${row.recommendation} |`
    );
  }
  lines.push("");
  lines.push("## How Scores Were Derived");
  lines.push("");
  lines.push("- Linkage centrality score = linkage graph degreeCentrality * 100.");
  lines.push("- Cluster density score = max observed component density from linkage or contagion graph * 100.");
  lines.push("- Contagion proximity score = max of live alert risk, final contagion risk ledger score, known-source seed score, or discounted linkage secondary-risk score.");
  lines.push("- Composite score = weighted sum of those three component scores using the reported weights.");
  lines.push("- Review priority score = max of composite score and direct live/high-source risk scores, so high-alert wallets are not hidden by lower centrality or density.");
  lines.push("");
  lines.push("## Command");
  lines.push("");
  lines.push("```bash");
  lines.push(
    `node scripts/xrpl-sybil-risk-matrix.mjs --linkage ${report.inputs.linkage} --contagion ${report.inputs.contagion} --matrix <risk-matrix.json> --summary <summary.md>`
  );
  lines.push("```");
  lines.push("");
  lines.push("## Boundary");
  lines.push("");
  lines.push("This artifact is local analysis for reviewer triage. It does not write to Task Node state, XRPL, a blocklist, or any enforcement system.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const linkage = await readJson(args.linkage);
  const contagion = await readJson(args.contagion);
  const report = buildReport({ args, contagion, linkage });

  if (args.matrix) {
    await writeJson(args.matrix, report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  if (args.summary) {
    await writeText(args.summary, buildSummary(report));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
