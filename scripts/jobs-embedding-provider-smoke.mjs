import assert from "node:assert/strict";

process.env.VERCEL_AI_GATEWAY_API_KEY = "smoke-key";
delete process.env.VERCEL_AI_GATEWAY_BASE_URL;
delete process.env.TASKNODE_JOBS_RETRIEVAL_EMBEDDING_PROVIDER;
delete process.env.TASKNODE_JOBS_RETRIEVAL_EMBEDDING_MODEL;

const {
  embedTexts,
  jobsRetrievalEmbeddingModel,
  jobsRetrievalEmbeddingProvider,
} = await import("../server/embedding-provider.js");

// Retrieval stays on the built-in keyword embedding unless a deployment opts in.
assert.equal(jobsRetrievalEmbeddingProvider(), "deterministic");
assert.equal(jobsRetrievalEmbeddingModel(), "text-embedding-3-small");
process.env.TASKNODE_JOBS_RETRIEVAL_EMBEDDING_PROVIDER = "Gateway";
assert.equal(jobsRetrievalEmbeddingProvider(), "gateway");

const deterministic = await embedTexts(["focus on one product"], { provider: "deterministic" });
assert.equal(deterministic.model, "deterministic-bag-of-words-v1");
assert.equal(deterministic.embeddings[0].length, 1536);

const realFetch = globalThis.fetch;
const calls = [];
const vector = (seed) => Array.from({ length: 1536 }, (_, index) => (index === seed ? 1 : 0));
try {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), authorization: init.headers.authorization, body });
    return new Response(JSON.stringify({
      // Returned out of order on purpose: results must follow the input order.
      data: body.input.map((_, index) => ({ index, embedding: vector(index) })).reverse(),
      usage: { total_tokens: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await embedTexts(["first", "second"], { provider: "gateway", model: "text-embedding-3-small" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ai-gateway.vercel.sh/v1/embeddings");
  assert.equal(calls[0].authorization, "Bearer smoke-key");
  assert.equal(calls[0].body.model, "openai/text-embedding-3-small");
  assert.deepEqual(calls[0].body.input, ["first", "second"]);
  // The stored model name carries no vendor prefix, so it matches the corpus rows.
  assert.equal(result.model, "text-embedding-3-small");
  assert.equal(result.provider, "gateway");
  assert.equal(result.embeddings[0][0], 1);
  assert.equal(result.embeddings[1][1], 1);
  assert.equal(result.usage.totalTokens, 7);

  globalThis.fetch = async () => new Response("{}", { status: 500 });
  await assert.rejects(embedTexts(["x"], { provider: "gateway" }), (error) => error.message === "embedding_gateway_failed:500");

  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 });
  await assert.rejects(embedTexts(["x"], { provider: "gateway" }), (error) => error.message === "embedding_gateway_dimension_mismatch");

  delete process.env.VERCEL_AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  await assert.rejects(embedTexts(["x"], { provider: "gateway" }), (error) => error.message === "embedding_gateway_not_configured");
} finally {
  globalThis.fetch = realFetch;
}

await assert.rejects(embedTexts(["x"], { provider: "openai" }), (error) => error.message === "embedding_provider_unsupported:openai");

console.log("jobs embedding provider smoke ok");
