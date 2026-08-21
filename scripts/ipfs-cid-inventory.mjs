import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { closePool, query } from "../server/db/pool.js";
import { isValidContextCid, normalizeContextCid } from "../server/context-ipfs.js";

const defaultCurrentGateways = [
  "https://pft-ipfs-testnet-clean.fly.dev/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
];

const defaultLegacyGateways = [
  "https://ipfs-testnet.postfiat.org/ipfs/",
  "https://pft-ipfs-testnet-node-1.fly.dev/ipfs/",
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

function hasArg(name) {
  const prefix = `--${name}=`;
  return process.argv.includes(`--${name}`) || process.argv.some((arg) => arg.startsWith(prefix));
}

function usage() {
  console.log([
    "Usage:",
    "  npm run ipfs-cid-inventory -- --source current-db --output /tmp/ipfs-cid-inventory.json",
    "  npm run ipfs-cid-inventory -- --source current-db --verify-gateways --limit 250 --output /tmp/ipfs-cid-inventory.json",
    "  npm run ipfs-cid-inventory -- --source current-db --verify-gateways --check-pinata --limit 250 --output /tmp/ipfs-cid-inventory.json",
    "  npm run ipfs-cid-inventory -- --source-json /tmp/pftasks-nft-mints-all.json --verify-gateways",
    "  npm run ipfs-cid-inventory -- --stdin --verify-gateways",
    "",
    "Builds a durable CID inventory for Task Node IPFS migration. Current DB reads include",
    "pftl_pointer_memos, task_events, and profile_nfts. JSON/stdin inputs are treated as",
    "legacy/public NFT export rows unless they already contain inventory-like fields.",
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

function pinataHeaders(env = process.env) {
  const jwt = String(env.PINATA_JWT || "").trim();
  if (jwt) return { Authorization: `Bearer ${jwt}` };

  const apiKey = String(env.PINATA_API_KEY || "").trim();
  const secret = String(env.PINATA_API_SECRET || "").trim();
  if (!apiKey || !secret) return null;
  return {
    pinata_api_key: apiKey,
    pinata_secret_api_key: secret,
  };
}

function normalizeCid(value = "") {
  const cid = normalizeContextCid(value);
  return isValidContextCid(cid) ? cid : "";
}

function cidFromAny(row = {}, keys = []) {
  for (const key of keys) {
    const value = row[key] ?? row[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())];
    const cid = normalizeCid(value);
    if (cid) return cid;
  }
  return "";
}

function thumbnailCidFromRow(row = {}) {
  const direct = cidFromAny(row, ["thumbnail_cid", "thumbnailCid"]);
  if (direct) return direct;
  const metadata = row.metadata_json || row.metadataJson || row.metadata || {};
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return cidFromAny(metadata, ["thumbnail_cid", "thumbnailCid", "thumbnail", "thumbnail_url", "thumbnailUrl"]);
  }
  return "";
}

function classForPointerKind(pointerKind = "") {
  const kind = safeText(pointerKind, 80).toUpperCase();
  if (kind === "CONTEXT") return "context_json";
  if (kind === "REWARD") return "reward_json";
  if (kind === "TASK_SUBMISSION") return "task_submission_json";
  if (kind === "TASK" || kind === "TASK_UPDATE") return "task_json";
  if (kind === "DOCUMENT") return "document_json";
  if (kind === "CHAT") return "chat_json";
  if (kind === "ASSET") return "asset_json";
  return "pftl_pointer_json";
}

function classForTaskEvent(eventType = "") {
  const type = safeText(eventType, 120).toLowerCase();
  if (type.includes("reward")) return "reward_json";
  if (type.includes("submission") || type.includes("evidence")) return "task_submission_json";
  return "task_json";
}

function compactRef(ref = {}) {
  return {
    source: safeText(ref.source, 80),
    table: safeText(ref.table, 80),
    column: safeText(ref.column, 80),
    payloadClass: safeText(ref.payloadClass, 80),
    accountId: safeText(ref.accountId, 180),
    walletAddress: safeText(ref.walletAddress, 140),
    taskId: safeText(ref.taskId, 180),
    requestId: safeText(ref.requestId, 180),
    contextId: safeText(ref.contextId, 180),
    txHash: safeText(ref.txHash, 180),
    rowId: safeText(ref.rowId, 180),
    public: Boolean(ref.public),
    encrypted: Boolean(ref.encrypted),
    exactCidRequired: Boolean(ref.exactCidRequired),
  };
}

export function buildInventory(records = []) {
  const byCid = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const cid = normalizeCid(record.cid);
    if (!cid) continue;
    const existing = byCid.get(cid) || {
      cid,
      payloadClasses: new Set(),
      sources: new Set(),
      public: false,
      encrypted: false,
      exactCidRequired: false,
      refCount: 0,
      refs: [],
    };
    const payloadClass = safeText(record.payloadClass || record.class || "other", 80) || "other";
    const source = safeText(record.source || record.table || "unknown", 80) || "unknown";
    existing.payloadClasses.add(payloadClass);
    existing.sources.add(source);
    existing.public = existing.public || Boolean(record.public);
    existing.encrypted = existing.encrypted || Boolean(record.encrypted);
    existing.exactCidRequired = existing.exactCidRequired || Boolean(record.exactCidRequired);
    existing.refCount += 1;
    if (existing.refs.length < 10) {
      existing.refs.push(compactRef({
        ...record,
        payloadClass,
        source,
      }));
    }
    byCid.set(cid, existing);
  }

  return [...byCid.values()]
    .map((entry) => ({
      ...entry,
      payloadClasses: [...entry.payloadClasses].sort(),
      sources: [...entry.sources].sort(),
    }))
    .sort((left, right) => left.cid.localeCompare(right.cid));
}

function parseJsonInput(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.rows)) return parsed.rows;
  if (Array.isArray(parsed.nfts)) return parsed.nfts;
  if (Array.isArray(parsed.results)) return parsed.results;
  if (Array.isArray(parsed.inventory)) return parsed.inventory;
  throw new Error("source_json_rows_missing");
}

