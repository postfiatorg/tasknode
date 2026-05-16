import assert from "node:assert/strict";
import { createPftBalanceService } from "../server/pftl-balance.js";

const validAddress = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

async function testWssPrimaryAndCache() {
  let nowMs = 1000;
  const calls = [];
  const service = createPftBalanceService({
    env: {
      PFTL_WSS_URL: "wss://ws.internal.postfiat.org",
      PFTL_RPC_URL: "https://rpc.internal.postfiat.org",
      PFT_BALANCE_CACHE_TTL_MS: "15000",
    },
    cache: new Map(),
    now: () => nowMs,
    requestWss: async ({ url, address }) => {
      calls.push({ source: "wss", url, address });
      return "123456789";
    },
    requestRpc: async () => {
      throw new Error("rpc_should_not_be_called");
    },
  });

  const first = await service.fetchPftBalance(validAddress);
  const second = await service.fetchPftBalance(validAddress);
  nowMs += 16000;
  const third = await service.fetchPftBalance(validAddress);

  assert.equal(first.ok, true);
  assert.equal(first.source, "pftl_wss");
  assert.equal(first.balanceDrops, "123456789");
  assert.equal(first.balancePft, 123.456789);
  assert.equal(second.cached, true);
  assert.equal(third.cached, false);
  assert.equal(calls.length, 2);
}

async function testRpcFallback() {
  const service = createPftBalanceService({
    env: {
      PFTL_WSS_URL: "wss://ws.internal.postfiat.org",
      PFTL_RPC_URL: "https://rpc.internal.postfiat.org",
    },
    cache: new Map(),
    requestWss: async () => {
      const error = new Error("pftl_wss_request_timeout");
      error.code = "pftl_wss_request_timeout";
      throw error;
    },
    requestRpc: async ({ url }) => {
      assert.equal(url, "https://rpc.internal.postfiat.org");
      return "2000000";
    },
  });

  const result = await service.fetchPftBalance(validAddress);
  assert.equal(result.ok, true);
  assert.equal(result.source, "pftl_rpc");
  assert.equal(result.balanceDrops, "2000000");
  assert.equal(result.balancePft, 2);
}

async function testMissingAccountIsZero() {
  const service = createPftBalanceService({
    env: {
      PFTL_WSS_URL: "wss://ws.internal.postfiat.org",
    },
    cache: new Map(),
    requestWss: async () => {
      const error = new Error("actNotFound");
      error.code = "actNotFound";
      throw error;
    },
  });

  const result = await service.fetchPftBalance(validAddress);
  assert.equal(result.ok, true);
  assert.equal(result.balanceDrops, "0");
  assert.equal(result.accountExists, false);
}

async function testConfigurationAndValidationErrors() {
  const service = createPftBalanceService({ env: {}, cache: new Map() });

  const missingConfig = await service.fetchPftBalance(validAddress);
  const invalidAddress = await service.fetchPftBalance("not_a_wallet");

  assert.equal(missingConfig.ok, false);
  assert.equal(missingConfig.status, 503);
  assert.equal(missingConfig.error, "pft_balance_not_configured");
  assert.equal(invalidAddress.ok, false);
  assert.equal(invalidAddress.status, 400);
  assert.equal(invalidAddress.error, "pft_balance_invalid_address");
}

await testWssPrimaryAndCache();
await testRpcFallback();
await testMissingAccountIsZero();
await testConfigurationAndValidationErrors();

console.log("wallet balance smoke passed");
