import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { BUNDLE_FILE_FORMAT, createBundleFileLoader, decryptBundleFile, encryptBundleFile, fetchBundleFile } from "../server/validator-bundle-files.js";
import { createValidatorBundleHandler } from "../server/validator-bundles.js";

const index = (hash = "version-1") => ({ contentHash: hash, contentKey: randomBytes(32).toString("base64"),
  availableAt: "2026-01-01", tier: "validator", metadata: { fileFormat: BUNDLE_FILE_FORMAT } });
const request = async (handler, filePath, accountId = "member") => {
  const response = {};
  const res = { writeHead: (status, headers) => Object.assign(response, { status, headers }), end: (body) => { response.body = body; } };
  await handler({ json: (_, status, body) => Object.assign(response, { status, body }), req: { method: "GET" },
    res, session: accountId ? { accountId } : null,
    url: new URL(`/api/research/bundles/ga-models/${filePath}`, "https://tasknode.postfiat.org") });
  return response;
};

test("encrypted files bind bytes to the index, version and path", () => {
  const ix = index(), body = Buffer.from("private research\n"), record = encryptBundleFile(body, "ga-models", ix, "index.html");
  assert.deepEqual(decryptBundleFile(record, "ga-models", ix, "index.html"), body);
  for (const args of [["other", ix, "index.html"], ["ga-models", { ...ix, contentHash: "v2" }, "index.html"],
    ["ga-models", ix, "models/AAPL/outputs.json"], ["ga-models", index(), "index.html"]]) {
    assert.throws(() => decryptBundleFile(record, ...args), /bundle_integrity_failed/);
  }
  record.encryptedBytes[30] ^= 1;
  assert.throws(() => decryptBundleFile(record, "ga-models", ix, "index.html"), /bundle_integrity_failed/);
});

test("40 cold home requests read only the home file once; a model loads on demand", async () => {
  const ix = index(), reads = [], source = { "index.html": Buffer.from("<h1>Finance Hub</h1>"),
    "models/AAPL/outputs.json": Buffer.from('{"price":123}') };
  const loader = createBundleFileLoader({ fetchFile: async (id, v, name) => {
    reads.push(name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return encryptBundleFile(source[name], id, v, name);
  } });
  const handler = createValidatorBundleHandler({ readIndex: async () => ix, meetsTier: async () => ({ ok: true }),
    loadFile: loader.load, loadFiles: () => assert.fail("must not load full archive"), loadEncrypted: () => assert.fail("must not read archive") });
  const results = await Promise.all(Array.from({ length: 40 }, () => request(handler, "index.html")));
  assert.ok(results.every((r) => r.status === 200 && r.body === results[0].body));
  assert.deepEqual(reads, ["index.html"]);
  assert.equal(loader.cachedBytes, source["index.html"].length);
  const model = await request(handler, "models/AAPL/outputs.json");
  assert.deepEqual(model.body, source["models/AAPL/outputs.json"]);
  assert.deepEqual(reads, ["index.html", "models/AAPL/outputs.json"]);
  assert.equal(results[0].headers["cache-control"], "private,no-store");
});

test("cached files remain gated; revocation and invalid paths never read files", async () => {
  const ix = index(); let allowed = true, reads = 0, checks = 0;
  const loader = createBundleFileLoader({ fetchFile: async (id, v, name) => {
    reads++; return encryptBundleFile(Buffer.from("private"), id, v, name);
  } });
  const handler = createValidatorBundleHandler({ readIndex: async () => ix, meetsTier: async ({ accountId }) => {
    checks++; return { ok: !!accountId && allowed, reason: "validator_required" };
  }, loadFile: loader.load, loadFiles: () => assert.fail("legacy path") });
  assert.equal((await request(handler, "index.html")).status, 200);
  allowed = false;
  assert.equal((await request(handler, "index.html")).status, 403);
  assert.equal((await request(handler, "index.html", null)).status, 403);
  assert.equal(reads, 1); assert.equal(checks, 3);
  allowed = true;
  for (const path of ["models/%2e%2e%2findex.html", "models/%5cindex.html", "models/%00.json"]) {
    assert.equal((await request(handler, path)).status, 404);
  }
  assert.equal(reads, 1);
});

test("missing or corrupt files never fall back to the archive, and retries recover", async () => {
  const ix = index(); let attempts = 0;
  const loader = createBundleFileLoader({ fetchFile: async (id, v, name) => {
    attempts++;
    if (attempts === 1) return null;
    const record = encryptBundleFile(Buffer.from("ready"), id, v, name);
    if (attempts === 2) record.fileHash = "wrong";
    return record;
  } });
  const handler = createValidatorBundleHandler({ readIndex: async () => ix, meetsTier: async () => ({ ok: true }),
    loadFile: loader.load, loadFiles: () => assert.fail("no archive fallback") });
  assert.equal((await request(handler, "index.html")).status, 404);
  assert.equal((await request(handler, "index.html")).status, 503);
  assert.equal((await request(handler, "index.html")).body.toString(), "ready");
  assert.equal(loader.inflight.size, 0);
});

test("cache bounds bytes and entries, refreshes LRU, and separates versions", async () => {
  const ix = index(), newer = index("version-2"), reads = [];
  const loader = createBundleFileLoader({ maxBytes: 10, maxEntries: 2, fetchFile: async (id, v, name) => {
    reads.push([v.contentHash, name]);
    return encryptBundleFile(Buffer.from(name === "large" ? "12345678901" : "12345"), id, v, name);
  } });
  await loader.load("ga-models", ix, "one");
  await loader.load("ga-models", ix, "two");
  await loader.load("ga-models", ix, "one");
  await loader.load("ga-models", ix, "three");
  assert.equal(loader.cachedBytes, 10); assert.equal(loader.cached.size, 2);
  await loader.load("ga-models", ix, "one");
  assert.equal(reads.length, 3);
  await loader.load("ga-models", ix, "two");
  assert.equal(reads.length, 4);
  await loader.load("ga-models", newer, "two");
  assert.equal(reads.length, 5);
  await loader.load("ga-models", ix, "large");
  await loader.load("ga-models", ix, "large");
  assert.equal(reads.length, 7); assert.equal(loader.cachedBytes, 10);
});

test("legacy publications still use their existing loader", async () => {
  const ix = { ...index(), metadata: {} };
  const handler = createValidatorBundleHandler({ readIndex: async () => ix, meetsTier: async () => ({ ok: true }),
    loadFile: () => assert.fail("legacy file table not required"), loadFiles: async () => ({ "index.html": Buffer.from("legacy") }) });
  assert.equal((await request(handler, "index.html")).body.toString(), "legacy");
});

test("database lookup is constrained to one path and immutable version", async () => {
  const ix = index(); let calls = 0;
  const encrypted = encryptBundleFile(Buffer.from("data"), "ga-models", ix, "index.html");
  const record = await fetchBundleFile(async (sql, params) => {
    calls++;
    assert.match(sql, /WHERE index_id=\$1 AND bundle_hash=\$2 AND file_path=\$3/);
    assert.deepEqual(params, ["ga-models", ix.contentHash, "index.html"]);
    return { rows: [{ encrypted_bytes: encrypted.encryptedBytes, file_hash: encrypted.fileHash }] };
  }, "ga-models", ix, "index.html");
  assert.equal(calls, 1); assert.deepEqual(record, encrypted);
});
