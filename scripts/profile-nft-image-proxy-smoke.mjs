import assert from "node:assert/strict";
import {
  fetchProfileNftImage,
  profileNftImageGatewayList,
  profileNftImageProxyPath,
} from "../server/profile-nft-image-proxy.js";

const cid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbq";
const imageBytes = Buffer.from("profile-nft-image-smoke");
let fetchCount = 0;

assert.equal(
  profileNftImageProxyPath(cid),
  `/api/profile/nft/image/${cid}`
);

const gatewayList = profileNftImageGatewayList({
  TASKNODE_PROFILE_NFT_IMAGE_GATEWAYS: "",
  TASKNODE_IPFS_GATEWAY: "",
  TASKNODE_IPFS_GATEWAYS: "",
  IPFS_GATEWAY_FALLBACKS: "https://fallback.example/ipfs/",
  IPFS_GATEWAY_URL: "https://legacy.example/ipfs/",
});
assert.equal(gatewayList[0], "https://fallback.example/ipfs/");
assert.ok(gatewayList.includes("https://pft-ipfs-testnet-clean.fly.dev/ipfs/"));
assert.ok(gatewayList.includes("https://legacy.example/ipfs/"));
assert.ok(gatewayList.indexOf("https://pft-ipfs-testnet-clean.fly.dev/ipfs/") < gatewayList.indexOf("https://legacy.example/ipfs/"));

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
