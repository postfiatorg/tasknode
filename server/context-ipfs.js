import { createHash } from "node:crypto";

const DEFAULT_GATEWAYS = [
  "https://pft-ipfs-testnet-clean.fly.dev/ipfs/",
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

  return {
    ok: true,
    provider: "pinata",
    cid,
    sha256: sha256BytesHex(buffer),
    sizeBytes: buffer.byteLength,
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
    response: result,
  };
}
