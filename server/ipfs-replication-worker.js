import { spawn } from "node:child_process";
import { hostname } from "node:os";
import {
  claimIpfsReplicationJobs,
  markIpfsReplicationJobFailed,
  markIpfsReplicationJobVerified,
} from "./repositories/ipfs-replication-jobs.js";

const DEFAULT_CLEAN_GATEWAY = "https://pft-ipfs-testnet-clean.fly.dev/ipfs/";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_INITIAL_DELAY_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PIN_TIMEOUT_MS = 240_000;

let timer = null;
let initialTimer = null;
let running = false;

function safeText(value = "", max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function boolEnv(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function gatewayBase(env = process.env) {
  const configured = safeText(env.TASKNODE_IPFS_CLEAN_GATEWAY || env.TASKNODE_IPFS_REPLICATION_GATEWAY, 2000);
  const value = configured || DEFAULT_CLEAN_GATEWAY;
  return value.endsWith("/") ? value : `${value}/`;
}

function cidGatewayUrl({ cid, env = process.env } = {}) {
  return `${gatewayBase(env).replace(/\/$/, "")}/${encodeURIComponent(safeText(cid, 240))}`;
}

function payloadClassIsImage(payloadClass = "") {
  const klass = safeText(payloadClass, 120);
  return klass === "profile_nft_image" || klass === "profile_nft_thumbnail";
}

function replicationConcurrency(env = process.env) {
  return clampInteger(env.TASKNODE_IPFS_REPLICATION_CONCURRENCY, 6, 1, 20);
}

async function readFirstByte(response) {
  const reader = response.body?.getReader();
  if (!reader) return 0;
  try {
    const { done, value } = await reader.read();
    return done ? 0 : Number(value?.byteLength || 0);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function responseContentType(response) {
  return safeText(response.headers?.get?.("content-type"), 200).toLowerCase();
}

function verifyContentType({ contentType = "", payloadClass = "", strictContentType = false, env = process.env } = {}) {
  if (strictContentType && payloadClassIsImage(payloadClass) && !contentType.startsWith("image/")) {
    return { ok: false, error: "content_type_mismatch", contentType, gateway: gatewayBase(env) };
  }
  return null;
}

async function verifyHead({ url, payloadClass, env, fetchImpl, signal, strictContentType }) {
  const response = await fetchImpl(url, {
    method: "HEAD",
    headers: { accept: payloadClassIsImage(payloadClass) ? "image/*,*/*" : "application/json,*/*" },
    signal,
  });
  const contentType = responseContentType(response);
  if (!response.ok) return { ok: false, fallback: true, status: response.status, contentType };
  const contentTypeError = verifyContentType({ contentType, payloadClass, strictContentType, env });
  if (contentTypeError) return contentTypeError;
  return {
    ok: true,
    gateway: gatewayBase(env),
    contentType,
    verifyMethod: "HEAD",
  };
}

async function verifyRangeGet({ url, payloadClass, env, fetchImpl, signal, strictContentType }) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: payloadClassIsImage(payloadClass) ? "image/*,*/*" : "application/json,*/*",
      range: "bytes=0-0",
    },
    signal,
  });
  const contentType = responseContentType(response);
  if (!response.ok && response.status !== 206) {
    return { ok: false, error: `clean_gateway_http_${response.status}`, status: response.status, gateway: gatewayBase(env) };
  }
  const contentTypeError = verifyContentType({ contentType, payloadClass, strictContentType, env });
  if (contentTypeError) return contentTypeError;
  const byteCount = await readFirstByte(response);
  if (!byteCount) return { ok: false, error: "clean_gateway_empty_response", gateway: gatewayBase(env) };
  return {
    ok: true,
    gateway: gatewayBase(env),
    contentType,
    sizeBytes: byteCount,
    verifyMethod: response.status === 206 ? "GET_RANGE" : "GET_RANGE_200",
  };
}

