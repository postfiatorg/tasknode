import { textTokens, isAsciiDigit, isAsciiLetter } from "./inference-text.js";
import { createHash } from "node:crypto";
import { providerApiKey, providerBaseUrl } from "./inference-policy.js";

const defaultEmbeddingModel = "deterministic-bag-of-words-v1";
const defaultEmbeddingDimensions = 1536;
const deterministicEmbeddingModel = "deterministic-bag-of-words-v1";
const semanticEmbeddingModel = "text-embedding-3-small";

function normalizedProvider(provider = "") {
  return String(provider || process.env.TASKNODE_JOBS_EMBEDDING_PROVIDER || "deterministic").trim().toLowerCase();
}

export function jobsEmbeddingModel() {
  return process.env.TASKNODE_JOBS_EMBEDDING_MODEL || defaultEmbeddingModel;
}

export function jobsEmbeddingDimensions() {
  const dimensions = Number(process.env.TASKNODE_JOBS_EMBEDDING_DIMENSIONS || defaultEmbeddingDimensions);
  return dimensions === defaultEmbeddingDimensions ? defaultEmbeddingDimensions : defaultEmbeddingDimensions;
}

export function jobsEmbeddingProvider(provider = "") {
  return normalizedProvider(provider);
}

export function jobsEffectiveEmbeddingModel({ provider = "", model = "" } = {}) {
  return normalizedProvider(provider) === "deterministic"
    ? deterministicEmbeddingModel
    : model || jobsEmbeddingModel();
}

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function deterministicEmbedding(text = "", dimensions = defaultEmbeddingDimensions) {
  const vector = new Array(dimensions).fill(0);
  const tokens = textTokens(String(text || "").toLowerCase(), (char) => isAsciiLetter(char) || isAsciiDigit(char) || char === "'" || char === "-")
    .map(({ value }) => { let token = value; while (token && !isAsciiLetter(token[0]) && !isAsciiDigit(token[0])) token = token.slice(1); return token; })
    .filter((token) => token.length >= 2);

  for (const token of tokens) {
    const digest = tokenHash(token);
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}

// Model names are stored without a vendor prefix ("text-embedding-3-small");
// the gateway wants one.
function gatewayModelId(model = "") {
  const name = String(model || "").trim() || semanticEmbeddingModel;
  return name.includes("/") ? name : `openai/${name}`;
}

function storedModelName(model = "") {
  const name = String(model || "").trim() || semanticEmbeddingModel;
  return name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
}

// Provider and model used to embed a chat message for Jobs retrieval. Kept
// apart from the ingest provider so the stored corpus is never re-embedded
// just because retrieval reads the semantic rows.
export function jobsRetrievalEmbeddingProvider() {
  return String(process.env.TASKNODE_JOBS_RETRIEVAL_EMBEDDING_PROVIDER || "deterministic").trim().toLowerCase();
}

export function jobsRetrievalEmbeddingModel() {
  return storedModelName(process.env.TASKNODE_JOBS_RETRIEVAL_EMBEDDING_MODEL || semanticEmbeddingModel);
}

async function gatewayEmbeddings(source, { model = "", dimensions, batchSize = 48, timeoutMs = 8000 } = {}) {
  const apiKey = providerApiKey("vercel");
  if (!apiKey) throw Object.assign(new Error("embedding_gateway_not_configured"), { status: 503 });
  const size = Math.min(Math.max(Number(batchSize) || 48, 1), 96);
  const embeddings = [];
  let totalTokens = 0;
  for (let start = 0; start < source.length; start += size) {
    const response = await fetch(`${providerBaseUrl("vercel")}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: gatewayModelId(model), input: source.slice(start, start + size) }),
      signal: AbortSignal.timeout(Math.min(Math.max(Number(timeoutMs) || 8000, 250), 30000)),
    });
    if (!response.ok) throw Object.assign(new Error(`embedding_gateway_failed:${response.status}`), { status: 502 });
    const body = await response.json();
    const rows = Array.isArray(body?.data) ? [...body.data].sort((a, b) => Number(a.index || 0) - Number(b.index || 0)) : [];
    for (const row of rows) {
      if (!Array.isArray(row?.embedding) || row.embedding.length !== dimensions) {
        throw Object.assign(new Error("embedding_gateway_dimension_mismatch"), { status: 502 });
      }
      embeddings.push(row.embedding);
    }
    totalTokens += Number(body?.usage?.total_tokens || 0);
  }
  if (embeddings.length !== source.length) throw Object.assign(new Error("embedding_gateway_count_mismatch"), { status: 502 });
  return { provider: "gateway", model: storedModelName(model), dimensions, embeddings, usage: { totalTokens } };
}

export async function embedTexts(texts = [], options = {}) {
  const source = Array.isArray(texts) ? texts.map((text) => String(text || "")) : [String(texts || "")];
  const dimensions = options.dimensions || jobsEmbeddingDimensions();
  const provider = normalizedProvider(options.provider);

  if (provider === "gateway") return gatewayEmbeddings(source, { ...options, dimensions });
  if (provider !== "deterministic") {
    throw Object.assign(new Error(`embedding_provider_unsupported:${provider}`), { status: 409 });
  }
  return {
    provider,
    model: deterministicEmbeddingModel,
    dimensions,
    embeddings: source.map((text) => deterministicEmbedding(text, dimensions)),
    usage: { totalTokens: 0 },
  };
}