export function recordsFromLegacyJsonRows(rows = [], { source = "legacy_json" } = {}) {
  const records = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const shared = {
      source,
      table: safeText(row.table || row.sourceTable || "legacy_export", 80),
      rowId: safeText(row.id || row.rowId || row.nft_id || row.nftId || row.mint_id || row.mintId, 180),
      accountId: safeText(row.account_id || row.accountId, 180),
      walletAddress: safeText(row.wallet_address || row.walletAddress || row.owner_wallet_address || row.ownerWalletAddress, 140),
      txHash: safeText(row.tx_hash || row.txHash, 180),
      public: true,
      encrypted: false,
      exactCidRequired: true,
    };
    const directCid = normalizeCid(row.cid);
    if (directCid) {
      records.push({
        ...shared,
        cid: directCid,
        column: safeText(row.column || "cid", 80),
        payloadClass: safeText(row.payloadClass || row.class || "legacy_public_asset", 80),
      });
    }
    const imageCid = cidFromAny(row, ["image_cid", "imageCid"]);
    if (imageCid) {
      records.push({ ...shared, cid: imageCid, column: "image_cid", payloadClass: "profile_nft_image" });
    }
    const metadataCid = cidFromAny(row, ["metadata_cid", "metadataCid"]);
    if (metadataCid) {
      records.push({ ...shared, cid: metadataCid, column: "metadata_cid", payloadClass: "profile_nft_metadata" });
    }
    const thumbnailCid = thumbnailCidFromRow(row);
    if (thumbnailCid) {
      records.push({ ...shared, cid: thumbnailCid, column: "thumbnail_cid", payloadClass: "profile_nft_thumbnail" });
    }
  }
  return records;
}

