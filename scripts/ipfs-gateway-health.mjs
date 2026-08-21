import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { isValidContextCid, normalizeContextCid } from "../server/context-ipfs.js";

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
    "  npm run ipfs-gateway-health -- --gateway https://gateway.example/ipfs/ --cid <cid>",
    "  npm run ipfs-gateway-health -- --gateways https://a/ipfs/,https://b/ipfs/ --cids <cid1>,<cid2> --output /tmp/ipfs-health.json",
    "",
    "Checks real gateway CID reads and exits nonzero on unavailable canaries.",
    "This is the health boundary missing from static /health endpoints.",
  ].join("\n"));
}

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function parseList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function normalizeCidList(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const cid = normalizeContextCid(value);
    if (!cid || !isValidContextCid(cid) || seen.has(cid)) continue;
    seen.add(cid);
    out.push(cid);
  }
  return out;
}

async function checkGatewayCid({ gateway, cid, timeoutMs = 8000, fetchImpl = fetch } = {}) {
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
      cid,
      ok: response.ok,
      status: response.status,
      contentType,
      bytes: Number.isFinite(bytes) ? bytes : 0,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      error: response.ok ? "" : `HTTP_${response.status}`,
    };
  } catch (error) {
    return {
      gateway,
      cid,
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

export async function checkGatewayHealth({
  gateways = [],
  cids = [],
  timeoutMs = 8000,
  fetchImpl = fetch,
} = {}) {
  const normalizedGateways = uniqueList(gateways);
  const normalizedCids = normalizeCidList(cids);
  const checks = [];
  for (const gateway of normalizedGateways) {
    for (const cid of normalizedCids) {
      checks.push(await checkGatewayCid({ gateway, cid, timeoutMs, fetchImpl }));
    }
  }
  const failures = checks.filter((check) => !check.ok);
  return {
    ok: normalizedGateways.length > 0 && normalizedCids.length > 0 && failures.length === 0,
    checkedAt: new Date().toISOString(),
    gateways: normalizedGateways,
    cids: normalizedCids,
    timeoutMs,
    checks,
    failures,
    summary: {
      gatewayCount: normalizedGateways.length,
      cidCount: normalizedCids.length,
      checkCount: checks.length,
      failureCount: failures.length,
    },
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
  const gateways = uniqueList([
    ...parseList(argValue("gateway")),
    ...parseList(argValue("gateways")),
  ]);
  const cids = normalizeCidList([
    ...parseList(argValue("cid")),
    ...parseList(argValue("cids")),
  ]);
  const timeoutMs = Math.max(500, Number(argValue("timeout-ms", "8000")) || 8000);
  const output = safeText(argValue("output"), 600);
  if (!gateways.length || !cids.length) {
    usage();
    const error = new Error("gateway_and_cid_required");
    error.status = 2;
    throw error;
  }
  const report = await checkGatewayHealth({ gateways, cids, timeoutMs });
  writeJsonReport(output, report);
  console.log(JSON.stringify(report, null, output || hasFlag("pretty") ? 2 : 0));
  if (!report.ok) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exit(error?.status || 1);
  });
}

