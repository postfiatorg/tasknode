import { createHash } from "node:crypto";
import { enqueueIpfsReplicationJob } from "./repositories/ipfs-replication-jobs.js";

const DEFAULT_GATEWAYS = [
  "https://pft-ipfs-testnet-clean.fly.dev/ipfs/",
  "https://w3s.link/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
];

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{20,}|bafk[a-z2-7]{20,}|[a-zA-Z0-9]{32,})$/;
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_IPFS_JSON_BYTES = 1_048_576;
const MAX_PIN_JSON_BYTES = 1_048_576;
const MAX_PIN_FILE_BYTES = 8_388_608;

export function normalizeContextCid(value) {
  return String(value || "")
    .trim()
    .replace(/^ipfs:\/\//i, "")
    .replace(/^\/ipfs\//i, "")
    .split(/[?#]/)[0] || "";
}

export function isValidContextCid(value) {
  return CID_RE.test(normalizeContextCid(value));
}

export function contextIpfsGatewayList(env = process.env) {
  const configured = [
    env.TASKNODE_IPFS_GATEWAY,
    env.TASKNODE_IPFS_GATEWAYS,
    env.IPFS_GATEWAY_FALLBACKS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...configured, ...DEFAULT_GATEWAYS, env.IPFS_GATEWAY_URL]
    .filter(Boolean)
    .map((value) => value.endsWith("/") ? value : `${value}/`)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function readLimitedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IPFS_JSON_BYTES) {
      throw new Error("ipfs_response_too_large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function fetchContextIpfsJsonFromGateway({
  gateway,
  normalizedCid,
  timeoutMs,
  fetchImpl,
  controller = new AbortController(),
} = {}) {
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${gateway.replace(/\/$/, "")}/${encodeURIComponent(normalizedCid)}`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`HTTP_${response.status}`);
      error.code = `HTTP_${response.status}`;
      throw error;
    }

    const text = await readLimitedText(response);
    const payload = text ? JSON.parse(text) : {};
    return {
      ok: true,
      status: 200,
      cid: normalizedCid,
      gateway,
      payload,
    };
  } catch (error) {
    const wrapped = new Error(error?.name === "AbortError" ? "timeout" : error?.message || String(error));
    wrapped.gateway = gateway;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchContextIpfsJson({
  cid,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const normalizedCid = normalizeContextCid(cid);
  if (!isValidContextCid(normalizedCid)) {
    return {
      ok: false,
      status: 400,
      error: "context_cid_invalid",
      message: "CID is not valid.",
    };
  }

  const attempts = contextIpfsGatewayList(env).map((gateway) => {
    const controller = new AbortController();
    const attempt = fetchContextIpfsJsonFromGateway({
      gateway,
      normalizedCid,
      timeoutMs,
      fetchImpl,
      controller,
    });
    return { gateway, controller, attempt };
  });

  try {
    const result = await Promise.any(attempts.map(({ attempt }) => attempt));
    for (const { controller } of attempts) {
      if (!controller.signal.aborted) controller.abort();
    }
    return result;
  } catch (error) {
    const errors = Array.isArray(error?.errors) ? error.errors : [];
    const detail = errors
      .map((item) => `${item?.gateway || "gateway"}:${item?.message || item}`)
      .filter(Boolean)
      .slice(0, 4)
      .join(",");
    return {
      ok: false,
      status: 502,
      error: "context_ipfs_fetch_failed",
      message: "Context CID could not be fetched.",
      detail: detail || "gateway_unavailable",
    };
  }
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function sha256Hex(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function sha256BytesHex(bytes) {
  return createHash("sha256").update(Buffer.from(bytes || [])).digest("hex");
}

function pinataHeaders(env) {
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

function firstPartyIpfsWriteConfig(env = process.env) {
  const apiUrl = safeText(env.IPFS_API_URL, 2000).replace(/\/$/, "");
  const username = safeText(env.IPFS_API_USERNAME || env.IPFS_API_USER, 500);
  const password = safeText(env.IPFS_API_PASSWORD || env.IPFS_API_PASS, 2000);
  if (!apiUrl || !username || !password) return null;
  return { apiUrl, username, password };
}

async function pinFirstPartyIpfsFile({ buffer, expectedCid, mimeType, safeName, keyvalues, env, fetchImpl }) {
  const config = firstPartyIpfsWriteConfig(env);
  if (!config) return { ok: false, skipped: true, reason: "first_party_ipfs_not_configured" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: mimeType }), safeName);
    const authorization = Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64");
    const response = await fetchImpl(`${config.apiUrl}/api/v0/add?pin=true&cid-version=0&raw-leaves=false`, {
      method: "POST",
      headers: { authorization: `Basic ${authorization}` },
      body: formData,
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    let result = {};
    try {
      result = JSON.parse(text.trim().split("\n").filter(Boolean).at(-1) || "{}");
    } catch {
      result = {};
    }
    if (!response.ok) {
      const error = new Error(result?.Message || result?.message || `first_party_ipfs_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    const cid = normalizeContextCid(result?.Hash || result?.Cid || "");
    if (!cid || cid !== expectedCid) {
      const error = new Error("first_party_ipfs_cid_mismatch");
      error.status = 502;
      throw error;
    }

    const replicationEndpoint = safeText(env.TASKNODE_IPFS_REPLICATION_PIN_ENDPOINT, 2000);
    const replicationToken = safeText(env.TASKNODE_IPFS_REPLICATION_PIN_TOKEN, 4000);
    let clusterReplication = { ok: false, skipped: true, reason: "replication_endpoint_not_configured" };
    if (replicationEndpoint && replicationToken) {
      const payloadClass = classifyIpfsPayloadForReplication({ keyvalues, name: safeName, source: "first_party_file" });
      const configuredReplicas = Number(env.TASKNODE_IPFS_REPLICATION_MIN_REPLICAS || 2);
      const minReplicas = Number.isFinite(configuredReplicas)
        ? Math.max(1, Math.min(20, Math.trunc(configuredReplicas)))
        : 2;
      const replicationResponse = await fetchImpl(replicationEndpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${replicationToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          cid,
          payloadClass,
          source: "first_party_file",
          sourceRef: replicationSourceRef(safeObject(keyvalues)) || safeName,
          exactCidRequired: true,
          minReplicas,
        }),
        signal: controller.signal,
      });
      const replicationResult = await replicationResponse.json().catch(() => ({}));
      if (!replicationResponse.ok || replicationResult?.ok === false) {
        const error = new Error(replicationResult?.error || replicationResult?.message || `first_party_replication_http_${replicationResponse.status}`);
        error.status = replicationResponse.status;
        throw error;
      }
      clusterReplication = { ok: true, status: safeText(replicationResult?.status, 160) };
    }
    return { ok: true, provider: "first_party_ipfs", cid, clusterReplication };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("first_party_ipfs_timeout");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeText(value = "", max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function replicationSourceRef(keyvalues = {}) {
  const fields = [
    keyvalues.task_id,
    keyvalues.request_id,
    keyvalues.run_id,
    keyvalues.nftId,
    keyvalues.accountId,
    keyvalues.account_id,
    keyvalues.wallet_address,
    keyvalues.recipient_wallet,
  ];
  return safeText(fields.find((field) => safeText(field, 240)), 240);
}

export function classifyIpfsPayloadForReplication({ keyvalues = {}, name = "", source = "" } = {}) {
  const values = safeObject(keyvalues);
  const schema = safeText(values.schema, 160);
  const type = safeText(values.type, 160);
  const contentKind = safeText(values.content_kind, 160).toUpperCase();
  const safeName = safeText(name, 240).toLowerCase();

  if (type === "profile_nft_image") return "profile_nft_image";
  if (type === "profile_nft_metadata") return "profile_nft_metadata";
  if (type === "profile_nft_thumbnail") return "profile_nft_thumbnail";
  if (safeName.includes("profile_nft_metadata")) return "profile_nft_metadata";
  if (safeName.includes("profile_nft")) return "profile_nft_image";

  if (schema === "pf.daily_airdrop.v1") return "daily_airdrop";
  if (schema === "pf.reward.v1") return "task_reward";
  if (schema === "pf.task.offer.v1") return "task_offer";
  if (schema === "pf.task.submission.v1") return "task_submission";
  if (schema === "pf.task.verification_response.v1") return "task_verification_response";
  if (schema === "pf.task.request.v1" || schema === "pf.task.request_bundle.v1") return "task_request";
  if (schema === "pf.context.v1" || schema.startsWith("pf.context.")) return "context";
  if (schema === "pf.task.update.v1") {
    if (safeText(values.task_action, 80)) return "task_action";
    if (contentKind === "REWARD") return "task_reward";
    return "task_update";
  }
  if (contentKind === "REWARD") return "task_reward";
  if (contentKind === "TASK_SUBMISSION") return "task_submission";
  if (contentKind === "TASK_UPDATE") return "task_update";
  if (contentKind === "TASK") return "task_request";
  if (safeText(source, 120) === "pinata_pin_by_hash") return "exact_cid_repin";
  return "unknown";
}

async function enqueueReplicationAfterPin({
  cid,
  keyvalues = {},
  name = "",
  source = "",
  exactCidRequired = true,
  env = process.env,
  metadata = {},
} = {}) {
  if (env.TASKNODE_IPFS_REPLICATION_ENQUEUE_DISABLED === "true") {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  try {
    const payloadClass = classifyIpfsPayloadForReplication({ keyvalues, name, source });
    return await enqueueIpfsReplicationJob({
      cid,
      payloadClass,
      source,
      sourceRef: replicationSourceRef(keyvalues) || safeText(name, 240),
      exactCidRequired,
      metadata: {
        name: safeText(name, 240),
        keyvalues: safeObject(keyvalues),
        ...safeObject(metadata),
      },
    });
  } catch (error) {
    console.warn("ipfs_replication_enqueue_failed", {
      cid,
      source,
      error: error?.message || String(error),
    });
    return { ok: false, error: error?.message || String(error) };
  }
}

export function contextIpfsPinStatus(env = process.env) {
  const headers = pinataHeaders(env);
  return {
    configured: Boolean(headers),
    provider: headers ? "pinata" : null,
    status: headers ? "ready" : "missing_config",
  };
}

export async function pinIpfsFile({
  bytes,
  name = "file.bin",
  mimeType = "application/octet-stream",
  keyvalues = {},
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const headers = pinataHeaders(env);
  if (!headers) {
    const error = new Error("pinata_not_configured");
    error.status = 409;
    throw error;
  }

  const buffer = Buffer.from(bytes || []);
  if (!buffer.length) {
    const error = new Error("ipfs_file_empty");
    error.status = 400;
    throw error;
  }
  if (buffer.byteLength > MAX_PIN_FILE_BYTES) {
    const error = new Error("ipfs_file_too_large");
    error.status = 413;
    throw error;
  }

  const formData = new FormData();
  const safeName = String(name || "file").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || "file";
  formData.append("file", new Blob([buffer], { type: mimeType }), safeName);
  formData.append(
    "pinataMetadata",
    JSON.stringify({
      name: safeName,
      keyvalues: keyvalues && typeof keyvalues === "object" ? keyvalues : {},
    })
  );

  const response = await fetchImpl("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers,
    body: formData,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error || result?.message || `pinata_http_${response.status}`);
    error.status = response.status;
    throw error;
  }

  const cid = normalizeContextCid(result?.IpfsHash || result?.cid || "");
  if (!cid) {
    const error = new Error("pinata_missing_cid");
    error.status = 502;
    throw error;
  }

  const firstParty = await pinFirstPartyIpfsFile({
    buffer,
    expectedCid: cid,
    mimeType,
    safeName,
    keyvalues,
    env,
    fetchImpl,
  });

  return {
    ok: true,
    provider: "pinata",
    cid,
    sha256: sha256BytesHex(buffer),
    sizeBytes: buffer.byteLength,
    firstParty,
    replication: await enqueueReplicationAfterPin({
      cid,
      keyvalues,
      name: safeName,
      source: "pinata_file",
      exactCidRequired: true,
      env,
      metadata: {
        mimeType,
        sizeBytes: buffer.byteLength,
      },
    }),
    response: result,
  };
}

export async function pinIpfsCidByHash({
  cid,
  name = "",
  keyvalues = {},
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const headers = pinataHeaders(env);
  if (!headers) {
    const error = new Error("pinata_not_configured");
    error.status = 409;
    throw error;
  }

  const normalizedCid = normalizeContextCid(cid);
  if (!isValidContextCid(normalizedCid)) {
    const error = new Error("ipfs_cid_invalid");
    error.status = 400;
    throw error;
  }

  const metadata = {
    name: String(name || normalizedCid).replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || normalizedCid,
  };
  const normalizedKeyvalues = {};
  if (keyvalues && typeof keyvalues === "object" && !Array.isArray(keyvalues)) {
    for (const [key, value] of Object.entries(keyvalues)) {
      if (!key || value === null || value === undefined) continue;
      const text = String(value).slice(0, 500);
      if (text) normalizedKeyvalues[String(key).slice(0, 120)] = text;
    }
  }
  if (Object.keys(normalizedKeyvalues).length) metadata.keyvalues = normalizedKeyvalues;

  const response = await fetchImpl("https://api.pinata.cloud/pinning/pinByHash", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hashToPin: normalizedCid,
      pinataMetadata: metadata,
    }),
  });
  const text = await response.text();
  let result = {};
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(result?.error || result?.message || `pinata_pin_by_hash_http_${response.status}`);
    error.status = response.status;
    error.body = result || text;
    throw error;
  }

  return {
    ok: true,
    provider: "pinata",
    cid: normalizedCid,
    replication: await enqueueReplicationAfterPin({
      cid: normalizedCid,
      keyvalues,
      name: metadata.name,
      source: "pinata_pin_by_hash",
      exactCidRequired: true,
      env,
      metadata: { pinataMetadata: metadata },
    }),
    response: result,
  };
}

export async function pinContextIpfsJson({
  payload,
  name = "context.json",
  keyvalues = {},
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const headers = pinataHeaders(env);
  if (!headers) {
    const error = new Error("pinata_not_configured");
    error.status = 409;
    throw error;
  }

  const body = canonicalJson(payload || {});
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > MAX_PIN_JSON_BYTES) {
    const error = new Error("context_ipfs_payload_too_large");
    error.status = 413;
    throw error;
  }

  const formData = new FormData();
  const safeName = String(name || "context").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || "context";
  formData.append("file", new Blob([body], { type: "application/json" }), `${safeName}.json`);
  formData.append(
    "pinataMetadata",
    JSON.stringify({
      name: safeName,
      keyvalues: keyvalues && typeof keyvalues === "object" ? keyvalues : {},
    })
  );

  const response = await fetchImpl("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers,
    body: formData,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error || result?.message || `pinata_http_${response.status}`);
    error.status = response.status;
    throw error;
  }

  const cid = normalizeContextCid(result?.IpfsHash || result?.cid || "");
  if (!cid) {
    const error = new Error("pinata_missing_cid");
    error.status = 502;
    throw error;
  }

  return {
    ok: true,
    provider: "pinata",
    cid,
    sha256: sha256Hex(body),
    sizeBytes: byteLength,
    replication: await enqueueReplicationAfterPin({
      cid,
      keyvalues,
      name: safeName,
      source: "pinata_json",
      exactCidRequired: true,
      env,
      metadata: {
        sizeBytes: byteLength,
        sha256: sha256Hex(body),
      },
    }),
    response: result,
  };
}
