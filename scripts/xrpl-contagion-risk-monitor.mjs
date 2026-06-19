#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const XRPL_WALLET_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const DROPS_PER_PFT = 1_000_000;
const DEFAULT_HIGH_RISK_THRESHOLD = 60;
const DEFAULT_WATCH_THRESHOLD = 40;

const LINEAGE = [
  {
    taskId: "task_bab6bd892538d7d4fa0f7ac586b89929",
    description: "XRPL Wallet Linkage Graph Analyzer",
    rewardCid: "QmdZ99NTL6CUtrRr4xApf4rMwzgsALutkqDEizVaFk2AoR",
  },
  {
    taskId: "task_2ec03c162f35f5060453d1f5476fadf2",
    description: "XRPL Sybil Fund Flow Graph Script",
    rewardCid: "QmefkU6HW2okwUeuVVNuuDkwcNzGqfu7dyX3358RCX7QRr",
  },
  {
    taskId: "task_2285dae2ad470ea16fdb47ed0390f84f",
    description: "Prior reward-integrity Sybil lineage",
  },
];

function usage() {
  return `Usage:
  node scripts/xrpl-contagion-risk-monitor.mjs \\
    --events <events.json> \\
    [--baseline <xrpl-wallet-linkage-report.json>] \\
    [--alerts <alerts.json>] \\
    [--summary <summary.md>] \\
    [--state-out <state.json>] \\
    [--high-risk-threshold 60] \\
    [--watch-threshold 40]

Inputs may be normalized rows with src/dst/amount_drops/timestamp fields,
XRPL account_tx rows, or event records wrapping those rows in a tx/transaction
field. The monitor is read-only and recommend-only: it updates local linkage
state, emits review alerts, and never mutates blocklists, bans, clawbacks, or
fund movements.`;
}

