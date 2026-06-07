import assert from "node:assert/strict";

process.env.TASKNODE_IPFS_GATEWAY = "";
process.env.TASKNODE_IPFS_GATEWAYS = "https://fast.example/ipfs/, https://second.example/ipfs/";
process.env.IPFS_GATEWAY_FALLBACKS = "https://fallback.example/ipfs/";
process.env.IPFS_GATEWAY_URL = "https://legacy.example/ipfs/";

const { contextIpfsGatewayList } = await import("../server/context-ipfs.js");

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

console.log("context-ipfs-gateway-smoke ok");
