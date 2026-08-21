import assert from "node:assert/strict";
import { checkGatewayHealth } from "./ipfs-gateway-health.mjs";

const okCid = "QmTNtQcR1qDkEAsCEPK53TY4Yr6Ro64K4z8ZETSMmS5hsK";
const missingCid = "QmbEBhmJowxRY1hGVTHrdkWBNNFxfHHFxFN872p4hZJeHP";

const fetchImpl = async (url) => {
  const text = String(url || "");
  if (text.includes(okCid) && text.startsWith("https://healthy.example/")) {
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "2" },
    });
  }
  return new Response("missing", {
    status: 404,
    headers: { "content-type": "text/plain", "content-length": "7" },
  });
};

const healthy = await checkGatewayHealth({
  gateways: ["https://healthy.example/ipfs/"],
  cids: [okCid],
  timeoutMs: 1000,
  fetchImpl,
});
assert.equal(healthy.ok, true);
assert.equal(healthy.summary.checkCount, 1);
assert.equal(healthy.failures.length, 0);

const unhealthy = await checkGatewayHealth({
  gateways: ["https://healthy.example/ipfs/"],
  cids: [okCid, missingCid],
  timeoutMs: 1000,
  fetchImpl,
});
assert.equal(unhealthy.ok, false);
assert.equal(unhealthy.summary.checkCount, 2);
assert.equal(unhealthy.failures.length, 1);
assert.equal(unhealthy.failures[0].cid, missingCid);
assert.equal(unhealthy.failures[0].error, "HTTP_404");

const missingInputs = await checkGatewayHealth({
  gateways: [],
  cids: [okCid],
  timeoutMs: 1000,
  fetchImpl,
});
assert.equal(missingInputs.ok, false);
assert.equal(missingInputs.summary.checkCount, 0);

console.log("ipfs-gateway-health-smoke ok");