async function readPointerMemoRecords({ limitRows = 0, lookbackDays = 0 } = {}) {
  const result = await query(
    `SELECT cid, pointer_kind, wallet_address, task_id, request_id, context_id, tx_hash, memo_index, created_at
       FROM pftl_pointer_memos
      WHERE COALESCE(cid, '') <> ''
        AND ($2::int <= 0 OR created_at >= now() - ($2::text || ' days')::interval)
      ORDER BY created_at DESC
      LIMIT CASE WHEN $1::int > 0 THEN $1::int ELSE 2147483647 END`,
    [Math.max(0, Number(limitRows || 0)), Math.max(0, Number(lookbackDays || 0))]
  );
  return result.rows.map((row) => ({
    source: "current_db",
    table: "pftl_pointer_memos",
    column: "cid",
    cid: row.cid,
    payloadClass: classForPointerKind(row.pointer_kind),
    walletAddress: row.wallet_address,
    taskId: row.task_id,
    requestId: row.request_id,
    contextId: row.context_id,
    txHash: row.tx_hash,
    rowId: `${row.tx_hash}:${row.memo_index}`,
    public: false,
    encrypted: true,
    exactCidRequired: true,
  }));
}

async function readTaskEventRecords({ limitRows = 0, lookbackDays = 0 } = {}) {
  const result = await query(
    `SELECT source_cid, event_type, account_id, wallet_address, task_id, source_tx_hash, id, occurred_at
       FROM task_events
      WHERE COALESCE(source_cid, '') <> ''
        AND ($2::int <= 0 OR occurred_at >= now() - ($2::text || ' days')::interval)
      ORDER BY occurred_at DESC
      LIMIT CASE WHEN $1::int > 0 THEN $1::int ELSE 2147483647 END`,
    [Math.max(0, Number(limitRows || 0)), Math.max(0, Number(lookbackDays || 0))]
  );
  return result.rows.map((row) => ({
    source: "current_db",
    table: "task_events",
    column: "source_cid",
    cid: row.source_cid,
    payloadClass: classForTaskEvent(row.event_type),
    accountId: row.account_id,
    walletAddress: row.wallet_address,
    taskId: row.task_id,
    txHash: row.source_tx_hash,
    rowId: row.id,
    public: false,
    encrypted: true,
    exactCidRequired: true,
  }));
}

async function readProfileNftRecords({ limitRows = 0 } = {}) {
  const result = await query(
    `SELECT id, account_id, wallet_address, status, image_cid, metadata_cid, metadata_json, tx_hash, nft_token_id, updated_at
       FROM profile_nfts
      WHERE COALESCE(image_cid, '') <> ''
         OR COALESCE(metadata_cid, '') <> ''
         OR COALESCE(metadata_json->>'thumbnailCid', '') <> ''
         OR COALESCE(metadata_json->>'thumbnail_cid', '') <> ''
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT CASE WHEN $1::int > 0 THEN $1::int ELSE 2147483647 END`,
    [Math.max(0, Number(limitRows || 0))]
  );
  const records = [];
  for (const row of result.rows) {
    const shared = {
      source: "current_db",
      table: "profile_nfts",
      accountId: row.account_id,
      walletAddress: row.wallet_address,
      txHash: row.tx_hash,
      rowId: row.id,
      public: true,
      encrypted: false,
      exactCidRequired: true,
    };
    const imageCid = normalizeCid(row.image_cid);
    if (imageCid) {
      records.push({ ...shared, column: "image_cid", cid: imageCid, payloadClass: "profile_nft_image" });
    }
    const metadataCid = normalizeCid(row.metadata_cid);
    if (metadataCid) {
      records.push({ ...shared, column: "metadata_cid", cid: metadataCid, payloadClass: "profile_nft_metadata" });
    }
    const thumbnailCid = thumbnailCidFromRow(row);
    if (thumbnailCid) {
      records.push({ ...shared, column: "thumbnail_cid", cid: thumbnailCid, payloadClass: "profile_nft_thumbnail" });
    }
  }
  return records;
}

async function readCurrentDbRecords({ includeSources = [], limitRows = 0, lookbackDays = 0 } = {}) {
  const records = [];
  if (includeSources.includes("pointers")) {
    records.push(...await readPointerMemoRecords({ limitRows, lookbackDays }));
  }
  if (includeSources.includes("task-events")) {
    records.push(...await readTaskEventRecords({ limitRows, lookbackDays }));
  }
  if (includeSources.includes("profile-nfts")) {
    records.push(...await readProfileNftRecords({ limitRows }));
  }
  return records;
}

