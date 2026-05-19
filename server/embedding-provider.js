import { createHash } from "node:crypto";

const defaultEmbeddingModel = "text-embedding-3-small";
const defaultEmbeddingDimensions = 1536;
const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
const maxBatchSize = 96;
const deterministicEmbeddingModel = "deterministic-bag-of-words-v1";

function normalizedProvider(provider = "") {
  return String(provider || process.env.TASKNODE_JOBS_EMBEDDING_PROVIDER || "openai").trim().toLowerCase();
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
  const tokens = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9'-]{1,}/g) || [];

  for (const token of tokens) {
    const digest = tokenHash(token);
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}

async function openAiEmbeddings(texts, { model, dimensions, timeoutMs = 30000 } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("openai_api_key_required_for_embeddings");
    error.status = 409;
    throw error;
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || defaultOpenAiBaseUrl).replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: texts,
        dimensions,
        encoding_format: "float",
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error("openai_embedding_request_failed");
      error.status = response.status;
      error.providerMessage = body?.error?.message || `OpenAI returned HTTP ${response.status}`;
      throw error;
    }

    const data = Array.isArray(body?.data) ? body.data : [];
    if (data.length !== texts.length) {
      throw new Error("openai_embedding_count_mismatch");
    }
    return data
      .slice()
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
      .map((entry) => entry.embedding);
  } finally {
    clearTimeout(timeout);
  }
}

export async function embedTexts(texts = [], options = {}) {
  const source = Array.isArray(texts) ? texts.map((text) => String(text || "")) : [String(texts || "")];
  const model = options.model || jobsEmbeddingModel();
  const dimensions = options.dimensions || jobsEmbeddingDimensions();
  const provider = normalizedProvider(options.provider);
  const batchSize = Math.min(Math.max(Number(options.batchSize || 48), 1), maxBatchSize);
  const timeoutMs = Math.max(Number(options.timeoutMs || 30000), 1000);
  const embeddings = [];

  if (provider === "deterministic") {
    return {
      provider,
      model: deterministicEmbeddingModel,
      dimensions,
      embeddings: source.map((text) => deterministicEmbedding(text, dimensions)),
      usage: { totalTokens: 0 },
    };
  }

  for (let index = 0; index < source.length; index += batchSize) {
    const batch = source.slice(index, index + batchSize);
    embeddings.push(...(await openAiEmbeddings(batch, { model, dimensions, timeoutMs })));
  }

  return {
    provider: "openai",
    model,
    dimensions,
    embeddings,
    usage: { totalTokens: 0 },
  };
}