function parseArgs(argv) {
  const args = {
    alerts: null,
    baseline: null,
    events: null,
    highRiskThreshold: DEFAULT_HIGH_RISK_THRESHOLD,
    stateOut: null,
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

    if (arg === "--alerts") {
      args.alerts = next;
    } else if (arg === "--baseline") {
      args.baseline = next;
    } else if (arg === "--events" || arg === "--transactions") {
      args.events = next;
    } else if (arg === "--high-risk-threshold") {
      args.highRiskThreshold = parseThreshold(arg, next);
    } else if (arg === "--state-out") {
      args.stateOut = next;
    } else if (arg === "--summary") {
      args.summary = next;
    } else if (arg === "--watch-threshold") {
      args.watchThreshold = parseThreshold(arg, next);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  if (!args.events) {
    throw new Error("--events is required");
  }
  if (args.watchThreshold > args.highRiskThreshold) {
    throw new Error("--watch-threshold cannot exceed --high-risk-threshold");
  }

  return args;
}

function parseThreshold(arg, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${arg} must be a number from 0 to 100`);
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
  return Number(value.toFixed(digits));
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(String(value).replace("+0000", "Z"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function amountDropsFromRecord(record) {
  const meta = record?.meta || record?.metadata || {};
  const tx = record?.tx || record?.transaction || record;
  const raw = meta.delivered_amount ?? tx.delivered_amount ?? tx.Amount ?? record.amount_drops ?? record.amountDrops;
  if (typeof raw === "object") {
    return null;
  }
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function normalizeEvent(record, index) {
  const tx = record?.tx || record?.transaction || record;
  const meta = record?.meta || record?.metadata || {};
  const txType = tx.TransactionType || tx.tx_type || record.tx_type || "";
  const result = meta.TransactionResult || record.result || "tesSUCCESS";
  const src = tx.Account || tx.src || tx.source || record.src || record.source;
  const dst = tx.Destination || tx.dst || tx.destination || record.dst || record.destination;
  const amountDrops = amountDropsFromRecord(record);
  const txHash = tx.hash || tx.tx_hash || record.tx_hash || record.hash || `synthetic_event_${index}`;
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
    eventId: record.event_id || record.eventId || `event_${index}`,
    ledgerIndex: record.ledger_index || record.ledgerIndex || tx.ledger_index || null,
    src,
    timestamp,
    txHash,
  };
}

function collectEvents(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  for (const key of ["events", "transactions", "rows", "account_tx", "txs"]) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }
  return [];
}

function addKnownWallet(knownWallets, wallet, clusterId = "known", source = "input") {
  if (isWallet(wallet) && !knownWallets.has(wallet)) {
    knownWallets.set(wallet, { clusterId, source, wallet });
  }
}

function collectKnownWallets(inputPayload, baselinePayload) {
  const knownWallets = new Map();

  for (const [source, wallets] of [
    ["input.flagged_wallets", inputPayload?.flagged_wallets],
    ["input.known_wallets", inputPayload?.known_wallets],
    ["baseline.flagged_wallets", baselinePayload?.flagged_wallets],
    ["baseline.known_wallets", baselinePayload?.known_wallets],
  ]) {
    for (const wallet of Array.isArray(wallets) ? wallets : []) {
      addKnownWallet(
        knownWallets,
        wallet,
        inputPayload?.clusters?.[wallet] || baselinePayload?.clusters?.[wallet] || "known",
        source
      );
    }
  }

  for (const [source, clusters] of [
    ["input.clusters", inputPayload?.clusters],
    ["baseline.clusters", baselinePayload?.clusters],
  ]) {
    for (const [wallet, clusterId] of Object.entries(clusters || {})) {
      addKnownWallet(knownWallets, wallet, clusterId, source);
    }
  }

  for (const node of Array.isArray(baselinePayload?.graph?.nodes) ? baselinePayload.graph.nodes : []) {
    if (node?.flaggedKnown || node?.flagged || node?.isFlagged || node?.type === "sybil") {
      addKnownWallet(
        knownWallets,
        node.wallet || node.address || node.id,
        node.clusterId || node.cluster_id || "known",
        "baseline.graph.nodes"
      );
    }
  }

  return knownWallets;
}

function emptyState(knownWallets) {
  return {
    alerts: [],
    duplicateTxHashes: 0,
    edges: new Map(),
    eventsIncluded: 0,
    eventsRaw: 0,
    highRiskByWallet: new Map(),
    knownWallets,
    nodes: new Map(),
    priorRiskWallets: new Map(),
    seenTxHashes: new Set(),
    skipped: [],
  };
}

function getNode(state, wallet) {
  if (!state.nodes.has(wallet)) {
    const known = state.knownWallets.get(wallet);
    state.nodes.set(wallet, {
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
  return state.nodes.get(wallet);
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

function mergeEdge(state, { amountPft, dst, src, timestamp, txHash }) {
  const edgeKey = `${src}->${dst}`;
  const edge = state.edges.get(edgeKey) || {
    amountPft: 0,
    firstSeen: null,
    lastSeen: null,
    source: src,
    target: dst,
    txHashes: [],
    txCount: 0,
  };
  edge.amountPft += amountPft;
  edge.txCount += 1;
  if (txHash) {
    edge.txHashes.push(txHash);
  }
  if (timestamp && (!edge.firstSeen || timestamp < edge.firstSeen)) {
    edge.firstSeen = timestamp;
  }
  if (timestamp && (!edge.lastSeen || timestamp > edge.lastSeen)) {
    edge.lastSeen = timestamp;
  }
  state.edges.set(edgeKey, edge);
}

function applyTransaction(state, tx) {
  if (state.seenTxHashes.has(tx.txHash)) {
    state.duplicateTxHashes += 1;
    return { duplicate: true, touchedWallets: [] };
  }
  state.seenTxHashes.add(tx.txHash);

  const src = getNode(state, tx.src);
  const dst = getNode(state, tx.dst);
  src.outTx += 1;
  src.outPft += tx.amountPft;
  dst.inTx += 1;
  dst.inPft += tx.amountPft;
  src.peers.add(tx.dst);
  dst.peers.add(tx.src);
  updateSeen(src, tx.timestamp);
  updateSeen(dst, tx.timestamp);
  mergeEdge(state, tx);
  state.eventsIncluded += 1;
  return { duplicate: false, touchedWallets: [tx.src, tx.dst] };
}

function seedFromBaseline(state, baselinePayload) {
  for (const node of Array.isArray(baselinePayload?.graph?.nodes) ? baselinePayload.graph.nodes : []) {
    const wallet = node.wallet || node.address || node.id;
    if (!isWallet(wallet)) {
      continue;
    }
    const target = getNode(state, wallet);
    target.clusterId = node.clusterId || node.cluster_id || target.clusterId;
    target.flaggedKnown = Boolean(target.flaggedKnown || node.flaggedKnown || node.flagged || node.isFlagged);
    target.firstSeen = node.firstSeen || target.firstSeen;
    target.lastSeen = node.lastSeen || target.lastSeen;
    target.inPft = Number(node.inPft || target.inPft || 0);
    target.outPft = Number(node.outPft || target.outPft || 0);
    target.inTx = Number(node.inTx || target.inTx || 0);
    target.outTx = Number(node.outTx || target.outTx || 0);
    for (const peer of Array.isArray(node.peers) ? node.peers : []) {
      if (isWallet(peer)) {
        target.peers.add(peer);
      }
    }
  }

  for (const edge of Array.isArray(baselinePayload?.graph?.edges) ? baselinePayload.graph.edges : []) {
    if (!isWallet(edge.source) || !isWallet(edge.target)) {
      continue;
    }
    const src = getNode(state, edge.source);
    const dst = getNode(state, edge.target);
    src.peers.add(edge.target);
    dst.peers.add(edge.source);
    state.edges.set(`${edge.source}->${edge.target}`, {
      amountPft: Number(edge.amountPft || 0),
      firstSeen: edge.firstSeen || null,
      lastSeen: edge.lastSeen || null,
      source: edge.source,
      target: edge.target,
      txHashes: Array.isArray(edge.txHashes) ? edge.txHashes : [],
      txCount: Number(edge.txCount || 0),
    });
  }

  const baselineThreshold = Number(baselinePayload?.policy?.highRiskThreshold || DEFAULT_HIGH_RISK_THRESHOLD);
  for (const row of Array.isArray(baselinePayload?.secondaryRisk) ? baselinePayload.secondaryRisk : []) {
    if (isWallet(row.wallet) && Number(row.riskScore || 0) >= baselineThreshold && !state.knownWallets.has(row.wallet)) {
      const baselineRisk = Number(row.riskScore || 0);
      state.priorRiskWallets.set(row.wallet, {
        riskScore: baselineRisk,
        source: "baseline.secondaryRisk",
      });
      state.highRiskByWallet.set(row.wallet, {
        riskScore: baselineRisk,
        source: "baseline.secondaryRisk",
      });
    }
  }

  recomputeDerivedMetrics(state);
}

function recomputeDerivedMetrics(state) {
  const nodeCount = state.nodes.size;
  for (const node of state.nodes.values()) {
    node.degree = node.peers.size;
    node.degreeCentrality = nodeCount > 1 ? round(node.degree / (nodeCount - 1), 4) : 0;
    node.weightedDegreePft = round(node.inPft + node.outPft, 6);
  }
}

function connectedComponentForWallet(state, wallet) {
  if (!state.nodes.has(wallet)) {
    return [];
  }
  const visited = new Set([wallet]);
  const stack = [wallet];
  const members = [];
  while (stack.length) {
    const current = stack.pop();
    members.push(current);
    for (const peer of state.nodes.get(current)?.peers || []) {
      if (!visited.has(peer)) {
        visited.add(peer);
        stack.push(peer);
      }
    }
  }
  return members.sort();
}

function componentDensity(state, members) {
  const memberSet = new Set(members);
  let directedEdgeCount = 0;
  let amountPft = 0;
  for (const edge of state.edges.values()) {
    if (memberSet.has(edge.source) && memberSet.has(edge.target)) {
      directedEdgeCount += 1;
      amountPft += edge.amountPft;
    }
  }
  const possibleDirectedEdges = members.length > 1 ? members.length * (members.length - 1) : 0;
  return {
    amountPft: round(amountPft, 6),
    density: possibleDirectedEdges ? round(directedEdgeCount / possibleDirectedEdges, 4) : 0,
    directedEdgeCount,
    possibleDirectedEdges,
  };
}

function adjacentRiskStats(state, wallet) {
  const node = state.nodes.get(wallet);
  const knownPeers = [];
  const priorRiskPeers = [];
  for (const peer of node?.peers || []) {
    if (state.knownWallets.has(peer)) {
      knownPeers.push(peer);
    } else if (state.priorRiskWallets.has(peer) || state.highRiskByWallet.has(peer)) {
      priorRiskPeers.push(peer);
    }
  }

  let sourceInPft = 0;
  let sourceOutPft = 0;
  let sourceInTx = 0;
  let sourceOutTx = 0;
  for (const edge of state.edges.values()) {
    const sourceIsRisk = state.knownWallets.has(edge.source) || state.priorRiskWallets.has(edge.source) || state.highRiskByWallet.has(edge.source);
    const targetIsRisk = state.knownWallets.has(edge.target) || state.priorRiskWallets.has(edge.target) || state.highRiskByWallet.has(edge.target);
    if (edge.target === wallet && sourceIsRisk) {
      sourceInPft += edge.amountPft;
      sourceInTx += edge.txCount;
    }
    if (edge.source === wallet && targetIsRisk) {
      sourceOutPft += edge.amountPft;
      sourceOutTx += edge.txCount;
    }
  }

  return {
    knownPeers: knownPeers.sort(),
    priorRiskPeers: priorRiskPeers.sort(),
    riskPeerCount: knownPeers.length + priorRiskPeers.length,
    sourceInPft,
    sourceInTx,
    sourceOutPft,
    sourceOutTx,
  };
}

function maxRiskAdjacentAmount(state) {
  let maxAmount = 1;
  for (const wallet of state.nodes.keys()) {
    const stats = adjacentRiskStats(state, wallet);
    maxAmount = Math.max(maxAmount, stats.sourceInPft + stats.sourceOutPft);
  }
  return maxAmount;
}

function scoreWallet(state, wallet, maxAmount) {
  const node = state.nodes.get(wallet);
  if (!node || node.flaggedKnown) {
    return null;
  }

  const stats = adjacentRiskStats(state, wallet);
  if (!stats.riskPeerCount) {
    return null;
  }

  const members = connectedComponentForWallet(state, wallet);
  const density = componentDensity(state, members);
  const sharedFunder = stats.sourceOutTx >= 2 && stats.riskPeerCount >= 2;
  const sharedSink = stats.sourceInTx >= 2 && stats.riskPeerCount >= 2;
  const bidirectionalRisk = stats.sourceInTx > 0 && stats.sourceOutTx > 0;
  const directKnownScore = (Math.min(stats.knownPeers.length, 5) / 5) * 28;
  const contagionScore = (Math.min(stats.priorRiskPeers.length, 4) / 4) * 18;
  const bridgeScore = (sharedFunder ? 14 : 0) + (sharedSink ? 14 : 0) + (bidirectionalRisk ? 12 : 0);
  const centralityScore = node.degreeCentrality * 14;
  const densityScore = Math.min(density.density * 40, 10);
  const amountScore = Math.min(((stats.sourceInPft + stats.sourceOutPft) / maxAmount) * 12, 12);
  const riskScore = Math.min(
    100,
    directKnownScore + contagionScore + bridgeScore + centralityScore + densityScore + amountScore
  );

  const reasons = [];
  if (stats.knownPeers.length) {
    reasons.push(`adjacent to ${stats.knownPeers.length} known-cluster wallet(s)`);
  }
  if (stats.priorRiskPeers.length) {
    reasons.push(`adjacent to ${stats.priorRiskPeers.length} prior high-risk wallet(s)`);
  }
  if (sharedFunder) {
    reasons.push("funds multiple risk-source wallets");
  }
  if (sharedSink) {
    reasons.push("receives from multiple risk-source wallets");
  }
  if (bidirectionalRisk) {
    reasons.push("has bidirectional flow with risk-source wallets");
  }
  if (density.density >= 0.15) {
    reasons.push(`component density ${density.density}`);
  }

  return {
    amountScore: round(amountScore, 2),
    componentDensity: density.density,
    degreeCentrality: node.degreeCentrality,
    firstSeen: node.firstSeen,
    knownPeers: stats.knownPeers,
    lastSeen: node.lastSeen,
    priorRiskPeers: stats.priorRiskPeers,
    reasons,
    riskPeerCount: stats.riskPeerCount,
    riskScore: round(riskScore, 1),
    sourceInPft: round(stats.sourceInPft, 6),
    sourceOutPft: round(stats.sourceOutPft, 6),
    wallet,
    weightedDegreePft: node.weightedDegreePft,
  };
}

function riskBand(score, args) {
  if (score >= args.highRiskThreshold) {
    return "high_review_priority";
  }
  if (score >= args.watchThreshold) {
    return "watch";
  }
  return "below_watch";
}

function maybeEmitAlerts({ args, eventIndex, state, touchedWallets, tx }) {
  recomputeDerivedMetrics(state);
  const candidates = new Set(touchedWallets);
  for (const wallet of touchedWallets) {
    for (const peer of state.nodes.get(wallet)?.peers || []) {
      candidates.add(peer);
    }
  }

  const maxAmount = maxRiskAdjacentAmount(state);
  const emitted = [];
  for (const wallet of candidates) {
    const scored = scoreWallet(state, wallet, maxAmount);
    if (!scored) {
      continue;
    }
    const band = riskBand(scored.riskScore, args);
    if (band !== "high_review_priority") {
      continue;
    }

    const prior = state.highRiskByWallet.get(wallet);
    if (prior && scored.riskScore <= prior.riskScore + 4) {
      continue;
    }

    const alert = {
      schema: "tasknode.xrpl_contagion_alert.v1",
      alertId: `alert_${state.alerts.length + 1}`,
      eventIndex,
      eventId: tx.eventId,
      observedAt: tx.timestamp,
      policy: {
        enforcementAllowed: false,
        mode: "recommend_only_review_alert",
      },
      recommendation: "review_raw_transactions_and_operator_identity_before_any_enforcement",
      riskBand: band,
      threshold: args.highRiskThreshold,
      triggerTxHash: tx.txHash,
      ...scored,
    };
    state.alerts.push(alert);
    state.highRiskByWallet.set(wallet, { riskScore: scored.riskScore, source: alert.alertId });
    emitted.push(alert);
  }
  return emitted;
}

function processEvents({ args, baselinePayload, inputPayload }) {
  const state = emptyState(collectKnownWallets(inputPayload, baselinePayload));
  seedFromBaseline(state, baselinePayload || {});
  const events = collectEvents(inputPayload);
  state.eventsRaw = events.length;
  const alertEmissions = [];

  events.forEach((raw, index) => {
    const tx = normalizeEvent(raw, index);
    if (tx.skipped) {
      state.skipped.push({ eventIndex: index, ...tx });
      return;
    }
    const applied = applyTransaction(state, tx);
    if (applied.duplicate) {
      return;
    }
    alertEmissions.push(...maybeEmitAlerts({ args, eventIndex: index, state, touchedWallets: applied.touchedWallets, tx }));
  });

  recomputeDerivedMetrics(state);
  return { alertEmissions, events, state };
}

function serializableNodes(state) {
  return [...state.nodes.values()]
    .map((node) => ({
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

function serializableEdges(state) {
  return [...state.edges.values()]
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

function finalRiskLedger(state, args) {
  const maxAmount = maxRiskAdjacentAmount(state);
  return [...state.nodes.keys()]
    .map((wallet) => scoreWallet(state, wallet, maxAmount))
    .filter(Boolean)
    .map((row) => ({
      ...row,
      recommendation:
        row.riskScore >= args.highRiskThreshold
          ? "review_raw_transactions_and_operator_identity_before_any_enforcement"
          : "continue_monitoring",
      riskBand: riskBand(row.riskScore, args),
    }))
    .sort((a, b) => b.riskScore - a.riskScore || a.wallet.localeCompare(b.wallet));
}

function buildReport({ alertEmissions, args, baselinePayload, inputPayload, state }) {
  const riskLedger = finalRiskLedger(state, args);
  const components = [];
  const visited = new Set();
  for (const wallet of state.nodes.keys()) {
    if (visited.has(wallet)) {
      continue;
    }
    const members = connectedComponentForWallet(state, wallet);
    members.forEach((member) => visited.add(member));
    const density = componentDensity(state, members);
    components.push({
      amountPft: density.amountPft,
      componentId: `component_${components.length + 1}`,
      density: density.density,
      directedEdgeCount: density.directedEdgeCount,
      knownWalletCount: members.filter((member) => state.knownWallets.has(member)).length,
      members,
      possibleDirectedEdges: density.possibleDirectedEdges,
      priorRiskWalletCount: members.filter((member) => state.priorRiskWallets.has(member)).length,
      walletCount: members.length,
    });
  }

  return {
    schema: "tasknode.xrpl_contagion_risk_monitor.v1",
    generatedAt: new Date().toISOString(),
    lineage: LINEAGE,
    inputs: {
      baseline: args.baseline ? path.resolve(args.baseline) : null,
      events: path.resolve(args.events),
      inputSchema: inputPayload?.schema || null,
      priorHighRiskFromBaseline: state.priorRiskWallets.size,
      priorTaskCid: baselinePayload?.lineage?.[0]?.rewardCid || "QmdZ99NTL6CUtrRr4xApf4rMwzgsALutkqDEizVaFk2AoR",
    },
    policy: {
      enforcementAllowed: false,
      highRiskThreshold: args.highRiskThreshold,
      mode: "recommend_only_read_only_monitor",
      note: "Alerts are review leads. They are not bans, blocklist entries, clawback instructions, or proof of sybil behavior.",
      watchThreshold: args.watchThreshold,
    },
    ingest: {
      duplicateTxHashes: state.duplicateTxHashes,
      eventsIncluded: state.eventsIncluded,
      eventsRaw: state.eventsRaw,
      skipped: state.skipped.length,
      skippedReasons: state.skipped.reduce((acc, row) => {
        acc[row.reason] = (acc[row.reason] || 0) + 1;
        return acc;
      }, {}),
    },
    graph: {
      components,
      edges: serializableEdges(state),
      nodes: serializableNodes(state),
      stats: {
        alertsEmitted: state.alerts.length,
        components: components.length,
        directedEdges: state.edges.size,
        knownWallets: state.knownWallets.size,
        nodes: state.nodes.size,
        priorHighRiskWallets: state.priorRiskWallets.size,
        secondaryWallets: state.nodes.size - state.knownWallets.size,
      },
    },
    alerts: state.alerts,
    riskLedger,
    summary: {
      alertWallets: state.alerts.map((alert) => alert.wallet),
      interpretation:
        state.alerts.length > 0
          ? "Live event stream produced high-priority contagion review alerts. Review raw transaction lineage before any enforcement."
          : "No wallet crossed the configured high-risk threshold in this event stream.",
      newAlerts: alertEmissions.length,
      status: state.alerts.length > 0 ? "review_required" : "no_high_risk_alerts",
    },
  };
}

function buildSummary(report) {
  const lines = [];
  lines.push("# XRPL Contagion Risk Monitor Summary");
  lines.push("");
  lines.push("@goodalexander review note: this is a recommend-only live-monitor output. It emits review alerts and contains no blocklist mutation, ban, clawback, signing path, or fund movement.");
  lines.push("");
  lines.push(`Status: ${report.summary.status}`);
  lines.push(`Input events: ${report.ingest.eventsRaw}`);
  lines.push(`Included events: ${report.ingest.eventsIncluded}`);
  lines.push(`Known wallets: ${report.graph.stats.knownWallets}`);
  lines.push(`Prior high-risk baseline wallets: ${report.graph.stats.priorHighRiskWallets}`);
  lines.push(`Nodes after stream: ${report.graph.stats.nodes}`);
  lines.push(`Directed edges after stream: ${report.graph.stats.directedEdges}`);
  lines.push(`Alerts emitted: ${report.graph.stats.alertsEmitted}`);
  lines.push("");
  lines.push("## Alerts");
  lines.push("");
  if (!report.alerts.length) {
    lines.push("No high-risk alerts crossed the configured threshold.");
  } else {
    lines.push("| Alert | Wallet | Risk | Trigger tx | Known peers | Prior-risk peers | Reasons |");
    lines.push("| --- | --- | ---: | --- | ---: | ---: | --- |");
    for (const alert of report.alerts) {
      lines.push(
        `| ${alert.alertId} | ${alert.wallet} | ${alert.riskScore} | ${alert.triggerTxHash} | ${alert.knownPeers.length} | ${alert.priorRiskPeers.length} | ${alert.reasons.join("; ")} |`
      );
    }
  }
  lines.push("");
  lines.push("## Top Risk Ledger");
  lines.push("");
  lines.push("| Wallet | Risk | Band | Recommendation |");
  lines.push("| --- | ---: | --- | --- |");
  for (const row of report.riskLedger.slice(0, 8)) {
    lines.push(`| ${row.wallet} | ${row.riskScore} | ${row.riskBand} | ${row.recommendation} |`);
  }
  lines.push("");
  lines.push("## Command");
  lines.push("");
  lines.push("```bash");
  lines.push(
    `node scripts/xrpl-contagion-risk-monitor.mjs --events ${report.inputs.events}${
      report.inputs.baseline ? ` --baseline ${report.inputs.baseline}` : ""
    } --alerts <alerts.json> --summary <summary.md> --state-out <state.json>`
  );
  lines.push("```");
  lines.push("");
  lines.push("## Boundary");
  lines.push("");
  lines.push("This script is read-only local analysis. It processes event streams, updates an in-memory graph, emits JSON review alerts, and leaves all enforcement decisions to separate human/core-team review.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPayload = await readJson(args.events);
  const baselinePayload = args.baseline ? await readJson(args.baseline) : {};
  const processed = processEvents({ args, baselinePayload, inputPayload });
  const report = buildReport({ ...processed, args, baselinePayload, inputPayload });

  if (args.alerts) {
    await writeJson(args.alerts, report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  if (args.stateOut) {
    await writeJson(args.stateOut, {
      schema: "tasknode.xrpl_contagion_monitor_state.v1",
      generatedAt: report.generatedAt,
      alerts: report.alerts,
      highRiskByWallet: Object.fromEntries(processed.state.highRiskByWallet),
      knownWallets: Object.fromEntries(processed.state.knownWallets),
      priorRiskWallets: Object.fromEntries(processed.state.priorRiskWallets),
      seenTxHashes: [...processed.state.seenTxHashes].sort(),
    });
  }
  if (args.summary) {
    await writeText(args.summary, buildSummary(report));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
