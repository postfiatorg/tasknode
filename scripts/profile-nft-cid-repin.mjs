import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { closePool, query } from "../server/db/pool.js";
import {
  isValidContextCid,
  normalizeContextCid,
  pinIpfsCidByHash,
} from "../server/context-ipfs.js";

const defaultLegacyGateways = [
  "https://ipfs-testnet.postfiat.org/ipfs/",
  "https://pft-ipfs-testnet-node-1.fly.dev/ipfs/",
];

const defaultCurrentGateways = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
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
    "  npm run profile-nft-cid-repin -- --source current-db --dry-run",
    "  npm run profile-nft-cid-repin -- --source-json /tmp/pftasks-nft-mints.json --dry-run",
    "  npm run profile-nft-cid-repin -- --source-json /tmp/pftasks-nft-mints.json --execute --limit 100",
    "",
    "Exact-repins profile NFT CIDs with Pinata pinByHash. It preserves original CIDs.",
    "Use --kinds image,metadata,thumbnail to control which CID classes are included.",
    "Use --verify-only to skip pinning and only check gateway reachability.",
    "Use --no-verify-after for bulk execute runs, then run --verify-only afterward.",
  ].join("\n"));
}

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
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
    const text = safeText(value, 500);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeCid(value = "") {
  const cid = normalizeContextCid(value);
  return isValidContextCid(cid) ? cid : "";
}

function cidFromRow(row = {}, key) {
  const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  return normalizeCid(row[key] || row[camel]);
}

function thumbnailCidFromRow(row = {}) {
  const explicit = cidFromRow(row, "thumbnail_cid");
  if (explicit) return explicit;
  const metadata = row.metadata_json || row.metadataJson || {};
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return normalizeCid(metadata.thumbnailCid || metadata.thumbnail_cid);
  }
  return "";
}

