import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

// Bundle the actual browser module, including its JSX utility dependency. No
// application implementation is substituted, and fetch/timers stay synthetic.
const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  root,
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    target: "esnext",
    copyPublicDir: false,
    lib: {
      entry: fileURLToPath(new URL("../src/features/context/context-view-state.js", import.meta.url)),
      formats: ["es"],
    },
  },
});
const output = (Array.isArray(bundle) ? bundle[0] : bundle).output;
const entry = output.find((item) => item.type === "chunk" && item.isEntry);
assert.ok(entry);
const { requestContextSaveJson, refreshContextStateAfterSave } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);
const contextSource = readFileSync(new URL("../src/features/context/ContextView.jsx", import.meta.url), "utf8");
const callbackStart = contextSource.indexOf("const saveContext = useCallback(");
const callbackEnd = contextSource.indexOf("\n  useEffect(", callbackStart);
assert.ok(callbackStart >= 0 && callbackEnd > callbackStart);
// Execute the unchanged save callback with state adapters. This is not a DOM
// rendering test: sanitization/layout and React effects are outside this probe.
const callbackDeclaration = contextSource.slice(callbackStart, callbackEnd);
const makeSaveCallback = new Function("bindings", `
  const { useCallback, canEdit, savingRef, editorRef, setSaving, setSaveMessage,
    sanitizeContextHtml, titleRef, requestContextSaveJson, savePath,
    refreshContextStateAfterSave, onContextChange, setContextBudgetHtml,
    contextBodyToHtml, setDocumentState, latestContextDocumentRef, setSavedTitle,
    lastSavedHtmlRef, setTitle, dirtyRef, setDirty } = bindings;
  ${callbackDeclaration}
  return saveContext;
`);
const observations = [];
async function test(name, run) {
  const previous = { fetch: globalThis.fetch, window: globalThis.window };
  const timers = new Map();
  const calls = [];
  let nextTimer = 1;
  globalThis.window = {
    setTimeout: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  globalThis.fetch = async (path, options) => {
    assert.equal(path, "/api/context/edit/save");
    assert.equal(options.method, "POST");
    calls.push(options);
    const payload = JSON.parse(options.body);
    const oversized = Buffer.byteLength(options.body, "utf8") > 65_536;
    return new Response(JSON.stringify(oversized
      ? { error: "request_too_large" }
      : { document: { id: "context-fixture", revision: 8, ...payload } }), { status: oversized ? 413 : 200 });
  };
  try {
    await run({ calls, timers });
    assert.equal(timers.size, 0, "save timers must be cleared");
    observations.push({ name, pass: true });
  } catch (error) {
    observations.push({ name, pass: false, error: error.message });
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
  }
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
function exactPayload(size) {
  const payload = { title: "x", body: "" };
  payload.body = "a".repeat(size - bytes(payload));
  assert.equal(bytes(payload), size);
  return payload;
}
function viewState(body, onContextChange = async () => null) {
  const state = { title: "x", message: "", saving: false, dirty: true, document: { id: "context-fixture", revision: 7 }, savedEvents: 0 };
  const refs = {
    editorRef: { current: { innerHTML: body } },
    savingRef: { current: false },
    titleRef: { current: "x" },
    dirtyRef: { current: true },
    latestContextDocumentRef: { current: { id: "context-fixture", revision: 7 } },
    lastSavedHtmlRef: { current: "previously-saved" },
  };
  const save = makeSaveCallback({
    ...refs,
    useCallback: (callback) => callback,
    canEdit: true,
    savePath: "/api/context/edit/save",
    requestContextSaveJson,
    refreshContextStateAfterSave,
    onContextChange,
    sanitizeContextHtml: (value) => value,
    contextBodyToHtml: (value) => value,
    setSaving: (value) => { state.saving = value; },
    setSaveMessage: (value) => { state.message = value; },
    setContextBudgetHtml: (value) => { state.budgetHtml = value; },
    setDocumentState: (value) => { state.document = value; state.savedEvents += 1; },
    setSavedTitle: (value) => { state.savedTitle = value; },
    setTitle: (value) => { state.title = value; },
    setDirty: (value) => { state.dirty = value; },
  });
  return { state, refs, save };
}
function assertUnsaved(view, body) {
  assert.equal(view.refs.editorRef.current.innerHTML, body);
  assert.equal(view.state.dirty, true);
  assert.equal(view.refs.dirtyRef.current, true);
  assert.equal(view.state.savedEvents, 0);
  assert.equal(view.refs.lastSavedHtmlRef.current, "previously-saved");
  assert.equal(view.state.saving, false);
  assert.equal(view.refs.savingRef.current, false);
  assert.notEqual(view.state.message, "Saved just now");
}
const boundaryCases = [
  ["ascii-below", exactPayload(65_535), false],
  ["ascii-exact", exactPayload(65_536), false],
  ["ascii-over", exactPayload(65_537), true],
  ["unicode-byte-not-codeunit", { title: "x", body: "🚀".repeat(20_000) }, true],
  ["json-escape-overhead", { title: "x", body: "\\".repeat(33_000) }, true],
  ["title-overhead", { ...exactPayload(65_520), title: "t".repeat(120) }, true],
  ["formatted-short-readable", { title: "x", body: "<strong>x</strong>".repeat(5000) }, true],
  ["plain-short", { title: "Short", body: "A small context" }, false],
];
for (const [name, payload, oversize] of boundaryCases) {
  await test(name, async ({ calls }) => {
    const original = JSON.stringify(payload);
    const result = await requestContextSaveJson("/api/context/edit/save", Object.freeze(payload));
    assert.equal(calls.length, oversize ? 0 : 1, `${name}: known oversize must not fetch`);
    assert.equal(JSON.stringify(payload), original, "draft must not be truncated or mutated");
    assert.equal(result.ok, !oversize);
    if (oversize) {
      assert.equal(result.status, 413);
      assert.match(result.body.message, /copy/i);
      assert.match(result.body.message, /shorten|formatting/i);
      assert.ok(!result.body.message.includes(payload.body.slice(0, 30)));
    } else assert.equal(calls[0].body, original);
  });
}
await test("genuine-server-413", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "proxy_limit", limit: 1000 }), { status: 413 });
  const result = await requestContextSaveJson("/api/context/edit/save", { body: "short" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
  assert.equal(result.body.error, "proxy_limit");
  assert.equal(result.body.limit, 1000);
  assert.match(result.body.message, /copy/i);
});
await test("network-failure", async () => {
  const failure = new Error("synthetic network failure");
  globalThis.fetch = async () => { throw failure; };
  await assert.rejects(requestContextSaveJson("/api/context/edit/save", { body: "short" }), (error) => error === failure);
});
await test("timeout", async ({ timers }) => {
  globalThis.fetch = (_path, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("synthetic abort"), { name: "AbortError" }))));
  const pending = requestContextSaveJson("/api/context/edit/save", { body: "short" });
  timers.values().next().value();
  assert.deepEqual(await pending, { ok: false, status: 0, body: { message: "Context save timed out. Try again." } });
});
await test("dirty-state-and-feedback", async ({ calls }) => {
  const body = "PRIVATE_SYNTHETIC_DRAFT" + "a".repeat(66_000);
  const view = viewState(body);
  assert.equal(await view.save(), false);
  assert.equal(calls.length, 0);
  assertUnsaved(view, body);
  assert.match(view.state.message, /copy/i);
  assert.ok(!view.state.message.includes("PRIVATE_SYNTHETIC_DRAFT"));
});
await test("reduced-draft-retry", async ({ calls }) => {
  const view = viewState("a".repeat(66_000));
  assert.equal(await view.save(), false);
  assert.equal(calls.length, 0);
  view.refs.editorRef.current.innerHTML = "Reduced draft";
  assert.equal(await view.save(), true);
  assert.equal(calls.length, 1);
  assert.equal(view.state.message, "Saved just now");
  assert.equal(view.state.dirty, false);
  assert.equal(view.refs.dirtyRef.current, false);
  assert.equal(view.refs.lastSavedHtmlRef.current, "Reduced draft");
});
await test("view-genuine-413", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "request_too_large" }), { status: 413 });
  const view = viewState("short");
  assert.equal(await view.save(), false);
  assertUnsaved(view, "short");
  assert.match(view.state.message, /copy/i);
});
await test("view-network-failure", async () => {
  globalThis.fetch = async () => { throw new Error("synthetic connection failure"); };
  const view = viewState("short");
  assert.equal(await view.save(), false);
  assertUnsaved(view, "short");
  assert.equal(view.state.message, "Context could not be saved.");
});
await test("view-timeout", async ({ timers }) => {
  globalThis.fetch = (_path, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("synthetic abort"), { name: "AbortError" }))));
  const view = viewState("short");
  const pending = view.save();
  timers.values().next().value();
  assert.equal(await pending, false);
  assertUnsaved(view, "short");
  assert.equal(view.state.message, "Context save timed out. Try again.");
});
await test("newer-edit-and-active-save", async ({ calls }) => {
  let respond;
  globalThis.fetch = (_path, options) => { calls.push(options); return new Promise((resolve) => { respond = resolve; }); };
  const view = viewState("Earlier draft");
  const pending = view.save();
  view.refs.editorRef.current.innerHTML = "Newer draft";
  view.refs.titleRef.current = "Newer title";
  assert.equal(await view.save(), false, "active save must not duplicate fetch");
  assert.equal(calls.length, 1);
  respond(new Response(JSON.stringify({ document: { id: "context-fixture", revision: 8, title: "x", body: "Earlier draft" } }), { status: 200 }));
  assert.equal(await pending, true);
  assert.equal(view.refs.editorRef.current.innerHTML, "Newer draft");
  assert.equal(view.refs.titleRef.current, "Newer title");
  assert.equal(view.state.dirty, true);
  assert.equal(view.refs.dirtyRef.current, true);
  assert.equal(view.refs.lastSavedHtmlRef.current, "Earlier draft");
  assert.notEqual(view.state.message, "Saved just now");
});
await test("stale-refresh-does-not-downgrade", async () => {
  const view = viewState("Saved draft", async () => ({ context: { document: { id: "context-fixture", revision: 6, title: "old", body: "old" } } }));
  assert.equal(await view.save(), true);
  assert.equal(view.state.document.revision, 8);
  assert.equal(view.refs.lastSavedHtmlRef.current, "Saved draft");
});
console.log(JSON.stringify({ checks: observations.length, passed: observations.filter((entry) => entry.pass).length, observations }, null, 2));
assert.equal(observations.filter((entry) => !entry.pass).length, 0, "Context save regression failures");
