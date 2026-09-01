#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasknode-wallet-challenge-binding-"));
process.env.TASKNODE_STORE_PATH = path.join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_AUTH_SECRET = "wallet-challenge-binding-smoke-secret";
process.env.TASKNODE_INITIAL_PROVIDER_CREDIT_USD = "0";

try {
  const { passwordEnableStart } = await import("../server/account-password-auth.js");
  const { walletCreateStart, walletLinkStart, walletRelinkStart } = await import("../server/product-wallet-contracts.js");
  const { linkWalletToAccount } = await import("../server/repositories/account-wallets.js");
  const { getOrCreateProviderAccount } = await import("../server/repositories/accounts.js");

  const account = await getOrCreateProviderAccount({
    provider: "x",
    providerUserId: "wallet-challenge-binding-smoke",
    username: "wallet-challenge-binding-smoke",
  });
  const session = { accountId: account.id };
  const starts = await Promise.all([
    walletCreateStart("POST", session),
    walletLinkStart("POST", session),
    walletRelinkStart("POST", session),
  ]);
  assert.deepEqual(
    starts.map((result) => result.body.challenge.accountId),
    [account.id, account.id, account.id],
    "every wallet challenge response must expose its session-bound account id"
  );
  assert.deepEqual(
    starts.map((result) => result.body.challenge.purpose),
    ["wallet_create", "wallet_link", "wallet_relink"]
  );

  const linked = await linkWalletToAccount({
    accountId: account.id,
    address: "rWalletChallengeBindingSmoke",
    publicKey: "wallet-challenge-binding-public-key",
    proofPurpose: "wallet_link",
  });
  assert.equal(linked.ok, true);
  const passwordStart = await passwordEnableStart({}, session);
  assert.equal(passwordStart.status, 200);
  assert.equal(passwordStart.body.challenge.accountId, account.id);
  assert.equal(passwordStart.body.challenge.purpose, "password_enable");

  console.log("wallet challenge account binding smoke ok: create, link, relink, and password enable");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