export function collectProfileNftCids(rows = [], { kinds = ["image", "metadata", "thumbnail"] } = {}) {
  const allowed = new Set(kinds.map((kind) => safeText(kind, 40)).filter(Boolean));
  const byCid = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const refs = [
      { kind: "image", cid: cidFromRow(row, "image_cid") },
      { kind: "metadata", cid: cidFromRow(row, "metadata_cid") },
      { kind: "thumbnail", cid: thumbnailCidFromRow(row) },
    ].filter((entry) => entry.cid && allowed.has(entry.kind));

    for (const ref of refs) {
      const existing = byCid.get(ref.cid) || {
        cid: ref.cid,
        kinds: new Set(),
        refCount: 0,
        sampleRows: [],
      };
      existing.kinds.add(ref.kind);
      existing.refCount += 1;
      if (existing.sampleRows.length < 5) {
        existing.sampleRows.push({
          id: safeText(row.id, 160),
          title: safeText(row.title || row.nft_name || row.display_name || row.displayName, 160),
          accountId: safeText(row.account_id || row.accountId, 160),
          walletAddress: safeText(row.wallet_address || row.walletAddress || row.owner_wallet_address || row.ownerWalletAddress, 160),
          mintedAt: safeText(row.minted_at || row.mintedAt, 80),
        });
      }
      byCid.set(ref.cid, existing);
    }
  }

  return [...byCid.values()]
    .map((entry) => ({
      ...entry,
      kinds: [...entry.kinds].sort(),
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
  throw new Error("source_json_rows_missing");
}

async function readCurrentDbRows({ limitRows = 0 } = {}) {
  const result = await query(
    `SELECT id, account_id, wallet_address, title, status,
            image_cid, metadata_cid, metadata_json, nft_token_id, tx_hash, minted_at, updated_at
       FROM profile_nfts
      WHERE COALESCE(image_cid, '') <> ''
         OR COALESCE(metadata_cid, '') <> ''
         OR COALESCE(metadata_json->>'thumbnailCid', '') <> ''
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT CASE WHEN $1::int > 0 THEN $1::int ELSE 2147483647 END`,
    [Math.max(0, Number(limitRows || 0))]
  );
  return result.rows;
}

function readSourceRows({ source = "", sourceJson = "", limitRows = 0 } = {}) {
  if (sourceJson) {
    const rows = parseJsonInput(readFileSync(sourceJson, "utf8"));
    return limitRows > 0 ? rows.slice(0, limitRows) : rows;
  }
  if (hasFlag("stdin")) {
    const rows = parseJsonInput(readFileSync(0, "utf8"));
    return limitRows > 0 ? rows.slice(0, limitRows) : rows;
  }
  if (source && source !== "current-db") {
    throw new Error(`unknown_source_${source}`);
  }
  return null;
}

async function fetchCidFromGateway({ cid, gateway, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${gateway.replace(/\/$/, "")}/${encodeURIComponent(cid)}`, {
      method: "GET",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const bytes = Number(response.headers.get("content-length") || 0);
    if (response.body) await response.body.cancel().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      bytes,
      gateway,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError" ? "timeout" : error?.message || "fetch_failed",
      gateway,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyCid({ cid, gateways = [], timeoutMs = 8000 } = {}) {
  const attempts = await Promise.all(gateways.map((gateway) => fetchCidFromGateway({
    cid,
    gateway,
    timeoutMs,
  })));
  const success = attempts.find((attempt) => attempt.ok) || null;
  return {
    ok: Boolean(success),
    success,
    attempts: attempts.map((attempt) => ({
      gateway: attempt.gateway,
      ok: attempt.ok,
      status: attempt.status || null,
      contentType: attempt.contentType || "",
      bytes: attempt.bytes || 0,
      error: attempt.error || "",
    })),
  };
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

async function processCidRecord({
  record,
  execute = false,
  verifyOnly = false,
  currentGateways = defaultCurrentGateways,
  legacyGateways = defaultLegacyGateways,
  timeoutMs = 8000,
  verifyAfter = true,
} = {}) {
  const beforeCurrent = await verifyCid({ cid: record.cid, gateways: currentGateways, timeoutMs });
  const legacy = beforeCurrent.ok
    ? { ok: true, skipped: true, reason: "current_gateway_resolves" }
    : await verifyCid({ cid: record.cid, gateways: legacyGateways, timeoutMs });
  let pin = null;
  if (execute && !verifyOnly && !beforeCurrent.ok && legacy.ok) {
    try {
      pin = await pinIpfsCidByHash({
        cid: record.cid,
        name: `profile_nft_${record.kinds.join("_")}_${record.cid}`,
        keyvalues: {
          type: "profile_nft_legacy_repin",
          kinds: record.kinds.join(","),
          refCount: String(record.refCount),
        },
      });
    } catch (error) {
      pin = {
        ok: false,
        error: error?.message || "pin_by_hash_failed",
        status: error?.status || null,
      };
    }
  }
  const afterCurrent = execute && verifyAfter && pin?.ok
    ? await verifyCid({ cid: record.cid, gateways: currentGateways, timeoutMs })
    : null;
  return {
    cid: record.cid,
    kinds: record.kinds,
    refCount: record.refCount,
    sampleRows: record.sampleRows,
    beforeCurrent,
    legacy,
    pin,
    afterCurrent,
    status: beforeCurrent.ok
      ? "already_current_resolvable"
      : !legacy.ok
        ? "missing_from_legacy_gateways"
        : execute
          ? pin?.ok
            ? afterCurrent?.ok
              ? "repinned_and_verified"
              : "repin_requested_not_yet_verified"
            : "repin_failed"
          : "needs_repin",
  };
}

export async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    usage();
    return;
  }

  const execute = hasFlag("execute");
  const dryRun = hasFlag("dry-run") || !execute;
  const verifyOnly = hasFlag("verify-only");
  const source = safeText(argValue("source", "current-db"), 80);
  const sourceJson = safeText(argValue("source-json"), 500);
  const limitRows = Math.max(0, Number(argValue("limit-rows", "0")) || 0);
  const limitCids = Math.max(0, Number(argValue("limit", "0")) || 0);
  const offset = Math.max(0, Number(argValue("offset", "0")) || 0);
  const concurrency = Math.max(1, Number(argValue("concurrency", "4")) || 4);
  const timeoutMs = Math.max(1000, Number(argValue("timeout-ms", "8000")) || 8000);
  const verifyAfter = !hasFlag("no-verify-after");
  const kinds = parseList(argValue("kinds", "image,metadata,thumbnail"), ["image", "metadata", "thumbnail"]);
  const currentGateways = uniqueList(parseList(argValue("current-gateways"), defaultCurrentGateways).map(normalizeGateway));
  const legacyGateways = uniqueList(parseList(argValue("legacy-gateways"), defaultLegacyGateways).map(normalizeGateway));

  let rows = readSourceRows({ source, sourceJson, limitRows });
  if (!rows) rows = await readCurrentDbRows({ limitRows });
  const records = collectProfileNftCids(rows, { kinds });
  const selected = records.slice(offset, limitCids > 0 ? offset + limitCids : undefined);
  const results = await mapWithConcurrency(selected, concurrency, (record) => processCidRecord({
    record,
    execute,
    verifyOnly,
    currentGateways,
    legacyGateways,
    timeoutMs,
    verifyAfter,
  }));

  await closePool().catch(() => null);
  const summary = {
    ok: true,
    mode: verifyOnly ? "verify_only" : execute ? "execute" : dryRun ? "dry_run" : "preview",
    source: sourceJson ? "source-json" : hasFlag("stdin") ? "stdin" : source,
    sourceRows: rows.length,
    uniqueCids: records.length,
    selectedCids: selected.length,
    offset,
    verifyAfter,
    currentGateways,
    legacyGateways,
    statusCounts: results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] || 0) + 1;
      return acc;
    }, {}),
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(async (error) => {
    await closePool().catch(() => null);
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