async function fetchCidFromGateway({ cid, gateway, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${gateway.replace(/\/$/, "")}/${encodeURIComponent(cid)}`, {
      method: "GET",
      headers: { accept: "application/json,image/*,*/*;q=0.8" },
      signal: controller.signal,
    });
    const contentType = safeText(response.headers.get("content-type"), 160);
    const bytes = Number(response.headers.get("content-length") || 0);
    if (response.body) await response.body.cancel().catch(() => null);
    return {
      gateway,
      ok: response.ok,
      status: response.status,
      contentType,
      bytes: Number.isFinite(bytes) ? bytes : 0,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      error: "",
    };
  } catch (error) {
    return {
      gateway,
      ok: false,
      status: null,
      contentType: "",
      bytes: 0,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      error: error?.name === "AbortError" ? "timeout" : safeText(error?.message || "fetch_failed", 120),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyCidGateways({
  cid,
  currentGateways = defaultCurrentGateways,
  legacyGateways = defaultLegacyGateways,
  timeoutMs = 8000,
  fetchImpl = fetch,
} = {}) {
  const currentAttempts = await Promise.all(currentGateways.map((gateway) => fetchCidFromGateway({
    cid,
    gateway,
    timeoutMs,
    fetchImpl,
  })));
  const firstCurrent = currentAttempts.find((attempt) => attempt.ok) || null;
  const legacyAttempts = firstCurrent
    ? []
    : await Promise.all(legacyGateways.map((gateway) => fetchCidFromGateway({
      cid,
      gateway,
      timeoutMs,
      fetchImpl,
    })));
  const firstLegacy = legacyAttempts.find((attempt) => attempt.ok) || null;
  return {
    checkedAt: nowIso(),
    firstGateway: firstCurrent?.gateway || firstLegacy?.gateway || "",
    firstCurrentGateway: firstCurrent?.gateway || "",
    firstLegacyGateway: firstLegacy?.gateway || "",
    currentAttempts,
    legacyAttempts,
    status: firstCurrent
      ? "current_resolvable"
      : firstLegacy
        ? "needs_repin"
        : "missing_from_all_gateways",
  };
}

export async function checkPinataCidStatus({
  cid,
  env = process.env,
  timeoutMs = 8000,
  fetchImpl = fetch,
} = {}) {
  const headers = pinataHeaders(env);
  if (!headers) {
    return {
      provider: "pinata",
      status: "not_configured",
      checkedAt: nowIso(),
      error: "",
    };
  }

  const normalizedCid = normalizeCid(cid);
  if (!normalizedCid) {
    return {
      provider: "pinata",
      status: "invalid_cid",
      checkedAt: nowIso(),
      error: "ipfs_cid_invalid",
    };
  }

  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL("https://api.pinata.cloud/data/pinList");
    url.searchParams.set("hashContains", normalizedCid);
    url.searchParams.set("pageLimit", "10");
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        provider: "pinata",
        status: "error",
        checkedAt: nowIso(),
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        httpStatus: response.status,
        error: safeText(body?.error || body?.message || `pinata_pin_list_http_${response.status}`, 240),
      };
    }

    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const exact = rows.find((row) => normalizeCid(row?.ipfs_pin_hash || row?.cid || row?.IpfsHash) === normalizedCid);
    return {
      provider: "pinata",
      status: exact ? safeText(exact.status || "pinned", 80) || "pinned" : "not_found",
      checkedAt: nowIso(),
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      httpStatus: response.status,
      matchCount: rows.length,
      matchedHash: normalizeCid(exact?.ipfs_pin_hash || exact?.cid || exact?.IpfsHash),
      datePinned: safeText(exact?.date_pinned || exact?.datePinned, 80),
      metadataName: safeText(exact?.metadata?.name || exact?.name, 160),
      error: "",
    };
  } catch (error) {
    return {
      provider: "pinata",
      status: "error",
      checkedAt: nowIso(),
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      httpStatus: null,
      error: error?.name === "AbortError" ? "timeout" : safeText(error?.message || "pinata_pin_list_failed", 240),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function migrationStatusFor({ gatewayStatus = "not_checked", pinProviderStatus = null } = {}) {
  if (pinProviderStatus?.provider === "pinata" && pinProviderStatus.status === "pinned") {
    return "current_pinned";
  }
  return gatewayStatus || "not_checked";
}

async function mapWithConcurrency(items = [], concurrency = 4, mapper) {
  const bounded = Math.min(32, Math.max(1, Number(concurrency || 4)));
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

export async function verifyInventory({
  inventory = [],
  currentGateways = defaultCurrentGateways,
  legacyGateways = defaultLegacyGateways,
  timeoutMs = 8000,
  concurrency = 4,
  checkPinata = false,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return mapWithConcurrency(inventory, concurrency, async (entry) => {
    const gatewayCheck = await verifyCidGateways({
      cid: entry.cid,
      currentGateways,
      legacyGateways,
      timeoutMs,
      fetchImpl,
    });
    const pinProviderStatus = checkPinata
      ? await checkPinataCidStatus({ cid: entry.cid, env, timeoutMs, fetchImpl })
      : null;
    return {
      ...entry,
      firstGateway: gatewayCheck.firstGateway,
      contentType: gatewayCheck.currentAttempts.find((attempt) => attempt.ok)?.contentType
        || gatewayCheck.legacyAttempts.find((attempt) => attempt.ok)?.contentType
        || "",
      byteSize: gatewayCheck.currentAttempts.find((attempt) => attempt.ok)?.bytes
        || gatewayCheck.legacyAttempts.find((attempt) => attempt.ok)?.bytes
        || 0,
      currentPinProviderStatus: pinProviderStatus?.status || "not_checked",
      pinProviderStatus,
      migrationStatus: migrationStatusFor({ gatewayStatus: gatewayCheck.status, pinProviderStatus }),
      gatewayCheck,
    };
  });
}

export async function applyPinProviderStatus({
  inventory = [],
  timeoutMs = 8000,
  concurrency = 4,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return mapWithConcurrency(inventory, concurrency, async (entry) => {
    const pinProviderStatus = await checkPinataCidStatus({ cid: entry.cid, env, timeoutMs, fetchImpl });
    return {
      ...entry,
      currentPinProviderStatus: pinProviderStatus.status,
      pinProviderStatus,
      migrationStatus: migrationStatusFor({ gatewayStatus: entry.migrationStatus || "not_checked", pinProviderStatus }),
    };
  });
}

function summarize(inventory = []) {
  const byMigrationStatus = {};
  const byPayloadClass = {};
  const bySource = {};
  const byPinProviderStatus = {};
  for (const entry of inventory) {
    const status = entry.migrationStatus || "not_checked";
    byMigrationStatus[status] = (byMigrationStatus[status] || 0) + 1;
    const pinStatus = entry.currentPinProviderStatus || "not_checked";
    byPinProviderStatus[pinStatus] = (byPinProviderStatus[pinStatus] || 0) + 1;
    for (const payloadClass of entry.payloadClasses || []) {
      byPayloadClass[payloadClass] = (byPayloadClass[payloadClass] || 0) + 1;
    }
    for (const source of entry.sources || []) {
      bySource[source] = (bySource[source] || 0) + 1;
    }
  }
  return {
    totalUniqueCids: inventory.length,
    byMigrationStatus,
    byPinProviderStatus,
    byPayloadClass,
    bySource,
    exactCidRequired: inventory.filter((entry) => entry.exactCidRequired).length,
    publicCids: inventory.filter((entry) => entry.public).length,
    encryptedCids: inventory.filter((entry) => entry.encrypted).length,
  };
}

function writeJsonReport(outputPath = "", report = {}) {
  if (!outputPath) return;
  const resolved = path.resolve(outputPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

async function loadRecordsFromInputs({ includeSources, sourceJson = "", limitRows = 0, lookbackDays = 0 } = {}) {
  let records = [];
  const wantsCurrentDb = includeSources.some((source) => ["pointers", "task-events", "profile-nfts"].includes(source));
  if (wantsCurrentDb) {
    records.push(...await readCurrentDbRecords({ includeSources, limitRows, lookbackDays }));
  }
  if (sourceJson) {
    const rows = parseJsonInput(readFileSync(sourceJson, "utf8"));
    records.push(...recordsFromLegacyJsonRows(limitRows > 0 ? rows.slice(0, limitRows) : rows, { source: "source_json" }));
  }
  if (hasFlag("stdin")) {
    const rows = parseJsonInput(readFileSync(0, "utf8"));
    records.push(...recordsFromLegacyJsonRows(limitRows > 0 ? rows.slice(0, limitRows) : rows, { source: "stdin" }));
  }
  return records;
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

  const sourceJson = safeText(argValue("source-json"), 500);
  const source = safeText(
    argValue("source", sourceJson || hasFlag("stdin") ? "none" : "current-db"),
    80
  );
  const includeSources = source === "current-db"
    ? parseList(argValue("include", "pointers,task-events,profile-nfts"), ["pointers", "task-events", "profile-nfts"])
    : [];
  if (hasArg("source") && source && source !== "current-db" && source !== "none") {
    throw new Error(`unknown_source_${source}`);
  }
  const limitRows = Math.max(0, Number(argValue("limit-rows", "0")) || 0);
  const limitCids = Math.max(0, Number(argValue("limit", "0")) || 0);
  const offset = Math.max(0, Number(argValue("offset", "0")) || 0);
  const lookbackDays = Math.max(0, Number(argValue("lookback-days", "0")) || 0);
  const verifyGateways = hasFlag("verify-gateways");
  const checkPinata = hasFlag("check-pinata");
  const concurrency = Math.max(1, Number(argValue("concurrency", "4")) || 4);
  const timeoutMs = Math.max(500, Number(argValue("timeout-ms", "8000")) || 8000);
  const currentGateways = uniqueList(parseList(argValue("current-gateways"), defaultCurrentGateways));
  const legacyGateways = uniqueList(parseList(argValue("legacy-gateways"), defaultLegacyGateways));
  const output = safeText(argValue("output"), 600);
  const stdoutMode = safeText(argValue("stdout", output ? "summary" : "full"), 20);
  const pretty = hasFlag("pretty") || Boolean(output);

  const records = await loadRecordsFromInputs({
    includeSources,
    sourceJson,
    limitRows,
    lookbackDays,
  });
  const allInventory = buildInventory(records);
  const selected = allInventory.slice(offset, limitCids > 0 ? offset + limitCids : undefined);
  const uncheckedInventory = verifyGateways
    ? await verifyInventory({
      inventory: selected,
      currentGateways,
      legacyGateways,
      timeoutMs,
      concurrency,
      checkPinata,
    })
    : selected.map((entry) => ({
      ...entry,
      firstGateway: "",
      contentType: "",
      byteSize: 0,
      currentPinProviderStatus: "not_checked",
      pinProviderStatus: null,
      migrationStatus: "not_checked",
    }));
  const inventory = !verifyGateways && checkPinata
    ? await applyPinProviderStatus({
      inventory: uncheckedInventory,
      timeoutMs,
      concurrency,
    })
    : uncheckedInventory;

  await closePool().catch(() => null);

  const report = {
    ok: true,
    generatedAt: nowIso(),
    mode: verifyGateways ? "verify_gateways" : "inventory_only",
    pinProviderCheck: checkPinata ? "pinata" : "not_checked",
    source,
    sourceJson: sourceJson ? path.resolve(sourceJson) : "",
    includeSources,
    sourceRecords: records.length,
    totalUniqueCids: allInventory.length,
    selectedCids: inventory.length,
    offset,
    limit: limitCids,
    lookbackDays,
    currentGateways,
    legacyGateways,
    summary: summarize(inventory),
    inventory,
  };
  writeJsonReport(output, report);
  const stdoutReport = stdoutMode === "full"
    ? report
    : {
      ...report,
      inventory: undefined,
      stdout: {
        mode: "summary",
        note: output ? `Full inventory written to ${path.resolve(output)}` : "Full inventory suppressed from stdout.",
      },
    };
  console.log(JSON.stringify(stdoutReport, null, pretty ? 2 : 0));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(async (error) => {
    await closePool().catch(() => null);
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}
