#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const XRPL_WALLET_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const DROPS_PER_PFT = 1_000_000;
const DEFAULT_HIGH_RISK_THRESHOLD = 60;

const LINEAGE = [
  {
    taskId: "task_2ec03c162f35f5060453d1f5476fadf2",
    description: "XRPL Sybil Fund Flow Graph Script",
    rewardCid: "QmefkU6HW2okwUeuVVNuuDkwcNzGqfu7dyX3358RCX7QRr",
  },
  {
    taskId: "task_cc79625ec50467785ae070b1e4336fff",
    description: "Automated Sybil Blocklist Patch Generator",
    rewardCid: "QmbzyjFcUu4EHbW95GqBVKAeVJ3kUa8yGKY4nBmJxiRzUJ",
  },
  {
    taskId: "task_bab6bd892538d7d4fa0f7ac586b89929",
    description: "XRPL Wallet Linkage Graph Analyzer",
  },
];

function usage() {
  return `Usage:
  node scripts/xrpl-wallet-linkage-graph.mjs \\
    --transactions <transactions.json> \\
    [--graph <prior-flow-graph.json>] \\
    [--report <report.json>] \\
    [--summary <summary.md>] \\
    [--high-risk-threshold 60]

Inputs may be normalized rows with src/dst/amount_drops/timestamp fields or
XRPL account_tx rows with tx/meta/close_time_iso fields. The analyzer is
read-only and recommend-only: it calculates linkage metrics and review flags,
but never emits deployable blocklist, ban, clawback, or fund-movement actions.`;
}

