import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  fetchProfileNftImage,
  fetchProfileNftPfpThumbnail,
  handleProfileNftImageRoute,
  handleProfileNftPfpRoute,
  profileNftImageGatewayList,
  profileNftImageProxyPath,
  profileNftPfpProxyPath,
} from "../server/profile-nft-image-proxy.js";

const cid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbq";
const routeCid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbr";
const singleFlightCid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbsingle";
const thumbnailCid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbthumb";
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
assert.equal(
  profileNftPfpProxyPath(cid, { size: 96 }),
  `/api/profile/nft/pfp/${cid}?size=96`
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

const sourcePng = await sharp({
  create: {
    width: 512,
    height: 384,
    channels: 4,
    background: { r: 31, g: 128, b: 84, alpha: 1 },
  },
}).png().toBuffer();
const thumbnailCacheDir = await mkdtemp(path.join(os.tmpdir(), "tasknode-pfp-thumb-"));
const thumbnailEnv = { TASKNODE_PROFILE_NFT_THUMBNAIL_CACHE_DIR: thumbnailCacheDir };
let thumbnailSourceFetchCount = 0;
try {
  const thumbnail = await fetchProfileNftPfpThumbnail({
    cid: thumbnailCid,
    size: 48,
    env: thumbnailEnv,
    fetchImage: async ({ cid: requestedCid }) => {
      thumbnailSourceFetchCount += 1;
      assert.equal(requestedCid, thumbnailCid);
      return {
        ok: true,
        cid: requestedCid,
        bytes: sourcePng,
        contentType: "image/png",
        cache: "miss",
      };
    },
  });
  assert.equal(thumbnail.ok, true);
  assert.equal(thumbnail.cache, "miss");
  assert.equal(thumbnail.contentType, "image/webp");
  assert.ok(thumbnail.bytes.length < sourcePng.length);
  const metadata = await sharp(thumbnail.bytes).metadata();
  assert.equal(metadata.width, 48);
  assert.equal(metadata.height, 48);
  assert.equal(metadata.format, "webp");

  const diskThumbnail = await fetchProfileNftPfpThumbnail({
    cid: thumbnailCid,
    size: 48,
    env: thumbnailEnv,
    fetchImage: async () => {
      throw new Error("disk thumbnail should not refetch source");
    },
  });
  assert.equal(diskThumbnail.ok, true);
  assert.equal(diskThumbnail.cache, "disk");
  assert.equal(Buffer.compare(diskThumbnail.bytes, thumbnail.bytes), 0);
  assert.equal(thumbnailSourceFetchCount, 1);

  const thumbnailRouteRes = createResponseCapture();
  const handledPfpRoute = await handleProfileNftPfpRoute({
    json,
    req: { method: "GET", headers: {} },
    res: thumbnailRouteRes,
    url: new URL(`http://tasknode.local/api/profile/nft/pfp/${thumbnailCid}?size=500`),
    fetchThumbnail: async ({ cid: requestedCid, size }) => {
      assert.equal(requestedCid, thumbnailCid);
      assert.equal(size, 192);
      return {
        ok: true,
        cid: requestedCid,
        size,
        format: "webp",
        bytes: thumbnail.bytes,
        contentType: "image/webp",
        cache: "disk",
      };
    },
  });
  assert.equal(handledPfpRoute, true);
  assert.equal(thumbnailRouteRes.statusCode, 200);
  assert.equal(thumbnailRouteRes.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(thumbnailRouteRes.headers["content-type"], "image/webp");
  assert.equal(thumbnailRouteRes.headers["x-profile-nft-thumbnail-size"], "192");
  assert.equal(thumbnailRouteRes.headers["x-profile-nft-thumbnail-cache"], "disk");
  assert.equal(thumbnailRouteRes.headers.etag, `"${thumbnailCid}:pfp:192:webp"`);

  const thumbnailNotModifiedRes = createResponseCapture();
  const handledPfpNotModified = await handleProfileNftPfpRoute({
    json,
    req: { method: "GET", headers: { "if-none-match": `"${thumbnailCid}:pfp:96:webp"` } },
    res: thumbnailNotModifiedRes,
    url: new URL(`http://tasknode.local/api/profile/nft/pfp/${thumbnailCid}?size=96`),
    fetchThumbnail: async () => {
      throw new Error("matching thumbnail etag must not fetch");
    },
  });
  assert.equal(handledPfpNotModified, true);
  assert.equal(thumbnailNotModifiedRes.statusCode, 304);
  assert.equal(thumbnailNotModifiedRes.headers.etag, `"${thumbnailCid}:pfp:96:webp"`);
  assert.equal(thumbnailNotModifiedRes.body.length, 0);

  let pfpSingleFlightFetchCount = 0;
  const pfpSingleFlightCacheDir = await mkdtemp(path.join(os.tmpdir(), "tasknode-pfp-flight-"));
  try {
    const pfpConcurrent = await Promise.all(Array.from({ length: 5 }, () => fetchProfileNftPfpThumbnail({
      cid: `${thumbnailCid}flight`,
      size: 96,
      env: { TASKNODE_PROFILE_NFT_THUMBNAIL_CACHE_DIR: pfpSingleFlightCacheDir },
      fetchImage: async () => {
        pfpSingleFlightFetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ok: true,
          cid: `${thumbnailCid}flight`,
          bytes: sourcePng,
          contentType: "image/png",
          cache: "miss",
        };
      },
    })));
    assert.equal(pfpSingleFlightFetchCount, 1);
    for (const result of pfpConcurrent) {
      assert.equal(result.ok, true);
      assert.equal(result.contentType, "image/webp");
    }
  } finally {
    await rm(pfpSingleFlightCacheDir, { force: true, recursive: true });
  }
} finally {
  await rm(thumbnailCacheDir, { force: true, recursive: true });
}

console.log("profile-nft-image-proxy-smoke ok");
