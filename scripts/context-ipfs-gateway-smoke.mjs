import assert from "node:assert/strict";

process.env.TASKNODE_IPFS_GATEWAY = "";
process.env.TASKNODE_IPFS_GATEWAYS = "https://fast.example/ipfs/, https://second.example/ipfs/";
process.env.IPFS_GATEWAY_FALLBACKS = "https://fallback.example/ipfs/";
process.env.IPFS_GATEWAY_URL = "https://legacy.example/ipfs/";

const { contextIpfsGatewayList, fetchContextIpfsJson, pinIpfsFile } = await import("../server/context-ipfs.js");

const gateways = contextIpfsGatewayList(process.env);

assert.deepEqual(gateways.slice(0, 3), [
  "https://fast.example/ipfs/",
  "https://second.example/ipfs/",
  "https://fallback.example/ipfs/",
]);
assert.ok(gateways.includes("https://pft-ipfs-testnet-clean.fly.dev/ipfs/"));
assert.ok(gateways.includes("https://w3s.link/ipfs/"));
assert.ok(gateways.includes("https://nftstorage.link/ipfs/"));
assert.ok(gateways.includes("https://gateway.pinata.cloud/ipfs/"));
assert.ok(gateways.includes("https://dweb.link/ipfs/"));
assert.ok(gateways.indexOf("https://pft-ipfs-testnet-clean.fly.dev/ipfs/") < gateways.indexOf("https://gateway.pinata.cloud/ipfs/"));
assert.ok(gateways.indexOf("https://legacy.example/ipfs/") > gateways.indexOf("https://dweb.link/ipfs/"));

const fetched = await fetchContextIpfsJson({
  cid: "Qm11111111111111111111111111111111111111111111",
  timeoutMs: 5000,
  env: {
    TASKNODE_IPFS_GATEWAYS: "https://slow.example/ipfs/,https://available.example/ipfs/",
  },
  fetchImpl: async (url, options = {}) => {
    if (String(url).startsWith("https://available.example/ipfs/")) {
      return new Response(JSON.stringify({ ok: true, source: "available" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, 60000);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
    return new Response("{}", { status: 200 });
  },
});
assert.equal(fetched.ok, true);
assert.equal(fetched.gateway, "https://available.example/ipfs/");
assert.equal(fetched.payload.source, "available");

const pinnedCid = "Qm11111111111111111111111111111111111111111111";
const pinCalls = [];
const pinned = await pinIpfsFile({
  bytes: Buffer.from("profile-nft-image"),
  name: "profile-nft.png",
  mimeType: "image/png",
  keyvalues: { type: "profile_nft_image", profileNftId: "nft_smoke" },
  env: {
    PINATA_API_KEY: "pinata-key",
    PINATA_API_SECRET: "pinata-secret",
    IPFS_API_URL: "https://clean.example",
    IPFS_API_USERNAME: "clean-user",
    IPFS_API_PASSWORD: "clean-pass",
    TASKNODE_IPFS_REPLICATION_PIN_ENDPOINT: "https://clean.example/replicate-cid",
    TASKNODE_IPFS_REPLICATION_PIN_TOKEN: "replication-token",
  },
  fetchImpl: async (url, options = {}) => {
    pinCalls.push({ url: String(url), options });
    if (String(url) === "https://api.pinata.cloud/pinning/pinFileToIPFS") {
      return new Response(JSON.stringify({ IpfsHash: pinnedCid }), { status: 200 });
    }
    if (String(url).startsWith("https://clean.example/api/v0/add")) {
      assert.equal(options.headers.authorization, `Basic ${Buffer.from("clean-user:clean-pass").toString("base64")}`);
      return new Response(`${JSON.stringify({ Name: "profile-nft.png", Hash: pinnedCid, Size: "17" })}\n`, { status: 200 });
    }
    if (String(url) === "https://clean.example/replicate-cid") {
      assert.equal(options.headers.authorization, "Bearer replication-token");
      const body = JSON.parse(options.body);
      assert.equal(body.cid, pinnedCid);
      assert.equal(body.payloadClass, "profile_nft_image");
      assert.equal(body.exactCidRequired, true);
      return new Response(JSON.stringify({ ok: true, status: "local_gateway_verified_cluster_queued" }), { status: 200 });
    }
    throw new Error(`unexpected pin URL ${url}`);
  },
});
assert.equal(pinned.cid, pinnedCid);
assert.equal(pinned.firstParty.ok, true);
assert.equal(pinned.firstParty.clusterReplication.ok, true);
assert.equal(pinCalls.length, 3);

console.log("context-ipfs-gateway-smoke ok");
