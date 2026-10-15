import assert from "node:assert/strict";
import { buildDocsAssistantRequest } from "../server/docs-odv.js";
import { readValidatedJson } from "../server/request-validation.js";

// Source-informed contract: valid long documents must not cut the serialized
// packet before active chat. Fixtures use the real 128000-byte route reader.
const results = [];
const caps = { odv: 70_000, coach: 100_000 };
const history = (count = 12, length = 2000) => Array.from({ length: count }, (_, index) => ({
  author: `Fixture ${index}`,
  text: `CHAT_${String(index).padStart(2, "0")}_` + "h".repeat(length - 8),
}));
function packetFrom(request) {
  const text = request.messages[1].content;
  const start = text.indexOf('{"requester":');
  assert.ok(start >= 0, "dynamic JSON packet must be present");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      const raw = text.slice(start, index + 1);
      return { raw, packet: JSON.parse(raw) };
    }
  }
  assert.fail("dynamic JSON packet was cut before its closing brace");
}
async function build(persona, overrides = {}, userContext) {
  const body = {
    persona,
    prompt: `@${persona === "odv" ? "ODV" : "coach"} continue our active conversation`,
    documentTitle: "Budget fixture",
    documentContent: "document",
    recentMessages: history(),
    includeFullContext: false,
    ...overrides,
  };
  const bytes = Buffer.from(JSON.stringify(body));
  assert.ok(bytes.byteLength < 128_000, "fixture must fit the actual HTTP admission cap");
  const req = { async *[Symbol.asyncIterator]() { yield bytes; } };
  const admitted = await readValidatedJson(req, 128_000);
  const request = buildDocsAssistantRequest({ ...admitted, userContext });
  const extracted = packetFrom(request);
  assert.ok(extracted.raw.length <= caps[persona], "serialized packet must respect the unchanged persona cap");
  assert.equal(request.max_tokens, 32768);
  assert.equal(request.reasoning.effort, "medium");
  return { ...extracted, body };
}
function checkHistory(packet, expected) {
  assert.equal(packet.recentDocumentChat.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(packet.recentDocumentChat[index].text === expected[index].text.slice(0, 2000), "all active chat text must survive in canonical order");
    assert.ok(packet.recentDocumentChat[index].author === expected[index].author.slice(0, 120), "author bound/order must survive");
  }
}
async function check(id, run) {
  if (process.argv[2] && !id.includes(process.argv[2])) return;
  try {
    await run();
    results.push({ id, ok: true });
  } catch (error) {
    results.push({ id, ok: false, error: String(error.message).slice(0, 180) });
  }
}
for (const persona of ["odv", "coach"]) {
  await check(`${persona}:small-control`, async () => {
    const { packet, body } = await build(persona, { recentMessages: history(2, 30) });
    assert.equal(packet.document.content, "document");
    assert.equal(packet.document.title, body.documentTitle);
    assert.equal(packet.request, body.prompt);
    checkHistory(packet, body.recentMessages);
  });
  await check(`${persona}:80000-document-and-12-full-messages`, async () => {
    const { packet, body } = await build(persona, { documentContent: "D".repeat(80_000) });
    checkHistory(packet, body.recentMessages);
    assert.ok(packet.document.content.length > 1000, "usable document excerpt must remain");
  });
  await check(`${persona}:escaped-document-serialization`, async () => {
    const { packet, body } = await build(persona, { documentContent: '"'.repeat(40_000) });
    checkHistory(packet, body.recentMessages);
    assert.ok(packet.document.content.length > 1000);
  });
  await check(`${persona}:last12-and-field-bounds`, async () => {
    const messages = history(13, 2001).map(message => ({ ...message, author: "a".repeat(121) }));
    const { packet } = await build(persona, { recentMessages: messages });
    checkHistory(packet, messages.slice(-12));
    assert.ok(!packet.recentDocumentChat.some(message => message.text.startsWith("CHAT_00_")));
  });
  await check(`${persona}:request-and-metadata-priority`, async () => {
    const prompt = `@${persona === "odv" ? "ODV" : "coach"} ` + "q".repeat(4000);
    const { packet } = await build(persona, { prompt, documentContent: "D".repeat(80_000), documentTitle: "T".repeat(181) });
    assert.ok(packet.request === prompt.slice(0, 4000));
    assert.ok(packet.document.title === "T".repeat(180));
    checkHistory(packet, history());
  });
  await check(`${persona}:full-context-off-never-reads-personal-data`, async () => {
    const userContext = new Proxy({}, { get() { throw new Error("personal context was accessed while disabled"); } });
    const { packet } = await build(persona, { documentContent: "D".repeat(80_000) }, userContext);
    assert.equal(packet.taskNode.contextDocument, "");
    assert.equal(packet.taskNode.memory, "null");
    assert.equal(packet.taskNode.recentTasks, "null");
    checkHistory(packet, history());
  });
  await check(`${persona}:full-context-reference-budget`, async () => {
    const { packet } = await build(persona, { documentContent: "D".repeat(80_000), includeFullContext: true }, {
      contextDocument: { body: "private-fixture-context".repeat(2000) },
      memoryContext: { text: '"'.repeat(20_000) },
      taskContext: { text: "t".repeat(20_000) },
    });
    checkHistory(packet, history());
    assert.ok(packet.document.content.length > 1000);
    assert.ok(packet.taskNode.contextDocument.length <= 20_000);
    assert.ok(packet.taskNode.memory.length <= 18_000);
    assert.ok(packet.taskNode.recentTasks.length <= 18_000);
  });
  await check(`${persona}:expanded-escaped-history-budget`, async () => {
    const messages = history(12, 1400).map(message => ({ ...message, text: message.text.slice(0, 8) + "\u0001".repeat(1392) }));
    const { packet } = await build(persona, { prompt: `@${persona} ` + "\u0001".repeat(1000), documentContent: "D".repeat(2000), recentMessages: messages });
    assert.equal(packet.recentDocumentChat.length, 12);
    for (let index = 0; index < 12; index += 1) {
      assert.ok(packet.recentDocumentChat[index].text.startsWith(messages[index].text.slice(0, 8)), "each active message must retain a usable ordered excerpt");
      assert.ok(messages[index].text.startsWith(packet.recentDocumentChat[index].text));
      assert.equal(packet.recentDocumentChat[index].author, messages[index].author);
    }
    assert.ok(packet.document.content.length >= 1024, "retain a usable document excerpt even under heavy chat escaping");
  });
  await check(`${persona}:expanded-unicode-control`, async () => {
    const { packet } = await build(persona, { documentContent: "漢".repeat(24_000) });
    assert.ok(packet.document.content === "漢".repeat(24_000));
    checkHistory(packet, history());
  });
  for (const offset of [-1, 0, 1]) {
    await check(`${persona}:serialized-budget-edge-${offset}`, async () => {
      const messages = history(12, 1800);
      const control = await build(persona, { documentContent: "D", recentMessages: messages });
      const length = caps[persona] - (control.raw.length - 1) + offset;
      assert.ok(length > 0 && length <= 80_000);
      const { packet, raw } = await build(persona, { documentContent: "D".repeat(length), recentMessages: messages });
      checkHistory(packet, messages);
      if (offset <= 0) {
        assert.equal(packet.document.content.length, length, "already-fitting references must remain intact");
        assert.equal(raw.length, caps[persona] + offset);
      }
    });
  }
}
await check("input-errors-unchanged", () => {
  assert.throws(() => buildDocsAssistantRequest({ prompt: "hello", documentContent: "doc" }), { code: "docs_persona_mention_required" });
  assert.throws(() => buildDocsAssistantRequest({ persona: "coach", prompt: "@ODV hi", documentContent: "doc" }), { code: "docs_persona_mismatch" });
  assert.throws(() => buildDocsAssistantRequest({ prompt: "@ODV hi", documentContent: "" }), { code: "docs_assistant_document_content_required" });
});
console.log(JSON.stringify({ total: results.length, passed: results.filter(result => result.ok).length, results }, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;