export async function verifyCidOnCleanGateway({
  cid,
  payloadClass = "unknown",
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = env.TASKNODE_IPFS_REPLICATION_VERIFY_TIMEOUT_MS,
  strictContentType = boolEnv(env.TASKNODE_IPFS_REPLICATION_STRICT_CONTENT_TYPE),
} = {}) {
  const normalizedCid = safeText(cid, 240);
  if (!normalizedCid) return { ok: false, error: "cid_missing" };
  const safeTimeout = clampInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), safeTimeout);
  const url = cidGatewayUrl({ cid: normalizedCid, env });
  try {
    const head = await verifyHead({
      url,
      payloadClass,
      env,
      fetchImpl,
      signal: controller.signal,
      strictContentType,
    });
    if (head.ok) {
      return {
        ok: true,
        cid: normalizedCid,
        gateway: head.gateway,
        contentType: head.contentType,
        verifyMethod: head.verifyMethod,
      };
    }
    if (!head.fallback) return head;
    const ranged = await verifyRangeGet({
      url,
      payloadClass,
      env,
      fetchImpl,
      signal: controller.signal,
      strictContentType,
    });
    if (!ranged.ok) return ranged;
    return {
      ok: true,
      cid: normalizedCid,
      gateway: ranged.gateway,
      contentType: ranged.contentType,
      sizeBytes: ranged.sizeBytes,
      verifyMethod: ranged.verifyMethod,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError" ? "clean_gateway_timeout" : safeText(error?.message || error, 300),
      gateway: gatewayBase(env),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function postPinEndpoint({
  endpoint,
  token = "",
  body,
  timeoutMs,
  fetchImpl,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok || payload?.ok === false) {
      return {
        ok: false,
        error: payload?.error || payload?.message || `pin_endpoint_http_${response.status}`,
        response: payload,
      };
    }
    return { ok: true, response: payload };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError" ? "pin_endpoint_timeout" : safeText(error?.message || error, 300),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function runPinCommand({ command, body, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, error: "pin_command_timeout", stderr: safeText(stderr, 1000) });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      let payload = {};
      try {
        payload = stdout.trim() ? JSON.parse(stdout.trim().split("\n").at(-1)) : {};
      } catch {
        payload = { raw: stdout };
      }
      if (code !== 0 || payload?.ok === false) {
        resolve({
          ok: false,
          error: payload?.error || `pin_command_exit_${code}`,
          stdout: safeText(stdout, 1000),
          stderr: safeText(stderr, 1000),
          response: payload,
        });
        return;
      }
      resolve({ ok: true, response: payload, stdout: safeText(stdout, 1000), stderr: safeText(stderr, 1000) });
    });
    child.stdin.end(JSON.stringify(body));
  });
}

