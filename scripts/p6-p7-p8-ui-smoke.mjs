#!/usr/bin/env node
// Unified unit smoke for Wave 3 Lane 4C:
// - Pillar 6: On-Chain Identity Registrar, NIP-05 responder, payload builder & Mint UI
// - Pillar 7: Optional NAVCoin Fee Schedule UI & exact protocol caps/math
// - Pillar 8: Permissionless-by-default launch, optional compliance drawer & bridge holds
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { L1_READ_METHODS } from "../src/features/wallet/l1/lib/rpc-methods.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Verify frozen Train A & Train B read RPCs are registered for wallet/UI queries.
const expectedReadMethods = [
  "identity_info",
  "identity_by_nostr",
  "identity_by_handle",
  "identity_by_link",
  "nav_fee_schedule",
  "nav_fee_history",
  "account_bridge_holds",
  "asset_bridge_holds",
  "did_resolve",
  "issuer_info",
  "issuer_list",
  "credential_info",
  "account_credentials",
  "asset_access_info",
];
for (const method of expectedReadMethods) {
  assert.ok(L1_READ_METHODS.has(method), `Missing frozen L1 read method: ${method}`);
}

const testFiles = [
  "server/identity/identity.test.mjs",
  "src/features/identity/onchain-identity.test.mjs",
  "src/features/navcoin-fees/navcoin-fees.test.mjs",
  "src/features/navcoin-compliance/navcoin-compliance.test.mjs",
];

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});
if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(`p6-p7-p8-ui smoke ok: ${testFiles.length} suites passed and ${expectedReadMethods.length} Train A/B RPC methods verified`);
