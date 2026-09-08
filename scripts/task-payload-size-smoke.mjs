import assert from "node:assert/strict";
import { fetchContextIpfsJson, MAX_IPFS_JSON_BYTES, pinContextIpfsJson } from "../server/context-ipfs.js";

const cid = "Qm11111111111111111111111111111111111111111111";
const payload = { schema: "pf.reward.forensics.v1", evidence: "Detailed evidence. ".repeat(100_000) };
let stored = "";
const pinned = await pinContextIpfsJson({ payload, env: { PINATA_JWT: "synthetic-key" }, fetchImpl: async (_url, init) => {
  stored = await init.body.get("file").text();
  return Response.json({ IpfsHash: cid });
} });
assert.equal(pinned.cid, cid);
assert.ok(stored.length > 1_048_576);
const fetched = await fetchContextIpfsJson({ cid, fetchImpl: async () => new Response(stored, { headers: { "content-type": "application/json" } }) });
assert.deepEqual(fetched.payload, payload);
await assert.rejects(pinContextIpfsJson({ payload: { evidence: "x".repeat(MAX_IPFS_JSON_BYTES) }, env: { PINATA_JWT: "synthetic-key" }, fetchImpl: () => { throw new Error("oversized_payload_reached_provider"); } }), { message: "context_ipfs_payload_too_large" });
console.log(JSON.stringify({ ok: true, roundTripBytes: stored.length, maxBytes: MAX_IPFS_JSON_BYTES }));
