import assert from "node:assert/strict";
import {
  fetchProfileNftImage,
  profileNftImageProxyPath,
} from "../server/profile-nft-image-proxy.js";

const cid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbq";
const imageBytes = Buffer.from("profile-nft-image-smoke");
let fetchCount = 0;

assert.equal(
  profileNftImageProxyPath(cid),
  `/api/profile/nft/image/${cid}`
);

const invalid = await fetchProfileNftImage({
  cid: "not a cid",
  fetchImpl: async () => {
    throw new Error("should_not_fetch_invalid_cid");
  },
});
assert.equal(invalid.ok, false);
assert.equal(invalid.status, 400);

const first = await fetchProfileNftImage({
  cid,
  gateways: ["https://bad.example/ipfs/", "https://good.example/ipfs/"],
  cacheTtlMs: 60_000,
  maxCacheBytes: 1024 * 1024,
  fetchImpl: async (url) => {
    fetchCount += 1;
    if (url.startsWith("https://bad.example/")) {
      return new Response("missing", { status: 404 });
    }
    return new Response(imageBytes, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(imageBytes.length) },
    });
  },
});
assert.equal(first.ok, true);
assert.equal(first.cache, "miss");
assert.equal(first.contentType, "image/png");
assert.equal(Buffer.compare(first.bytes, imageBytes), 0);
assert.equal(fetchCount, 2);

const second = await fetchProfileNftImage({
  cid,
  gateways: ["https://bad.example/ipfs/"],
  cacheTtlMs: 60_000,
  fetchImpl: async () => {
    throw new Error("should_not_fetch_cached_cid");
  },
});
assert.equal(second.ok, true);
assert.equal(second.cache, "hit");
assert.equal(Buffer.compare(second.bytes, imageBytes), 0);
assert.equal(fetchCount, 2);

console.log("profile-nft-image-proxy-smoke ok");
