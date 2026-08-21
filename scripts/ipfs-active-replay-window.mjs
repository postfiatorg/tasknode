import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closePool, query } from "../server/db/pool.js";
import { isValidContextCid, normalizeContextCid } from "../server/context-ipfs.js";
import { verifyCidGateways } from "./ipfs-cid-inventory.mjs";

const defaultCurrentGateways = [
  "https://pft-ipfs-testnet-clean.fly.dev/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
];

const activePayloadClasses = [
  "context_json",
  "task_json",
  "task_submission_json",
  "reward_json",
];

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1] || fallback;
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  console.log([
    "Usage:",
    "  npm run ipfs-active-replay-window -- --lookback-days 14 --output /tmp/ipfs-active-replay.json",
    "",
    "Verifies a bounded active replay window of task/context/reward CIDs through current gateways only.",
    "The command exits nonzero when any selected CID does not resolve from current infrastructure.",
  ].join("\n"));
}

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function nowIso() {
  return new Date().toISOString();
}

function parseList(value = "", fallback = []) {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function normalizeGateway(value = "") {
  const text = safeText(value, 500);
  if (!text) return "";
  return text.endsWith("/") ? text : `${text}/`;
}

function uniqueList(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizeGateway(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeCid(value = "") {
  const cid = normalizeContextCid(value);
  return isValidContextCid(cid) ? cid : "";
}

function compactRef(ref = {}) {
  return {
    source: safeText(ref.source, 80),
    payloadClass: safeText(ref.payloadClass, 80),
    cid: normalizeCid(ref.cid),
    taskId: safeText(ref.taskId, 180),
    requestId: safeText(ref.requestId, 180),
    contextId: safeText(ref.contextId, 180),
    txHash: safeText(ref.txHash, 180),
    eventType: safeText(ref.eventType, 120),
    pointerKind: safeText(ref.pointerKind, 80),
    observedAt: safeText(ref.observedAt, 80),
  };
}

function timestampMs(value = "") {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function selectReplayWindowCids(records = [], { perClass = 12, maxCids = 80 } = {}) {
  const byCid = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const cid = normalizeCid(record.cid);
    const payloadClass = safeText(record.payloadClass, 80);
    if (!cid || !activePayloadClasses.includes(payloadClass)) continue;
    const existing = byCid.get(cid) || {
      cid,
      payloadClasses: new Set(),
      refs: [],
      lastObservedAt: "",
    };
    existing.payloadClasses.add(payloadClass);
    if (existing.refs.length < 8) existing.refs.push(compactRef({ ...record, cid, payloadClass }));
    if (timestampMs(record.observedAt) > timestampMs(existing.lastObservedAt)) {
      existing.lastObservedAt = safeText(record.observedAt, 80);
    }
    byCid.set(cid, existing);
  }

  const byClass = new Map(activePayloadClasses.map((payloadClass) => [payloadClass, []]));
  for (const entry of byCid.values()) {
    for (const payloadClass of entry.payloadClasses) {
      byClass.get(payloadClass)?.push(entry);
    }
  }

  const selected = [];
  const seen = new Set();
  for (const payloadClass of activePayloadClasses) {
    const entries = (byClass.get(payloadClass) || [])
      .sort((left, right) => timestampMs(right.lastObservedAt) - timestampMs(left.lastObservedAt))
      .slice(0, Math.max(1, Number(perClass || 12)));
    for (const entry of entries) {
      if (seen.has(entry.cid)) continue;
      seen.add(entry.cid);
      selected.push(entry);
      if (maxCids > 0 && selected.length >= maxCids) break;
    }
    if (maxCids > 0 && selected.length >= maxCids) break;
  }

  return selected
    .map((entry) => ({
      cid: entry.cid,
      payloadClasses: [...entry.payloadClasses].sort(),
      refCount: entry.refs.length,
      refs: entry.refs,
      lastObservedAt: entry.lastObservedAt,
    }))
    .sort((left, right) => timestampMs(right.lastObservedAt) - timestampMs(left.lastObservedAt));
}

async function readReplayWindowRecords({ lookbackDays = 14, queryLimit = 1000 } = {}) {
  const pointerResult = await query(
    `SELECT cid, pointer_kind, task_id, request_id, context_id, tx_hash, created_at
       FROM pftl_pointer_memos
      WHERE COALESCE(cid, '') <> ''
        AND pointer_kind = ANY($3::text[])
        AND ($1::int <= 0 OR created_at >= now() - ($1::text || ' days')::interval)
      ORDER BY created_at DESC
      LIMIT $2`,
    [
      Math.max(0, Number(lookbackDays || 0)),
      Math.max(1, Number(queryLimit || 1000)),
      ["CONTEXT", "TASK", "TASK_UPDATE", "TASK_SUBMISSION", "REWARD"],
    ]
  );
  const eventResult = await query(
    `SELECT source_cid, event_type, task_id, source_tx_hash, occurred_at
       FROM task_events
      WHERE COALESCE(source_cid, '') <> ''
        AND ($1::int <= 0 OR occurred_at >= now() - ($1::text || ' days')::interval)
      ORDER BY occurred_at DESC
      LIMIT $2`,
    [
      Math.max(0, Number(lookbackDays || 0)),
      Math.max(1, Number(queryLimit || 1000)),
    ]
  );

  const pointerRecords = pointerResult.rows.map((row) => ({
    source: "pftl_pointer_memos",
    cid: row.cid,
    payloadClass: pointerPayloadClass(row.pointer_kind),
    pointerKind: row.pointer_kind,
    taskId: row.task_id,
    requestId: row.request_id,
    contextId: row.context_id,
    txHash: row.tx_hash,
    observedAt: row.created_at,
  }));
  const taskEventRecords = eventResult.rows.map((row) => ({
    source: "task_events",
    cid: row.source_cid,
    payloadClass: taskEventPayloadClass(row.event_type),
    eventType: row.event_type,
    taskId: row.task_id,
    txHash: row.source_tx_hash,
    observedAt: row.occurred_at,
  }));
  return [...pointerRecords, ...taskEventRecords];
}

function pointerPayloadClass(pointerKind = "") {
  const kind = safeText(pointerKind, 80).toUpperCase();
  if (kind === "CONTEXT") return "context_json";
  if (kind === "REWARD") return "reward_json";
  if (kind === "TASK_SUBMISSION") return "task_submission_json";
  if (kind === "TASK" || kind === "TASK_UPDATE") return "task_json";
  return "other";
}

function taskEventPayloadClass(eventType = "") {
  const type = safeText(eventType, 120).toLowerCase();
  if (type.includes("reward")) return "reward_json";
  if (type.includes("submission") || type.includes("evidence")) return "task_submission_json";
  return "task_json";
}

async function mapWithConcurrency(items = [], concurrency = 4, mapper) {
  const bounded = Math.min(16, Math.max(1, Number(concurrency || 4)));
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(bounded, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function verifyReplayWindow({
  entries = [],
  currentGateways = defaultCurrentGateways,
  timeoutMs = 8000,
  concurrency = 4,
  fetchImpl = fetch,
} = {}) {
  return mapWithConcurrency(entries, concurrency, async (entry) => {
    const gatewayCheck = await verifyCidGateways({
      cid: entry.cid,
      currentGateways,
      legacyGateways: [],
      timeoutMs,
      fetchImpl,
    });
    const currentSuccess = gatewayCheck.currentAttempts.find((attempt) => attempt.ok) || null;
    return {
      ...entry,
      ok: Boolean(currentSuccess),
      firstCurrentGateway: currentSuccess?.gateway || "",
      contentType: currentSuccess?.contentType || "",
      byteSize: currentSuccess?.bytes || 0,
      gatewayCheck,
    };
  });
}

export function summarizeReplayWindow(results = []) {
  const byPayloadClass = {};
  const failures = [];
  for (const result of Array.isArray(results) ? results : []) {
    for (const payloadClass of result.payloadClasses || []) {
      byPayloadClass[payloadClass] = (byPayloadClass[payloadClass] || 0) + 1;
    }
    if (!result.ok) failures.push(result);
  }
  return {
    selectedCids: results.length,
    okCount: results.filter((result) => result.ok).length,
    failureCount: failures.length,
    byPayloadClass,
  };
}

function writeJsonReport(outputPath = "", report = {}) {
  if (!outputPath) return;
  const resolved = path.resolve(outputPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

export async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    usage();
    return;
  }

  if (!process.env.DATABASE_URL && process.env.TASKNODE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TASKNODE_DATABASE_URL;
    process.env.TASKNODE_DATABASE_ENABLED = process.env.TASKNODE_DATABASE_ENABLED || "true";
  }

  const lookbackDays = Math.max(1, Number(argValue("lookback-days", "14")) || 14);
  const queryLimit = Math.max(1, Number(argValue("query-limit", "1000")) || 1000);
  const perClass = Math.max(1, Number(argValue("per-class", "12")) || 12);
  const maxCids = Math.max(1, Number(argValue("max-cids", "80")) || 80);
  const timeoutMs = Math.max(500, Number(argValue("timeout-ms", "8000")) || 8000);
  const concurrency = Math.max(1, Number(argValue("concurrency", "4")) || 4);
  const currentGateways = uniqueList(parseList(argValue("current-gateways"), defaultCurrentGateways));
  const output = safeText(argValue("output"), 600);
  const pretty = hasFlag("pretty") || Boolean(output);

  const records = await readReplayWindowRecords({ lookbackDays, queryLimit });
  const selected = selectReplayWindowCids(records, { perClass, maxCids });
  const results = await verifyReplayWindow({
    entries: selected,
    currentGateways,
    timeoutMs,
    concurrency,
  });
  await closePool().catch(() => null);

  const summary = summarizeReplayWindow(results);
  const report = {
    ok: summary.failureCount === 0 && summary.selectedCids > 0,
    generatedAt: nowIso(),
    lookbackDays,
    queryLimit,
    perClass,
    maxCids,
    timeoutMs,
    currentGateways,
    sourceRecords: records.length,
    summary,
    failures: results.filter((result) => !result.ok),
    results,
  };
  writeJsonReport(output, report);
  console.log(JSON.stringify(output ? { ...report, results: undefined } : report, null, pretty ? 2 : 0));
  if (!report.ok) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(async (error) => {
    await closePool().catch(() => null);
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}
