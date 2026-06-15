import assert from "node:assert/strict";
import {
  fetchProfileNftImage,
  handleProfileNftImageRoute,
  profileNftImageGatewayList,
  profileNftImageProxyPath,
} from "../server/profile-nft-image-proxy.js";

const cid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbq";
const routeCid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbr";
const singleFlightCid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbsingle";
const imageBytes = Buffer.from("profile-nft-image-smoke");
let fetchCount = 0;

function createResponseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    end(body = "") {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
    },
  };
}

function json(res, statusCode, body = {}, headers = {}) {
  res.writeHead(statusCode, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

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

const routeRes = createResponseCapture();
let routeFetchCount = 0;
const handledRoute = await handleProfileNftImageRoute({
  json,
  req: { method: "GET", headers: {} },
  res: routeRes,
  url: new URL(`http://tasknode.local/api/profile/nft/image/${routeCid}`),
  fetchImage: async ({ cid: requestedCid }) => {
    routeFetchCount += 1;
    assert.equal(requestedCid, routeCid);
    return {
      ok: true,
      cid: requestedCid,
      bytes: imageBytes,
      contentType: "image/png",
      cache: "miss",
    };
  },
});
assert.equal(handledRoute, true);
assert.equal(routeFetchCount, 1);
assert.equal(routeRes.statusCode, 200);
assert.equal(routeRes.headers["cache-control"], "public, max-age=31536000, immutable");
assert.equal(routeRes.headers.etag, `"${routeCid}"`);
assert.equal(Buffer.compare(routeRes.body, imageBytes), 0);

const notModifiedRes = createResponseCapture();
const handledNotModified = await handleProfileNftImageRoute({
  json,
  req: { method: "GET", headers: { "if-none-match": `"${routeCid}"` } },
  res: notModifiedRes,
  url: new URL(`http://tasknode.local/api/profile/nft/image/${routeCid}`),
  fetchImage: async () => {
    throw new Error("matching etag must not fetch");
  },
});
assert.equal(handledNotModified, true);
assert.equal(notModifiedRes.statusCode, 304);
assert.equal(notModifiedRes.headers["cache-control"], "public, max-age=31536000, immutable");
assert.equal(notModifiedRes.headers.etag, `"${routeCid}"`);
assert.equal(notModifiedRes.body.length, 0);

let singleFlightFetchCount = 0;
const concurrent = await Promise.all(Array.from({ length: 5 }, () => fetchProfileNftImage({
  cid: singleFlightCid,
  gateways: ["https://single-flight.example/ipfs/"],
  cacheTtlMs: 0,
  fetchImpl: async () => {
    singleFlightFetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(imageBytes, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(imageBytes.length) },
    });
  },
})));
assert.equal(singleFlightFetchCount, 1);
for (const result of concurrent) {
  assert.equal(result.ok, true);
  assert.equal(Buffer.compare(result.bytes, imageBytes), 0);
}

console.log("profile-nft-image-proxy-smoke ok");
