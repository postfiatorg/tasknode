import assert from "node:assert/strict";
import { buildDocsAssistantRequest, generateDocsAssistantResponse } from "../server/docs-odv.js";

const fixtures = [
  ["  Plain context\n- keep <3 & a < b\n", "Plain context\n- keep <3 & a < b"],
  ["<h2>Goal</h2><p>Build <strong>carefully</strong>.</p><ul><li>One</li><li>Two</li></ul>", "Goal\nBuild carefully.\n- One\n- Two"],
  ["<p>R&amp;D &lt;5 &gt;2 Café 🚀</p>", "R&D <5 >2 Café 🚀"],
  ["<p></p><div><br></div>", ""],
  ["<p>Visible</p><script>hidden-script</script><style>hidden-style</style>", "Visible"],
  ["<p>A\u0000B</p>", "AB"],
  [`<p>${"<strong>x</strong>".repeat(1500)}TAIL_INSIDE_READABLE_CAP</p>`, `${"x".repeat(1500)}TAIL_INSIDE_READABLE_CAP`],
];
for (const count of [19_999, 20_000, 20_001]) {
  fixtures.push([`<p>${"&amp;".repeat(count)}</p>`, "&".repeat(Math.min(count, 20_000))]);
}
const history = Array.from({ length: 15 }, (_, index) => ({ author: "Fixture", text: `message-${String(index).padStart(2, "0")}` }));
const input = (persona, body) => ({
  persona,
  prompt: persona === "odv" ? "@ODV summarize" : "@coach summarize",
  documentTitle: "Active document",
  documentContent: "active-document-only",
  recentMessages: history,
  identity: { displayName: "Fixture" },
  includeFullContext: true,
  userContext: {
    contextDocument: { body },
    memoryContext: { text: "memory-only" },
    taskContext: { text: "task-only" },
  },
});

for (const persona of ["odv", "coach"]) {
  for (const [body, expected] of fixtures) {
    const request = buildDocsAssistantRequest(input(persona, body));
    assert.ok(request.messages[1].content.includes(`"contextDocument":${JSON.stringify(expected)}`), `${persona}: saved context must be readable before clipping`);
  }
  const request = buildDocsAssistantRequest(input(persona, "<p>Visible</p>"));
  const content = request.messages[1].content;
  assert.ok(content.includes(`"memory":${JSON.stringify(JSON.stringify({ text: "memory-only" }))}`));
  assert.ok(content.includes(`"recentTasks":${JSON.stringify(JSON.stringify({ text: "task-only" }))}`));
  assert.ok(content.includes('"recentDocumentChat":' + JSON.stringify(history.slice(-12))));
  assert.equal(request.persona, persona);

  const off = input(persona, "must-not-read");
  off.includeFullContext = false;
  off.userContext = { get contextDocument() { throw new Error("Full context off must not read saved context"); } };
  const offContent = buildDocsAssistantRequest(off).messages[1].content;
  assert.ok(offContent.includes('"taskNode":{"contextDocument":"","memory":"null","recentTasks":"null"}'));
  assert.ok(offContent.includes('"recentDocumentChat":' + JSON.stringify(history.slice(-12))));
  assert.ok(offContent.includes('"document":{"title":"Active document","content":"active-document-only"}'));
}

let loads = 0;
let infers = 0;
const denied = { ok: false, status: 403, error: "docs_access_required" };
const args = { ...input("coach", ""), accountId: "fixture-account", documentId: "fixture-document", channelHash: "fixture-channel" };
assert.equal(await generateDocsAssistantResponse(args, {
  authorize: async () => denied,
  loadUserContext: async () => { loads += 1; return {}; },
  infer: async () => { infers += 1; return { text: "must-not-run" }; },
}), denied);
assert.equal(loads, 0);
assert.equal(infers, 0);

let providerBody;
const result = await generateDocsAssistantResponse(args, {
  authorize: async (request) => { assert.equal(request.accountId, "fixture-account"); return { ok: true }; },
  loadUserContext: async (accountId) => {
    assert.equal(accountId, "fixture-account");
    loads += 1;
    return { contextDocument: { body: "<p>Authorized &amp; readable</p>" } };
  },
  infer: async ({ body }) => { providerBody = body; return { text: "synthetic answer" }; },
});
assert.equal(result.ok, true);
assert.equal(loads, 1);
assert.equal(JSON.parse(providerBody.messages[1].content).taskNode.contextDocument, "Authorized & readable");
console.log("Docs readable context: projection-before-cap, both personas, Full-context gating, chat continuity, and injected authorization passed.");
