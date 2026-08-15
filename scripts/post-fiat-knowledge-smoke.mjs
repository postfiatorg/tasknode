import assert from "node:assert/strict";

const { formatPostFiatKnowledgeContext, postFiatKnowledgeMetadata } = await import("../server/post-fiat-knowledge.js");
const { taskNodeInstructions } = await import("../server/chat-memory-context.js");

const metadata = postFiatKnowledgeMetadata();
assert.equal(metadata.schemaVersion, 1);
assert.equal(metadata.blogArticleCount, 25);
assert.ok(metadata.chunkCount > 150);
assert.match(metadata.whitepaper.commit, /^[a-f0-9]{40}$/);
assert.equal(metadata.whitepaper.sourcePath, "docs/whitepaper.md");

const catalog = formatPostFiatKnowledgeContext({ message: "What is Post Fiat?" });
for (const title of [
  "Cobalt on the Devnet: Implementing the Road Not Taken",
  "Introducing PF Terminal",
  "The NAVCoin Proposal",
  "A Controlled Private FX Swap: pfUSDC–pNOK Atomic Settlement",
  "Replayable Oracles for Prediction Markets",
  "Viability of SGLang Replay: Cross-Hardware",
]) {
  assert.match(catalog, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.match(catalog, /Complete blog archive catalog \(25 articles\)/);
assert.match(catalog, /unpublished draft\/proposal/);
assert.match(catalog, /controlled pre-testnet\s+conformance draft/i);

const cobalt = formatPostFiatKnowledgeContext({ message: "How do Cobalt registry transition packets preserve safety?" });
assert.match(cobalt, /6\.7 Transition safety/i);
assert.match(cobalt, /old.new matrix/i);
assert.match(cobalt, /Cobalt on the Devnet/i);

const navcoin = formatPostFiatKnowledgeContext({ message: "Is NAVCoin a fixed peg with spot redemption?" });
assert.match(navcoin, /NAVCoin Collateralization Without Spot Redemption/i);
assert.match(navcoin, /The NAVCoin Proposal/i);

const privateFx = formatPostFiatKnowledgeContext({ message: "What happened in the private pfUSDC pNOK swap?" });
assert.match(privateFx, /Twenty pfUSDC and 210 pNOK/i);

const terminal = formatPostFiatKnowledgeContext({ message: "What is PF Terminal and what did its benchmark show?" });
assert.match(terminal, /39\.8% cheaper and 46\.6% faster/i);

const instructions = taskNodeInstructions({
  persona: "post-fiat-qa",
  message: "How does shielded settlement work?",
  contextDocument: { body: "POST_FIAT_CONTEXT_SENTINEL" },
});
assert.match(instructions, /post_fiat_knowledge/);
assert.match(instructions, /Asset-Orchard is the supported private settlement path/i);
assert.match(instructions, /POST_FIAT_CONTEXT_SENTINEL/);
assert.doesNotMatch(instructions, /___[A-Z0-9_]+___/);
assert.doesNotMatch(instructions, /Phase 3A transfers list-content authority/);

console.log("post fiat knowledge smoke ok");
