import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { readValidatedJson } from "../server/request-validation.js";

const source = readFileSync(new URL("../src/features/docs-library/DocsLibraryView.jsx", import.meta.url), "utf8");
const start = source.indexOf("    function onMessage(event) {");
const end = source.indexOf('    window.addEventListener("message", onMessage);', start);
assert.ok(start > 0 && end > start, "Use the actual unchanged-shape bridge callback");
const callback = source.slice(start, end);
const helperUrl = new URL("../src/features/docs-library/docs-assistant-http.js", import.meta.url);
const helpers = existsSync(helperUrl) ? await import(helperUrl.href) : {};
const origin = "https://pfdocs.synthetic.invalid";
const editor = { requestId: "open-synthetic", channelHash: "a".repeat(32), documentId: "synthetic-document" };
const messages = [0, 1].map((index) => ({ author: `member-${index}`, text: `message-${index}` }));
const normalized = (value, length) => String(value || "").split("\u0000").join("").trim().slice(0, length);
const scalarSafe = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

async function bridge(overrides = {}, options = {}) {
  const attempts = [], replies = [];
  const target = { postMessage: (reply, responseOrigin) => replies.push({ ...reply, responseOrigin }) };
  const data = {
    type: "pfdocs.tasknode.assistant-request", ...editor,
    assistantRequestId: "assistant-synthetic", odvRequestId: "odv-synthetic",
    persona: "odv", prompt: "@ODV explain this document", documentTitle: "Synthetic title",
    documentContent: "Synthetic readable content", recentMessages: messages, ...overrides,
  };
  const dependencies = {
    pfdocsOrigin: origin, editorFrameRef: { current: { contentWindow: target } },
    editorRef: { current: options.noEditor ? null : editor }, editorFullContext: options.fullContext === true,
    pendingCreateRef: { current: null }, setEditorLoading() {}, postEditorContext() {},
    syncDocumentTitle() {}, setEditorImport() {},
    errorText: (result, fallback) => result.body?.error || fallback,
    requestJson: async (path, request) => {
      const bodyBytes = Buffer.byteLength(request.body, "utf8");
      const attempt = { path, bodyBytes, body: JSON.parse(request.body), admitted: false };
      attempts.push(attempt);
      if (options.force413) return { ok: false, status: 413, body: { error: "request_too_large" } };
      if (options.forceOtherError) return { ok: false, status: 503, body: { error: "Synthetic ordinary error" } };
      const req = Readable.from([Buffer.from(request.body, "utf8")]);
      req.headers = { "content-type": "application/json" };
      try {
        await readValidatedJson(req, 128_000);
        attempt.admitted = true;
        return { ok: true, status: 200, body: { response: "Synthetic reply", persona: attempt.body.persona } };
      } catch (error) {
        return { ok: false, status: error.status, body: { error: error.message } };
      }
    }, ...helpers,
  };
  const onMessage = Function(...Object.keys(dependencies), `${callback}\nreturn onMessage;`)(...Object.values(dependencies));
  onMessage({ origin: options.wrongOrigin ? "https://foreign.synthetic.invalid" : origin,
    source: options.wrongFrame ? {} : target, data });
  await new Promise((resolve) => setImmediate(resolve));
  return { attempts, replies, data };
}

function admitted(result, legacy = false) {
  assert.equal(result.attempts.length, 1);
  const attempt = result.attempts[0];
  assert.ok(attempt.bodyBytes <= 128_000, `Actual UTF-8 JSON body exceeds HTTP boundary: ${attempt.bodyBytes}`);
  assert.equal(attempt.admitted, true);
  assert.equal(attempt.path, `/api/docs/documents/${editor.documentId}/${legacy ? "odv" : "assistant"}`);
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].ok, true);
  assert.equal(result.replies[0].requestId, editor.requestId);
  assert.equal(result.replies[0].channelHash, editor.channelHash);
  assert.equal(result.replies[0].assistantRequestId, "assistant-synthetic");
  assert.equal(result.replies[0].responseOrigin, origin);
  assert.ok(attempt.body.documentContent.length > 0);
  assert.ok(scalarSafe(attempt.body.documentContent));
  assert.equal(attempt.body.prompt, normalized(result.data.prompt, 4000));
  return attempt.body;
}

