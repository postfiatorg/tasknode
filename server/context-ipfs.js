const DEFAULT_GATEWAYS = [
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
];

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{20,}|bafk[a-z2-7]{20,}|[a-zA-Z0-9]{32,})$/;
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_IPFS_JSON_BYTES = 1_048_576;

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

function configuredGateways() {
  const configured = [
    process.env.TASKNODE_IPFS_GATEWAY,
    process.env.IPFS_GATEWAY_URL,
    process.env.TASKNODE_IPFS_GATEWAYS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...configured, ...DEFAULT_GATEWAYS]
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

export async function fetchContextIpfsJson({ cid, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalizedCid = normalizeContextCid(cid);
  if (!isValidContextCid(normalizedCid)) {
    return {
      ok: false,
      status: 400,
      error: "context_cid_invalid",
      message: "CID is not valid.",
    };
  }

  let lastError = "";
  for (const gateway of configuredGateways()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const url = `${gateway.replace(/\/$/, "")}/${encodeURIComponent(normalizedCid)}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        lastError = `HTTP_${response.status}`;
        continue;
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
      clearTimeout(timeout);
      lastError = error?.name === "AbortError" ? "timeout" : error?.message || String(error);
    }
  }

  return {
    ok: false,
    status: 502,
    error: "context_ipfs_fetch_failed",
    message: "Context CID could not be fetched.",
    detail: lastError || "gateway_unavailable",
  };
}
