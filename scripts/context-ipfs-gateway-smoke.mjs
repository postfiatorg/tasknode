import assert from "node:assert/strict";

process.env.TASKNODE_IPFS_GATEWAY = "";
process.env.TASKNODE_IPFS_GATEWAYS = "https://fast.example/ipfs/, https://second.example/ipfs/";
process.env.IPFS_GATEWAY_FALLBACKS = "https://fallback.example/ipfs/";
process.env.IPFS_GATEWAY_URL = "https://legacy.example/ipfs/";

const { contextIpfsGatewayList, fetchContextIpfsJson } = await import("../server/context-ipfs.js");

const gateways = contextIpfsGatewayList(process.env);

assert.deepEqual(gateways.slice(0, 3), [
  "https://fast.example/ipfs/",
  "https://second.example/ipfs/",
  "https://fallback.example/ipfs/",
]);
assert.ok(gateways.includes("https://pft-ipfs-testnet-clean.fly.dev/ipfs/"));
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

console.log("context-ipfs-gateway-smoke ok");
