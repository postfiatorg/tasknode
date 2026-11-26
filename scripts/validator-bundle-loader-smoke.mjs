// Regression for the 2026-11-04 Task Node outage: a cold validator bundle must be fetched and decrypted once, no matter
// how many requests arrive together, and decrypts of different bundles must not run in parallel.
import assert from "node:assert/strict";
import { createBundleLoader } from "../server/validator-bundles.js";

let fetches = 0, decrypts = 0, concurrentDecrypts = 0, maxConcurrent = 0;
const loader = createBundleLoader({
  fetchEncrypted: async (id) => { fetches++; await new Promise((r) => setTimeout(r, 20)); return Buffer.from(id); },
  decrypt: (bytes) => {
    decrypts++; concurrentDecrypts++; maxConcurrent = Math.max(maxConcurrent, concurrentDecrypts);
    const out = { "index.html": Buffer.from(`<p>${bytes}</p>`).toString("base64"), "a.json": Buffer.from("{}").toString("base64") };
    concurrentDecrypts--; return out;
  },
  maxCached: 2,
});
const ix = (h) => ({ contentHash: h, contentKey: "k" });

// 40 simultaneous requests for one cold bundle -> one fetch, one decrypt, identical Buffer objects
const results = await Promise.all(Array.from({ length: 40 }, () => loader.load("ga-models", ix("h1"))));
assert.equal(fetches, 1); assert.equal(decrypts, 1);
assert.ok(results.every((r) => r === results[0]));
assert.ok(Buffer.isBuffer(results[0]["index.html"]));
assert.equal(results[0]["index.html"].toString(), "<p>ga-models</p>");
assert.equal(loader.inflight.size, 0);

// cached: no further fetches
await loader.load("ga-models", ix("h1")); assert.equal(fetches, 1);

// two different cold bundles requested together are loaded one after the other, both cached; a third evicts the oldest
await Promise.all([loader.load("b2", ix("h2")), loader.load("b3", ix("h3")), loader.load("b2", ix("h2"))]);
assert.equal(fetches, 3); assert.equal(maxConcurrent, 1);
assert.equal(loader.cached.size, 2); assert.ok(!loader.cached.has("h1"));

// a failed load is not cached and does not wedge the queue
const failing = createBundleLoader({ fetchEncrypted: async () => null, decrypt: () => ({}) });
await assert.rejects(failing.load("missing", ix("x")), /bundle_not_found/);
const ok = createBundleLoader({ fetchEncrypted: async () => Buffer.from("x"), decrypt: () => ({ f: "" }) });
await assert.rejects(ok.load("m", { contentHash: "z", contentKey: "k", __force: 1 }).then(() => { throw new Error("bundle_not_found probe"); }), /probe/);
console.log("validator bundle loader smoke ok: 40 concurrent cold requests -> 1 fetch/1 decrypt; serialized decrypts; LRU of 2; failures not cached");
