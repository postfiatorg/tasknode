import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createEncryptedBundleLoader, createBundleLoader, decryptValidatorBundle } from "../server/validator-bundles.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const index = (bytes) => ({ contentHash: hash(bytes) });
test("40 concurrent public downloads and warm reads fetch one identical encrypted buffer", async () => {
  const bytes = Buffer.alloc(19_121_411, 42); // Actual 10 November published size.
  let reads = 0;
  const loader = createEncryptedBundleLoader({ fetchEncrypted: async () => {
    reads++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return bytes;
  } });
  const results = await Promise.all(Array.from({ length: 40 }, () => loader.load("ga-models", index(bytes))));
  assert.equal(reads, 1);
  assert.ok(results.every((result) => result === bytes));
  assert.equal(await loader.load("ga-models", index(bytes)), bytes);
  assert.equal(reads, 1);
});
test("failed reads are not cached; integrity and version changes cannot return stale bytes", async () => {
  let reads = 0;
  const old = Buffer.from("old"), next = Buffer.from("new");
  const loader = createEncryptedBundleLoader({ fetchEncrypted: async () => {
    reads++;
    if (reads === 1) throw new Error("Query read timeout");
    return reads < 4 ? old : next;
  } });
  await assert.rejects(loader.load("ga-models", index(old)), /Query read timeout/);
  assert.equal(await loader.load("ga-models", index(old)), old);
  await assert.rejects(loader.load("ga-models", index(next)), /bundle_integrity_failed/);
  assert.equal(await loader.load("ga-models", index(next)), next);
  assert.equal(loader.inflight.size, 0);
  assert.equal(reads, 4);
});
test("missing bundles stay 404; encrypted cache remains bounded at existing two versions", async () => {
  const missing = createEncryptedBundleLoader({ fetchEncrypted: async () => null });
  await assert.rejects(missing.load("missing", index(Buffer.from("x"))), { status: 404 });
  const loader = createEncryptedBundleLoader({ fetchEncrypted: async (id) => Buffer.from(id) });
  for (const id of ["one", "two", "three"]) await loader.load(id, index(Buffer.from(id)));
  assert.equal(loader.cached.size, 2);
  assert.ok(!loader.cached.has(hash(Buffer.from("one"))));
});
test("public and authenticated loader share one read; decryption and integrity checks remain", async () => {
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const compressed = gzipSync(JSON.stringify({ version: 1, files: { "index.html": Buffer.from("ok").toString("base64") } }));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const bytes = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  const ix = { ...index(bytes), contentKey: key.toString("base64") };
  let reads = 0;
  const raw = createEncryptedBundleLoader({ fetchEncrypted: async () => { reads++; return bytes; } });
  const decoded = createBundleLoader({ fetchEncrypted: (id, version) => raw.load(id, version), decrypt: decryptValidatorBundle });
  const [publicBytes, files] = await Promise.all([raw.load("ga-models", ix), decoded.load("ga-models", ix)]);
  assert.equal(publicBytes, bytes); assert.equal(files["index.html"].toString(), "ok"); assert.equal(reads, 1);
  assert.throws(() => decryptValidatorBundle(bytes, randomBytes(32).toString("base64"), ix.contentHash));
});

const { createValidatorBundleHandler } = await import("../server/validator-bundles.js");
async function request(handler, path, method = "GET", session = null) {
  const response = {};
  const res = { writeHead: (status, headers) => Object.assign(response, { status, headers }), end: (body) => { response.body = body; } };
  await handler({ json: (_, status, body, headers) => Object.assign(response, { status, body, headers }),
    req: { method }, res, session, url: new URL(path, "https://tasknode.postfiat.org") });
  return response;
}
test("actual public handler deduplicates reads and verifies the exact bytes; viewer still requires tier", async () => {
  const bytes = Buffer.from("encrypted fixture"), ix = { ...index(bytes), availableAt: "2026-01-01" };
  let reads = 0, decrypts = 0;
  const loader = createEncryptedBundleLoader({ fetchEncrypted: async () => { reads++; return bytes; } });
  const handler = createValidatorBundleHandler({ readIndex: async () => ix,
    meetsTier: async () => ({ ok: false, reason: "validator_required" }),
    loadEncrypted: (id, v) => loader.load(id, v), loadFiles: () => { decrypts++; throw new Error("must not decrypt"); } });
  const results = await Promise.all(Array.from({ length: 40 }, () => request(handler, "/api/index-viewer/indices/ga-models/content")));
  assert.ok(results.every((r) => r.status === 200 && hash(r.body) === ix.contentHash));
  assert.equal(reads, 1); assert.equal(decrypts, 0);
  assert.equal((await request(handler, "/api/research/bundles/ga-models/index.html")).status, 403);
  assert.equal((await request(handler, "/api/index-viewer/indices/ga-models/content", "POST")).status, 405);
  assert.equal(decrypts, 0);
});
test("route preserves missing/future and integrity failures and logs transient failures without secrets", async () => {
  const path = "/api/index-viewer/indices/ga-models/content";
  for (const ix of [null, { availableAt: "2999-01-01" }]) {
    const handler = createValidatorBundleHandler({ readIndex: async () => ix, loadEncrypted: () => assert.fail("must not load") });
    assert.equal((await request(handler, path)).status, 404);
  }
  const logs = [];
  const handler = createValidatorBundleHandler({ readIndex: async () => ({ availableAt: "2026-01-01" }),
    loadEncrypted: async () => { throw new Error("Query read timeout"); }, logFailure: (...args) => logs.push(args) });
  const r = await request(handler, path);
  assert.equal(r.status, 503); assert.equal(r.body.error, "bundle_unavailable");
  assert.equal(logs[0][1].reason, "query_read_timeout");
  const corrupt = createEncryptedBundleLoader({ fetchEncrypted: async () => Buffer.from("wrong") });
  const bad = createValidatorBundleHandler({ readIndex: async () => ({ ...index(Buffer.from("right")), availableAt: "2026-01-01" }),
    loadEncrypted: (id, ix) => corrupt.load(id, ix) });
  const integrity = await request(bad, path);
  assert.equal(integrity.status, 503); assert.equal(integrity.body.error, "bundle_integrity_failed");
});