function parseArgs(argv) {
  const args = {
    graph: null,
    highRiskThreshold: DEFAULT_HIGH_RISK_THRESHOLD,
    report: null,
    summary: null,
    transactions: null,
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

    if (arg === "--graph") {
      args.graph = next;
    } else if (arg === "--high-risk-threshold") {
      args.highRiskThreshold = Number(next);
      if (!Number.isFinite(args.highRiskThreshold) || args.highRiskThreshold < 0 || args.highRiskThreshold > 100) {
        throw new Error("--high-risk-threshold must be a number from 0 to 100");
      }
    } else if (arg === "--report") {
      args.report = next;
    } else if (arg === "--summary") {
      args.summary = next;
    } else if (arg === "--transactions") {
      args.transactions = next;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  if (!args.transactions) {
    throw new Error("--transactions is required");
  }
  return args;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read JSON from ${filePath}: ${error.message}`);
  }
}

function isWallet(value) {
  return typeof value === "string" && XRPL_WALLET_RE.test(value);
}

function amountDropsFromRecord(record) {
  const meta = record?.meta || {};
  const tx = record?.tx || record;
  const raw = meta.delivered_amount ?? tx.delivered_amount ?? tx.Amount ?? record.amount_drops ?? record.amountDrops;
  if (typeof raw === "object") {
    return null;
  }
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value).replace("+0000", "Z");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeTransaction(record, index) {
  const tx = record?.tx || record;
  const meta = record?.meta || {};
  const txType = tx.TransactionType || tx.tx_type || record.tx_type || "";
  const result = meta.TransactionResult || record.result || "tesSUCCESS";
  const src = tx.Account || tx.src || tx.source || record.src || record.source;
  const dst = tx.Destination || tx.dst || tx.destination || record.dst || record.destination;
  const amountDrops = amountDropsFromRecord(record);
  const txHash = tx.hash || tx.tx_hash || record.tx_hash || record.hash || `synthetic_${index}`;
  const timestamp = normalizeTimestamp(record.timestamp || record.close_time_iso || tx.date || record.date);

  if (txType && txType !== "Payment") {
    return { skipped: true, reason: "non_payment", txHash };
  }
  if (result !== "tesSUCCESS") {
    return { skipped: true, reason: "failed_transaction", txHash };
  }
  if (!isWallet(src) || !isWallet(dst)) {
    return { skipped: true, reason: "missing_or_invalid_wallet", txHash };
  }
  if (amountDrops === null) {
    return { skipped: true, reason: "non_native_or_invalid_amount", txHash };
  }

  return {
    amountPft: amountDrops / DROPS_PER_PFT,
    dst,
    src,
    timestamp,
    txHash,
  };
}

function collectTransactions(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  for (const key of ["transactions", "rows", "account_tx", "txs"]) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }
  return [];
}

function collectKnownWallets(inputPayload, graphPayload) {
  const known = new Map();
  const add = (wallet, clusterId = "known", source = "input") => {
    if (isWallet(wallet) && !known.has(wallet)) {
      known.set(wallet, { clusterId, source, wallet });
    }
  };

  for (const source of [
    ["input.flagged_wallets", inputPayload?.flagged_wallets],
    ["graph.flagged_wallets", graphPayload?.flagged_wallets],
  ]) {
    const [sourceName, wallets] = source;
    for (const wallet of Array.isArray(wallets) ? wallets : []) {
      add(wallet, inputPayload?.clusters?.[wallet] || graphPayload?.clusters?.[wallet] || "known", sourceName);
    }
  }

  for (const [wallet, clusterId] of Object.entries(inputPayload?.clusters || {})) {
    add(wallet, clusterId, "input.clusters");
  }
  for (const [wallet, clusterId] of Object.entries(graphPayload?.clusters || {})) {
    add(wallet, clusterId, "graph.clusters");
  }
  for (const node of Array.isArray(graphPayload?.nodes) ? graphPayload.nodes : []) {
    if (node?.flagged === true || node?.isFlagged === true || node?.type === "sybil") {
      add(node.wallet || node.address || node.id, node.cluster_id || node.clusterId || "known", "graph.nodes");
    }
  }

  return known;
}

function getNode(nodes, wallet, knownWallets) {
  if (!nodes.has(wallet)) {
    const known = knownWallets.get(wallet);
    nodes.set(wallet, {
      bridgeScore: 0,
      clusterId: known?.clusterId || null,
      degree: 0,
      degreeCentrality: 0,
      firstSeen: null,
      flaggedKnown: Boolean(known),
      inPft: 0,
      inTx: 0,
      lastSeen: null,
      outPft: 0,
      outTx: 0,
      peers: new Set(),
      wallet,
      weightedDegreePft: 0,
    });
  }
  return nodes.get(wallet);
}

function updateSeen(node, timestamp) {
  if (!timestamp) {
    return;
  }
  if (!node.firstSeen || timestamp < node.firstSeen) {
    node.firstSeen = timestamp;
  }
  if (!node.lastSeen || timestamp > node.lastSeen) {
    node.lastSeen = timestamp;
  }
}

function buildGraph(transactions, knownWallets) {
  const nodes = new Map();
  const edges = new Map();
  const seenTxHashes = new Set();
  const skipped = [];
  let duplicatesSkipped = 0;

  transactions.forEach((raw, index) => {
    const tx = normalizeTransaction(raw, index);
    if (tx.skipped) {
      skipped.push(tx);
      return;
    }
    if (seenTxHashes.has(tx.txHash)) {
      duplicatesSkipped += 1;
      return;
    }
    seenTxHashes.add(tx.txHash);

    const src = getNode(nodes, tx.src, knownWallets);
    const dst = getNode(nodes, tx.dst, knownWallets);
    src.outTx += 1;
    src.outPft += tx.amountPft;
    dst.inTx += 1;
    dst.inPft += tx.amountPft;
    src.peers.add(tx.dst);
    dst.peers.add(tx.src);
    updateSeen(src, tx.timestamp);
    updateSeen(dst, tx.timestamp);

    const edgeKey = `${tx.src}->${tx.dst}`;
    const edge = edges.get(edgeKey) || {
      amountPft: 0,
      firstSeen: null,
      lastSeen: null,
      source: tx.src,
      target: tx.dst,
      txHashes: [],
      txCount: 0,
    };
    edge.amountPft += tx.amountPft;
    edge.txCount += 1;
    edge.txHashes.push(tx.txHash);
    if (tx.timestamp && (!edge.firstSeen || tx.timestamp < edge.firstSeen)) {
      edge.firstSeen = tx.timestamp;
    }
    if (tx.timestamp && (!edge.lastSeen || tx.timestamp > edge.lastSeen)) {
      edge.lastSeen = tx.timestamp;
    }
    edges.set(edgeKey, edge);
  });

  const nodeCount = nodes.size;
  for (const node of nodes.values()) {
    node.degree = node.peers.size;
    node.degreeCentrality = nodeCount > 1 ? round(node.degree / (nodeCount - 1), 4) : 0;
    node.weightedDegreePft = round(node.inPft + node.outPft, 6);
  }

  return {
    duplicatesSkipped,
    edges,
    nodes,
    skipped,
    transactionsIncluded: seenTxHashes.size,
  };
}

function connectedComponents(nodes) {
  const components = [];
  const visited = new Set();
  for (const wallet of nodes.keys()) {
    if (visited.has(wallet)) {
      continue;
    }
    const stack = [wallet];
    const component = [];
    visited.add(wallet);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const peer of nodes.get(current)?.peers || []) {
        if (!visited.has(peer)) {
          visited.add(peer);
          stack.push(peer);
        }
      }
    }
    components.push(component.sort());
  }
  return components.sort((a, b) => b.length - a.length);
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function edgeCountWithin(edges, members) {
  const memberSet = new Set(members);
  let count = 0;
  let amountPft = 0;
  for (const edge of edges.values()) {
    if (memberSet.has(edge.source) && memberSet.has(edge.target)) {
      count += 1;
      amountPft += edge.amountPft;
    }
  }
  return { amountPft: round(amountPft, 6), count };
}

function buildClusterMetrics({ components, edges, knownWallets, nodes }) {
  return components.map((members, index) => {
    const knownMembers = members.filter((wallet) => knownWallets.has(wallet));
    const secondaryMembers = members.filter((wallet) => !knownWallets.has(wallet));
    const { amountPft, count } = edgeCountWithin(edges, members);
    const possibleDirectedEdges = members.length > 1 ? members.length * (members.length - 1) : 0;
    const density = possibleDirectedEdges ? round(count / possibleDirectedEdges, 4) : 0;
    const maxDegreeCentrality = Math.max(...members.map((wallet) => nodes.get(wallet)?.degreeCentrality || 0));
    return {
      amountPft,
      componentId: `component_${index + 1}`,
      density,
      directedEdgeCount: count,
      knownWalletCount: knownMembers.length,
      knownWallets: knownMembers,
      maxDegreeCentrality: round(maxDegreeCentrality, 4),
      possibleDirectedEdges,
      secondaryWalletCount: secondaryMembers.length,
      secondaryWallets: secondaryMembers,
      walletCount: members.length,
    };
  });
}

function adjacentKnownStats(wallet, nodes, edges, knownWallets) {
  const node = nodes.get(wallet);
  const knownPeers = [...(node?.peers || [])].filter((peer) => knownWallets.has(peer));
  let knownInPft = 0;
  let knownOutPft = 0;
  let knownInTx = 0;
  let knownOutTx = 0;
  for (const edge of edges.values()) {
    if (edge.target === wallet && knownWallets.has(edge.source)) {
      knownInPft += edge.amountPft;
      knownInTx += edge.txCount;
    }
    if (edge.source === wallet && knownWallets.has(edge.target)) {
      knownOutPft += edge.amountPft;
      knownOutTx += edge.txCount;
    }
  }
  return {
    knownInPft,
    knownInTx,
    knownOutPft,
    knownOutTx,
    knownPeers,
  };
}

function buildSecondaryRisk({ edges, highRiskThreshold, knownWallets, nodes }) {
  const candidates = [];
  const maxKnownAmount = Math.max(
    1,
    ...[...nodes.keys()].map((wallet) => {
      const stats = adjacentKnownStats(wallet, nodes, edges, knownWallets);
      return stats.knownInPft + stats.knownOutPft;
    })
  );

  for (const node of nodes.values()) {
    if (node.flaggedKnown) {
      continue;
    }
    const stats = adjacentKnownStats(node.wallet, nodes, edges, knownWallets);
    const adjacentKnownCount = stats.knownPeers.length;
    if (!adjacentKnownCount) {
      continue;
    }

    const isSharedFunder = stats.knownOutTx >= 2 && adjacentKnownCount >= 2;
    const isSharedSink = stats.knownInTx >= 2 && adjacentKnownCount >= 2;
    const bidirectionalKnown = stats.knownInTx > 0 && stats.knownOutTx > 0;
    const amountScore = ((stats.knownInPft + stats.knownOutPft) / maxKnownAmount) * 15;
    const riskScore = Math.min(
      100,
      (Math.min(adjacentKnownCount, 5) / 5) * 25 +
        (isSharedFunder ? 20 : 0) +
        (isSharedSink ? 20 : 0) +
        (bidirectionalKnown ? 15 : 0) +
        node.degreeCentrality * 15 +
        amountScore
    );

    const reasons = [];
    if (isSharedFunder) {
      reasons.push("funds multiple known-cluster wallets");
    }
    if (isSharedSink) {
      reasons.push("receives from multiple known-cluster wallets");
    }
    if (bidirectionalKnown) {
      reasons.push("has bidirectional flow with known-cluster wallets");
    }
    if (adjacentKnownCount >= 3) {
      reasons.push(`adjacent to ${adjacentKnownCount} known-cluster wallets`);
    }

    candidates.push({
      adjacentKnownCount,
      degreeCentrality: node.degreeCentrality,
      firstSeen: node.firstSeen,
      knownInPft: round(stats.knownInPft, 6),
      knownOutPft: round(stats.knownOutPft, 6),
      knownPeers: stats.knownPeers.sort(),
      lastSeen: node.lastSeen,
      reasons,
      recommendation:
        riskScore >= highRiskThreshold
          ? "review_raw_evidence_before_any_enforcement"
          : "monitor_or_sample_if_cluster_expands",
      riskBand: riskScore >= highRiskThreshold ? "high_review_priority" : "watch",
      riskScore: round(riskScore, 1),
      wallet: node.wallet,
      weightedDegreePft: node.weightedDegreePft,
    });
  }

  return candidates.sort((a, b) => b.riskScore - a.riskScore || a.wallet.localeCompare(b.wallet));
}

function serializableNodes(nodes) {
  return [...nodes.values()]
    .map((node) => ({
      bridgeScore: node.bridgeScore,
      clusterId: node.clusterId,
      degree: node.degree,
      degreeCentrality: node.degreeCentrality,
      firstSeen: node.firstSeen,
      flaggedKnown: node.flaggedKnown,
      inPft: round(node.inPft, 6),
      inTx: node.inTx,
      lastSeen: node.lastSeen,
      outPft: round(node.outPft, 6),
      outTx: node.outTx,
      peers: [...node.peers].sort(),
      wallet: node.wallet,
      weightedDegreePft: node.weightedDegreePft,
    }))
    .sort((a, b) => b.degreeCentrality - a.degreeCentrality || a.wallet.localeCompare(b.wallet));
}

function serializableEdges(edges) {
  return [...edges.values()]
    .map((edge) => ({
      amountPft: round(edge.amountPft, 6),
      firstSeen: edge.firstSeen,
      lastSeen: edge.lastSeen,
      source: edge.source,
      target: edge.target,
      txCount: edge.txCount,
      txHashes: edge.txHashes,
    }))
    .sort((a, b) => b.amountPft - a.amountPft || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
}

function buildReport({ args, graphPayload, inputPayload }) {
  const knownWallets = collectKnownWallets(inputPayload, graphPayload);
  const transactions = collectTransactions(inputPayload);
  const graph = buildGraph(transactions, knownWallets);
  const components = connectedComponents(graph.nodes);
  const clusterMetrics = buildClusterMetrics({
    components,
    edges: graph.edges,
    knownWallets,
    nodes: graph.nodes,
  });
  const secondaryRisk = buildSecondaryRisk({
    edges: graph.edges,
    highRiskThreshold: args.highRiskThreshold,
    knownWallets,
    nodes: graph.nodes,
  });

  const highRiskSecondaryWallets = secondaryRisk.filter((row) => row.riskScore >= args.highRiskThreshold);

  return {
    schema: "tasknode.xrpl_wallet_linkage_graph.v1",
    generatedAt: new Date().toISOString(),
    lineage: LINEAGE,
    inputs: {
      graph: args.graph ? path.resolve(args.graph) : null,
      transactions: path.resolve(args.transactions),
    },
    policy: {
      enforcementAllowed: false,
      highRiskThreshold: args.highRiskThreshold,
      mode: "recommend_only_read_only",
      note: "Risk flags are graph-review leads only. They are not bans, blocklist entries, clawback instructions, or proof of sybil behavior.",
    },
    ingest: {
      duplicatesSkipped: graph.duplicatesSkipped,
      rawTransactions: transactions.length,
      skipped: graph.skipped.length,
      skippedReasons: graph.skipped.reduce((acc, row) => {
        acc[row.reason] = (acc[row.reason] || 0) + 1;
        return acc;
      }, {}),
      transactionsIncluded: graph.transactionsIncluded,
    },
    graph: {
      clusterMetrics,
      components: components.map((members, index) => ({ componentId: `component_${index + 1}`, members })),
      edges: serializableEdges(graph.edges),
      nodes: serializableNodes(graph.nodes),
      stats: {
        components: components.length,
        directedEdges: graph.edges.size,
        highRiskSecondaryWallets: highRiskSecondaryWallets.length,
        knownWallets: knownWallets.size,
        nodes: graph.nodes.size,
        secondaryWallets: graph.nodes.size - knownWallets.size,
      },
    },
    secondaryRisk,
    summary: {
      highRiskSecondaryWallets: highRiskSecondaryWallets.map((row) => row.wallet),
      interpretation:
        highRiskSecondaryWallets.length > 0
          ? "Graph structure found secondary wallets with multi-wallet linkage to known clusters. Review raw evidence before any account action."
          : "No secondary wallets crossed the configured high-risk threshold in this sample.",
      status: highRiskSecondaryWallets.length > 0 ? "review_required" : "no_high_risk_secondary_wallets",
    },
  };
}

function buildSummary(report) {
  const lines = [];
  lines.push("# XRPL Wallet Linkage Graph Analyzer Summary");
  lines.push("");
  lines.push("@goodalexander review note: this is recommend-only graph evidence. It does not execute or propose a ban, blocklist patch, clawback, or fund movement.");
  lines.push("");
  lines.push(`Status: ${report.summary.status}`);
  lines.push(`Raw transactions: ${report.ingest.rawTransactions}`);
  lines.push(`Included transactions: ${report.ingest.transactionsIncluded}`);
  lines.push(`Nodes: ${report.graph.stats.nodes}`);
  lines.push(`Directed edges: ${report.graph.stats.directedEdges}`);
  lines.push(`Known-cluster wallets: ${report.graph.stats.knownWallets}`);
  lines.push(`High-risk secondary wallets: ${report.graph.stats.highRiskSecondaryWallets}`);
  lines.push("");
  lines.push("## High-Risk Secondary Wallets");
  lines.push("");
  if (!report.secondaryRisk.length) {
    lines.push("No secondary wallets touched a known-cluster wallet in this input.");
  } else {
    lines.push("| Wallet | Risk | Band | Known peers | Reasons | Recommendation |");
    lines.push("| --- | ---: | --- | ---: | --- | --- |");
    for (const row of report.secondaryRisk) {
      lines.push(
        `| ${row.wallet} | ${row.riskScore} | ${row.riskBand} | ${row.adjacentKnownCount} | ${
          row.reasons.join("; ") || "single known-cluster adjacency"
        } | ${row.recommendation} |`
      );
    }
  }
  lines.push("");
  lines.push("## Cluster Density");
  lines.push("");
  lines.push("| Component | Wallets | Known | Secondary | Density | PFT |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const cluster of report.graph.clusterMetrics) {
    lines.push(
      `| ${cluster.componentId} | ${cluster.walletCount} | ${cluster.knownWalletCount} | ${cluster.secondaryWalletCount} | ${cluster.density} | ${cluster.amountPft} |`
    );
  }
  lines.push("");
  lines.push("## Command");
  lines.push("");
  lines.push("```bash");
  lines.push(
    `node scripts/xrpl-wallet-linkage-graph.mjs --transactions ${report.inputs.transactions}${
      report.inputs.graph ? ` --graph ${report.inputs.graph}` : ""
    } --report <report.json> --summary <summary.md>`
  );
  lines.push("```");
  lines.push("");
  lines.push("## Boundary");
  lines.push("");
  lines.push("The output is a reviewer triage packet. It intentionally contains no deployable enforcement patch, no signing path, no blacklist mutation, and no clawback instruction.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function writeOutput(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPayload = await readJson(args.transactions);
  const graphPayload = args.graph ? await readJson(args.graph) : {};
  const report = buildReport({ args, graphPayload, inputPayload });
  const summary = buildSummary(report);

  if (args.report) {
    await writeOutput(args.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.summary) {
    await writeOutput(args.summary, summary);
  }

  console.log(
    JSON.stringify(
      {
        highRiskSecondaryWallets: report.summary.highRiskSecondaryWallets,
        report: args.report ? path.resolve(args.report) : null,
        secretPrinted: false,
        status: report.summary.status,
        summary: args.summary ? path.resolve(args.summary) : null,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
});
