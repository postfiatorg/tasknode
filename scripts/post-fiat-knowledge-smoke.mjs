import assert from "node:assert/strict";

const { formatPostFiatKnowledgeContext, formatPostFiatKnowledgeBrief, postFiatKnowledgeMetadata } = await import("../server/post-fiat-knowledge.js");
const { taskNodeInstructions } = await import("../server/chat-memory-context.js");

const metadata = postFiatKnowledgeMetadata();
assert.equal(metadata.schemaVersion, 2);
assert.ok(metadata.blogArticleCount >= 31);
assert.ok(metadata.sitePageCount >= 8);
assert.ok(metadata.productDocCount >= 18);
assert.ok(metadata.chunkCount > 150);
assert.match(metadata.whitepaper.commit, /^[a-f0-9]{40}$/);
assert.equal(metadata.whitepaper.sourcePath, "docs/whitepaper.md");

const catalog = formatPostFiatKnowledgeContext({ message: "What is Post Fiat?" });
for (const title of [
  "Cobalt on the Devnet: Implementing the Road Not Taken",
  "Introducing Post Fiat Terminal",
  "The NAVCoin Proposal",
  "A Controlled Private FX Swap: pfUSDC–pNOK Atomic Settlement",
  "Replayable Oracles for Prediction Markets",
  "Viability of SGLang Replay: Cross-Hardware",
]) {
  assert.match(catalog, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.match(catalog, /Complete blog archive catalog \(\d+ articles\)/);
assert.match(catalog, /Task Node product documentation/);
assert.match(catalog, /legacy postfiatd/);
assert.match(catalog, /unpublished draft\/proposal/);

const cobalt = formatPostFiatKnowledgeContext({ message: "How do Cobalt registry transition packets preserve safety?" });
assert.match(cobalt, /Cobalt on the Devnet/i);

const navcoin = formatPostFiatKnowledgeContext({ message: "Is NAVCoin a fixed peg with spot redemption?" });
assert.match(navcoin, /NAVCoin Collateralization Without Spot Redemption/i);
assert.match(navcoin, /The NAVCoin Proposal/i);

const privateFx = formatPostFiatKnowledgeContext({ message: "What happened in the private pfUSDC pNOK swap?" });
assert.match(privateFx, /Twenty pfUSDC and 210 pNOK/i);

const terminal = formatPostFiatKnowledgeContext({ message: "What is PF Terminal and what did its benchmark show?" });
assert.match(terminal, /Introducing Post Fiat Terminal — The Benchmarks/);
assert.doesNotMatch(terminal, /— References \(/);

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

// Product surfaces, validators and premium access are answerable from the same corpus.
const agents = formatPostFiatKnowledgeContext({ message: "How do I connect Claude Code to Task Node?" });
assert.match(agents, /curl -fsSL https:\/\/tasknode\.postfiat\.org\/install \| sh/);
const premium = formatPostFiatKnowledgeContext({ message: "How do I get access to GoodAlexander financial models?" });
assert.match(premium, /Task Node: Validator Rewards & Research/);
assert.match(premium, /Finance Hub/);
const setup = formatPostFiatKnowledgeContext({ message: "How do I set up a validator?" });
assert.match(setup, /Post Fiat Validator Setup/);
const legacy = formatPostFiatKnowledgeContext({ message: "Is postfiatd still supported?" });
assert.match(legacy, /being deprecated in favour of Post Fiat L1 v2/);
const evidence = formatPostFiatKnowledgeContext({ message: "How do I submit evidence for a task?" });
assert.match(evidence, /Task Node: Tasks/);

// Help mode carries the same knowledge in a smaller packet plus the chain, premium-access and trading-IP rules.
const { helpModeInstructions } = await import("../server/chat-help-mode.js");
const help = helpModeInstructions({ message: "What is a NAVCoin?", deliveryContext: { accountStatus: "signed_out" } });
assert.match(help, /post_fiat_knowledge/);
assert.match(help, /The NAVCoin Proposal/);
assert.match(help, /never disclose the contents, assumptions, estimates, price targets/i);
assert.match(help, /on the way to being deprecated in favour of L1 v2/);
assert.match(help, /Finance Hub, which is for accounts with a linked validator/);
assert.doesNotMatch(help, /\{\{[A-Z_]+\}\}/);
assert.ok(formatPostFiatKnowledgeBrief({ message: "What is Post Fiat?" }).length < 40_000);
assert.match(instructions, /Never disclose trading intellectual property/);
assert.match(instructions, /Finance Hub is for accounts with a linked validator/);

console.log("post fiat knowledge smoke ok");