export async function pinCidWithConfiguredInterface({
  job,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const endpoint = safeText(env.TASKNODE_IPFS_REPLICATION_PIN_ENDPOINT, 2000);
  const command = safeText(env.TASKNODE_IPFS_REPLICATION_PIN_COMMAND, 4000);
  const timeoutMs = clampInteger(env.TASKNODE_IPFS_REPLICATION_PIN_TIMEOUT_MS, DEFAULT_PIN_TIMEOUT_MS, 1_000, 30 * 60_000);
  const body = {
    cid: job.cid,
    payloadClass: job.payloadClass,
    source: job.source,
    sourceRef: job.sourceRef,
    exactCidRequired: job.exactCidRequired !== false,
    minReplicas: clampInteger(env.TASKNODE_IPFS_REPLICATION_MIN_REPLICAS, 2, 1, 20),
    cleanGateway: gatewayBase(env),
    exactReaddGateways: String(
      env.TASKNODE_IPFS_REPLICATION_EXACT_READD_GATEWAYS ||
        "https://gateway.pinata.cloud/ipfs/,https://ipfs.io/ipfs/"
    )
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
  if (endpoint) {
    return postPinEndpoint({
      endpoint,
      token: safeText(env.TASKNODE_IPFS_REPLICATION_PIN_TOKEN, 4000),
      body,
      timeoutMs,
      fetchImpl,
    });
  }
  if (command) {
    return runPinCommand({ command, body, timeoutMs });
  }
  return { ok: false, error: "first_party_pin_interface_missing" };
}

function retryDelayForAttempts(attempts = 0, env = process.env) {
  const base = clampInteger(env.TASKNODE_IPFS_REPLICATION_RETRY_BASE_MS, 60_000, 1_000, 30 * 60_000);
  const cappedAttempts = Math.min(Math.max(Number(attempts || 0), 0), 8);
  return Math.min(base * (2 ** cappedAttempts), 24 * 60 * 60 * 1000);
}

export async function processIpfsReplicationJob({
  job,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const existing = await verifyCidOnCleanGateway({
    cid: job.cid,
    payloadClass: job.payloadClass,
    env,
    fetchImpl,
  });
  if (existing.ok) {
    return markIpfsReplicationJobVerified({
      id: job.id,
      verifiedGateway: existing.gateway,
      metadata: { cleanGateway: existing },
    });
  }

  const pin = await pinCidWithConfiguredInterface({ job, env, fetchImpl });
  if (!pin.ok) {
    return markIpfsReplicationJobFailed({
      id: job.id,
      error: pin.error || "first_party_pin_failed",
      retry: pin.error !== "first_party_pin_interface_missing",
      retryDelayMs: retryDelayForAttempts(job.attempts, env),
      maxAttempts: clampInteger(env.TASKNODE_IPFS_REPLICATION_MAX_ATTEMPTS, 10, 1, 100),
      metadata: { cleanGatewayBeforePin: existing, pin },
    });
  }

  const verified = await verifyCidOnCleanGateway({
    cid: job.cid,
    payloadClass: job.payloadClass,
    env,
    fetchImpl,
  });
  if (!verified.ok) {
    return markIpfsReplicationJobFailed({
      id: job.id,
      error: verified.error || "clean_gateway_verify_failed_after_pin",
      retry: true,
      retryDelayMs: retryDelayForAttempts(job.attempts, env),
      maxAttempts: clampInteger(env.TASKNODE_IPFS_REPLICATION_MAX_ATTEMPTS, 10, 1, 100),
      metadata: { cleanGatewayBeforePin: existing, pin, cleanGatewayAfterPin: verified },
    });
  }
  return markIpfsReplicationJobVerified({
    id: job.id,
    verifiedGateway: verified.gateway,
    metadata: { pin, cleanGateway: verified },
  });
}

export async function processIpfsReplicationJobsOnce({
  env = process.env,
  fetchImpl = fetch,
  jobProcessor = processIpfsReplicationJob,
  claimJobs = claimIpfsReplicationJobs,
  markFailed = markIpfsReplicationJobFailed,
  logger = console,
  workerId = `ipfs_replication_${hostname()}_${process.pid}`,
  limit = env.TASKNODE_IPFS_REPLICATION_BATCH_LIMIT,
  sourceRefPrefix = "",
} = {}) {
  const claimed = await claimJobs({
    workerId,
    limit: clampInteger(limit, 10, 1, 100),
    sourceRefPrefix,
  });
  if (claimed.skipped) return { ok: true, skipped: true, reason: claimed.reason, processed: 0 };
  const results = [];
  const jobs = Array.isArray(claimed.jobs) ? claimed.jobs : [];
  let nextIndex = 0;
  const processNext = async () => {
    while (nextIndex < jobs.length) {
      const job = jobs[nextIndex];
      nextIndex += 1;
      const index = nextIndex - 1;
      results[index] = await processClaimedIpfsReplicationJob({
        job,
        env,
        fetchImpl,
        jobProcessor,
        logger,
        markFailed,
      });
    }
  };
  const workerCount = Math.min(replicationConcurrency(env), Math.max(1, jobs.length));
  await Promise.all(Array.from({ length: workerCount }, processNext));
  const failed = results.filter((result) => result.ok === false).length;
  return {
    ok: failed === 0,
    claimed: jobs.length,
    processed: results.length,
    failed,
    results,
  };
}

async function processClaimedIpfsReplicationJob({
  job,
  env = process.env,
  fetchImpl = fetch,
  jobProcessor = processIpfsReplicationJob,
  logger = console,
  markFailed = markIpfsReplicationJobFailed,
} = {}) {
  try {
    const result = await jobProcessor({ job, env, fetchImpl });
    return { ok: result.ok, jobId: job.id, cid: job.cid, status: result.job?.status || "" };
  } catch (error) {
    logger.warn?.("ipfs_replication_job_failed", {
      jobId: job.id,
      cid: job.cid,
      error: error?.message || String(error),
    });
    await markFailed({
      id: job.id,
      error: error?.message || String(error),
      retry: true,
      retryDelayMs: retryDelayForAttempts(job.attempts, env),
    }).catch(() => {});
    return { ok: false, jobId: job.id, cid: job.cid, error: error?.message || String(error) };
  }
}

export function startIpfsReplicationWorker({
  env = process.env,
  logger = console,
} = {}) {
  if (timer || initialTimer) return { started: false, reason: "already_started" };
  const hasPinInterface = Boolean(
    safeText(env.TASKNODE_IPFS_REPLICATION_PIN_ENDPOINT, 2000) ||
      safeText(env.TASKNODE_IPFS_REPLICATION_PIN_COMMAND, 4000)
  );
  const enabled = env.TASKNODE_IPFS_REPLICATION_WORKER_ENABLED === "true" ||
    (hasPinInterface && env.TASKNODE_IPFS_REPLICATION_WORKER_ENABLED !== "false");
  if (!enabled) return { started: false, reason: "disabled" };
  const intervalMs = clampInteger(
    env.TASKNODE_IPFS_REPLICATION_WORKER_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    5_000,
    24 * 60 * 60 * 1000
  );
  const initialDelayMs = clampInteger(
    env.TASKNODE_IPFS_REPLICATION_INITIAL_DELAY_MS,
    DEFAULT_INITIAL_DELAY_MS,
    1_000,
    intervalMs
  );
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await processIpfsReplicationJobsOnce({ env, logger });
      if (result.processed || result.failed) logger.info?.("ipfs_replication_worker_tick", result);
    } catch (error) {
      logger.warn?.("ipfs_replication_worker_failed", error?.stack || error?.message || error);
    } finally {
      running = false;
    }
  };
  initialTimer = setTimeout(() => {
    initialTimer = null;
    tick();
  }, initialDelayMs);
  initialTimer.unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { started: true, intervalMs, initialDelayMs, hasPinInterface };
}
