import { createHash } from "node:crypto";

const defaultEmbeddingModel = "deterministic-bag-of-words-v1";
const defaultEmbeddingDimensions = 1536;
const deterministicEmbeddingModel = "deterministic-bag-of-words-v1";

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

export async function embedTexts(texts = [], options = {}) {
  const source = Array.isArray(texts) ? texts.map((text) => String(text || "")) : [String(texts || "")];
  const dimensions = options.dimensions || jobsEmbeddingDimensions();
  const provider = normalizedProvider(options.provider);

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
