import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "sk-hive-project-product-doc-smoke";

const { fetchHiveProjectProductDoc } = await import("../server/hive-project-product-doc-worker.js");

async function fakeFetch(url, options = {}) {
  const body = JSON.parse(options.body || "{}");
  assert.equal(url.endsWith("/chat/completions"), true);
  assert.equal(body.model, "deepseek/deepseek-v4-pro");
  assert.equal(body.provider?.zdr, true);
  assert.equal(body.provider?.data_collection, "deny");
  assert.ok(body.messages?.[0]?.content.includes("You write the current project document"));
  assert.ok(body.messages?.[1]?.content.includes("pft_distribution_v3"));
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        model: body.model,
        choices: [{
          message: {
            content: JSON.stringify({
              title: "PFT distribution v3 status",
              summary: "The project benefits the network by making reward distribution easier to audit and operate.",
              project_status: "The project is active and needs clearer project-linked task evidence before live allocation can expand.",
              key_points: ["Reward routing is the central execution surface.", "Project task refs are still sparse."],
              blocked_or_unclear: ["Contributor ownership is not yet visible in the source packet."],
              next_actions: ["Refresh project-linked task refs.", "Ask the Board Manager to create information-gathering network tasks."],
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0 },
      });
    },
  };
}

const result = await fetchHiveProjectProductDoc({
  schema: "pf.hive.project_product_doc.source.v1",
  project: {
    id: "pft_distribution_v3",
    title: "PFT distribution v3",
    about: "Reward routing infrastructure rebuild.",
    phaseLabel: "3 of 5",
  },
}, { fetchImpl: fakeFetch });

assert.equal(result.provider, "openrouter");
assert.equal(result.model, "deepseek/deepseek-v4-pro");
assert.equal(result.promptVersion, "hive_project_product_doc_v1");
assert.equal(result.output.title, "PFT distribution v3 status");
assert.equal(result.output.key_points.length, 2);
assert.equal(result.usage.totalTokens, 30);

console.log(JSON.stringify({
  ok: true,
  promptVersion: result.promptVersion,
  model: result.model,
  title: result.output.title,
}, null, 2));
