import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parse } from "espree";
import { previewResearch } from "../server/research-preview.js";
import { defaultChatResearchBudget } from "../shared/chat-research.js";
import { researchMode, researchProgress, newerResearchProgress, researchTables } from "../shared/research-agent.js";
import { researchInline, researchMarkdownToBlocks } from "../src/features/chat/research-markdown.js";
import { callResearchService } from "../server/research-provider.js";
import { chatTitleFromPrompt, agentMessageIdentity } from "../src/features/chat/chat-turns.js";

assert.equal(chatTitleFromPrompt("  Compare\t\n earnings\u00a0 releases  "), "Compare earnings releases");
assert.equal(chatTitleFromPrompt("x".repeat(60)), "x".repeat(48));
assert.equal(chatTitleFromPrompt(" \t"), "New chat");
assert.equal(agentMessageIdentity({ senderType: "machine_agent", agentHandle: "@@orc" }).handle, "orc");

const question = "Compare management commentary across the past six quarters.";
const fixture = { route_token: "test-route", mode: "agent", reason: "Compare several periods and sources.",
  default_max_cost_usd: 3, min_cost_usd: .05, max_cost_usd: 10, preview_cost_usd: 0,
  expires_at: new Date(Date.now() + 900000).toISOString(), question_sha256: createHash("sha256").update(question).digest("hex") };
let calls = 0;
assert.deepEqual(await previewResearch({ accountId: "account", question }, async request => {
  calls++; assert.equal(request.path, "/v1/research/preview"); assert.equal(request.accountId, "account");
  assert.deepEqual(request.payload, { question, mode: "auto" }); return fixture;
}), fixture);
assert.equal(calls, 1);
for (const change of [{ mode: "guess" }, { route_token: "" }, { default_max_cost_usd: 10 }, { max_cost_usd: 11 },
  { preview_cost_usd: .001 }, { question_sha256: "different-question" }, { expires_at: "invalid" },
  { expires_at: new Date(Date.now() - 1).toISOString() }]) {
  await assert.rejects(previewResearch({ accountId: "account", question }, async () => ({ ...fixture, ...change })), error => error.status === 502);
}
await assert.rejects(previewResearch({ accountId: "account", question, mode: "fast" }, async () => fixture));
await assert.rejects(previewResearch({ accountId: "account", question: " ", mode: "auto" }));
assert.equal(researchMode(undefined), "auto"); assert.throws(() => researchMode("keyword"));
for (const [balance, expected] of [[20,3],[3,3],[2.999999,2.999999],[1.234567,1.234567],[.5,.5],[.499999,3]]) {
  assert.equal(defaultChatResearchBudget(balance, "agent"), expected);
}
assert.equal(defaultChatResearchBudget(20, "fast"), 1.5);

const progress = { sequence: 3, stage: "extracting", step: 2, step_limit: 25,
  documents_total: 214, documents_completed: 100, elapsed_seconds: 135.25, cost_usd: .134567,
  updated_at: "2026-10-29T00:00:00Z" };
assert.deepEqual(researchProgress({ ...progress, private_tool_inputs: "must not project" }), progress);
assert.deepEqual(researchProgress(undefined), {});
for (const change of [{ step: 26 }, { documents_completed: 215 }, { sequence: 1.2 }, { elapsed_seconds: -1 },
  { cost_usd: Infinity }, { documents_total: "214" }, { updated_at: "yesterday" }]) {
  assert.throws(() => researchProgress({ ...progress, ...change }));
}
assert.strictEqual(newerResearchProgress(progress, {}), progress);
assert.strictEqual(newerResearchProgress(progress, { ...progress, sequence: 2 }), progress);
assert.strictEqual(newerResearchProgress(progress, { ...progress, sequence: 4, cost_usd: .01 }), progress);
assert.strictEqual(newerResearchProgress(progress, { ...progress, sequence: 4, elapsed_seconds: 1 }), progress);
const later = { ...progress, sequence: 4, elapsed_seconds: 900, documents_completed: 214 };
assert.strictEqual(newerResearchProgress(progress, later), later);

const blocks = researchMarkdownToBlocks("# Results\n\n**Strong** and *emphasis*, `code`.\n\n" +
  "| Quarter | Margin | Source |\n|---|---:|---|\n| 2025 Q1 | 12.5 | [F1](<https://example.test/data>) |\n" +
  "| 2025 Q2 | 14.0 | A\\|B |\n\n```sql\nSELECT revenue, opinc\nFROM fixture;\n```\n\n> A complete quoted sentence.\n\n" +
  "1. First point\n2. Second point\n\n<script>no execution</script>");