const cases = [];
async function test(name, run) {
  try { await run(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: error.message }); }
}
for (const legacy of [false, true]) {
  const type = legacy ? "pfdocs.tasknode.odv-request" : "pfdocs.tasknode.assistant-request";
  await test(`small-${legacy ? "legacy" : "assistant"}`, async () => {
    const result = await bridge({ type });
    const body = admitted(result, legacy);
    assert.equal(body.documentContent, result.data.documentContent);
    assert.deepEqual(body.recentMessages, messages);
    assert.equal(body.includeFullContext, false);
  });
  for (const [name, documentContent] of [
    ["cjk", "文".repeat(80_000)], ["emoji", "🧭".repeat(40_000)],
    ["escape", '\\"\u0001'.repeat(26_666)],
  ]) {
    await test(`${name}-${legacy ? "legacy" : "assistant"}`, async () => {
      const result = await bridge({ type, documentContent }, { fullContext: true });
      const body = admitted(result, legacy);
      assert.equal(body.includeFullContext, true);
      assert.deepEqual(body.recentMessages, messages);
      assert.ok(documentContent.startsWith(body.documentContent));
    });
  }
}
await test("normalize-before-admission-canonical-last12", async () => {
  const recentMessages = Array.from({ length: 20 }, (_, index) => ({ author: `member-${index}`, text: `${index}:` + "文".repeat(3000) }));
  const result = await bridge({ prompt: "@ODV " + "p".repeat(30_000), documentTitle: "t".repeat(10_000),
    documentContent: "文".repeat(80_000), recentMessages });
  const body = admitted(result);
  assert.equal(body.documentTitle.length, 180);
  assert.deepEqual(body.recentMessages, recentMessages.slice(-12).map((row) => ({ author: normalized(row.author, 120), text: normalized(row.text, 2000) })));
});
await test("irreducible-core-fails-locally", async () => {
  const result = await bridge({ recentMessages: Array.from({ length: 12 }, () => ({ author: "member", text: "\u0001".repeat(2000) })) });
  assert.equal(result.attempts.length, 0, "Do not send an irreducible oversized core");
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].ok, false);
  assert.match(result.replies[0].error, /shorten|shorter|reduce/i);
});
for (const options of [{ wrongOrigin: true }, { wrongFrame: true }, { noEditor: true }]) {
  await test(`bridge-boundary-${Object.keys(options)[0]}`, async () => {
    const result = await bridge({}, options);
    assert.deepEqual(result.attempts, []); assert.deepEqual(result.replies, []);
  });
}
for (const override of [{ requestId: "foreign" }, { channelHash: "b".repeat(32) }]) {
  await test(`bridge-boundary-${Object.keys(override)[0]}`, async () => {
    const result = await bridge(override);
    assert.deepEqual(result.attempts, []); assert.deepEqual(result.replies, []);
  });
}
await test("http413-actionable-recovery", async () => {
  const result = await bridge({}, { force413: true });
  assert.equal(result.replies[0].ok, false);
  assert.match(result.replies[0].error, /shorten|shorter|reduce/i);
});
await test("ordinary-error-unchanged", async () => {
  const result = await bridge({}, { forceOtherError: true });
  assert.equal(result.replies[0].error, "Synthetic ordinary error");
});
await test("coach-correlation", async () => {
  const result = await bridge({ persona: "coach", prompt: "@coach explain this" });
  assert.equal(admitted(result).persona, "coach");
  assert.equal(result.replies[0].persona, "coach");
  assert.equal(result.replies[0].label, "Trading Coach");
});
await test("scalar-at-server-character-cap", async () => {
  const result = await bridge({ documentContent: "a".repeat(79_999) + "🧭" });
  assert.equal(admitted(result).documentContent, "a".repeat(79_999));
});
await test("unicode-excerpt-maximal-under-byte-limit", async () => {
  const documentContent = "文🧭e\u0301".repeat(15_000);
  const result = await bridge({ documentContent });
  const body = admitted(result);
  const next = String.fromCodePoint(documentContent.codePointAt(body.documentContent.length));
  assert.ok(Buffer.byteLength(JSON.stringify({ ...body, documentContent: body.documentContent + next }), "utf8") > 128_000);
});
await test("normalize-NUL-trim-filter-without-reordering", async () => {
  const result = await bridge({ prompt: " \u0000@ODV explain \u0000 ", documentContent: " \u0000readable\u0000 ",
    recentMessages: [{ author: " x\u0000 ", text: " first\u0000 " }, { text: "\u0000 " }, { text: " second " }] });
  const body = admitted(result);
  assert.equal(body.documentContent, "readable");
  assert.deepEqual(body.recentMessages, [{ author: "x", text: "first" }, { author: "member", text: "second" }]);
});
await test("unrelated-bridge-fields-not-forwarded", async () => {
  const result = await bridge({ userContext: "SYNTHETIC_NOT_AUTHORIZED", privateField: "SYNTHETIC_EXTRA" });
  const body = admitted(result);
  assert.deepEqual(Object.keys(body).sort(), ["channelHash", "persona", "includeFullContext", "prompt", "documentTitle", "documentContent", "recentMessages"].sort());
});
await test("empty-normalized-content-keeps-server-error-boundary", async () => {
  const result = await bridge({ documentContent: "\u0000 " });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].body.documentContent, "");
  // The transport does not invent content or bypass the server's content check.
});
console.log(JSON.stringify({
  provenance: "Source-informed actual bridge callback; synthetic transport and actual HTTP reader; no live provider/account/wallet actions",
  bridgeSHA256: createHash("sha256").update(callback).digest("hex"),
  passed: cases.filter((row) => row.passed).length, failed: cases.filter((row) => !row.passed).length, cases,
}, null, 2));
if (cases.some((row) => !row.passed)) process.exitCode = 1;