assert.deepEqual(blocks.map(block => block.type), ["h2", "p", "table", "code", "quote", "ol", "p"]);
assert.equal(blocks[1].inline[0].bold, "Strong"); assert.ok(blocks[1].inline.some(part => part.italic === "emphasis"));
assert.equal(blocks[2].rows.length, 2); assert.equal(blocks[2].rows[0][2][0].href, "https://example.test/data");
assert.equal(blocks[2].rows[1][2][0].text, "A|B"); assert.equal(blocks[2].alignments[1], "right");
assert.equal(blocks[3].text, "SELECT revenue, opinc\nFROM fixture;"); assert.equal(blocks[6].inline[0].text, "<script>no execution</script>");
assert.ok(researchInline("[bad](javascript:alert(1))").every(part => !part.href));
assert.ok(researchInline("[bad](data:text/html,test)").every(part => !part.href));
assert.equal(researchMarkdownToBlocks("Date | Value\n--- | ---:\n2025 | 10")[0].type, "table");
assert.equal(researchMarkdownToBlocks("| Field | Value |\n|---|---|\n| x | `a|b` |")[0].rows[0][1][0].code, "a|b");
const tables = researchTables([{ name: "FCF yield over time", columns: [{ name: "date", unit: "UTC" }, { name: "yield", unit: "%" }],
  rows: Array.from({ length: 501 }, () => ({ date: "2026-01-01", yield: 4.25, unsafe: "ignored" })), source_ids: ["F1"] }]);
assert.equal(tables[0].rows.length, 500); assert.equal(tables[0].totalRows, 501);
assert.deepEqual(tables[0].rows[0], { date: "2026-01-01", yield: 4.25 });
assert.deepEqual(researchTables([{}, { name: "invalid", columns: [], rows: [] }]), []);

await assert.rejects(callResearchService({ method: "POST", path: "/v1/research", accountId: "account", payload: {},
  env: { GA_RESEARCH_URL: "https://example.test", GA_RESEARCH_HMAC_SECRET: "fixture-only" },
  fetchImpl: async () => new Response(JSON.stringify({ detail: "route_preview_invalid" }), { status: 409 }),
}), error => error.message === "route_preview_invalid" && error.status === 409);

// D88: inspect executable syntax and the entire local import graph, not user text.
// Task Node delegates typed research to GA; it must never gain a Bloomberg client,
// bridge, cache, or SQL source through a helper added beneath that boundary.
function researchDependencies(source, filename) {
  const imports = [];
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } });
  function visit(node) {
    if (!node || typeof node !== "object") return;
    const text = node.type === "Identifier" ? node.name : node.type === "Literal" ? node.value : node.type === "TemplateElement" ? node.value.raw : null;
    if (typeof text === "string") {
      const lower = text.toLowerCase();
      assert.ok(!lower.includes("bloomberg") && !lower.includes("postfiat1:5555"), `forbidden research dependency in ${filename}`);
    }
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type) && node.source) {
      assert.equal(typeof node.source.value, "string", `research imports must be statically auditable: ${filename}`);
      imports.push(node.source.value);
    }
    if (node.type === "CallExpression" && node.callee?.name === "require") {
      assert.equal(typeof node.arguments[0]?.value, "string", `research require must be statically auditable: ${filename}`);
      imports.push(node.arguments[0].value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(ast);
  return imports;
}
for (const forbidden of ['import x from "./bloomberg-client.js";', 'const table = "bloomberg_article_summaries";',
  'const endpoint = process.env.BLOOMBERG_SERVER_URL;', 'const url = "http://postfiat1:5555";',
  'const cache = `/data/bloomberg/cache`;', 'const url = "https://www.bloomberg.com/news";']) {
  assert.throws(() => researchDependencies(forbidden, "mutation fixture"), /forbidden research dependency/);
}
const pending = ["server/deep-research-routes.js", "server/validator-research-routes.js", "server/research-preview.js", "server/research-provider.js"].map(file => resolve(file));
const inspected = new Set();
while (pending.length) {
  const file = pending.pop();
  if (inspected.has(file)) continue;
  inspected.add(file);
  for (const dependency of researchDependencies(await readFile(file, "utf8"), file)) {
    if (dependency.startsWith(".")) pending.push(resolve(dirname(file), dependency));
  }
}
assert.ok(inspected.size > 10, "audit must traverse the research helpers");
console.log(`research dependency guard ok: ${inspected.size} modules; no Bloomberg client, table, bridge, cache or URL`);
console.log("research-agent-smoke ok: typed free preview, mode/caps, monotonic bounded progress, safe no-regex Markdown and time-series tables");
