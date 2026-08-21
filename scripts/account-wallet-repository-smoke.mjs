#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL) throw new Error("account_wallet_smoke_database_url_required");
const tempDir = mkdtempSync(join(tmpdir(), "tasknode-account-wallet-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";

const legacyAccount = `acct_wallet_legacy_${Date.now()}`;
const runtime = await import("../server/runtime-store.js");
runtime.linkWalletToAccount({
  accountId: legacyAccount,
  address: `rWalletLegacy${Date.now()}`,
  publicKey: "EDPUBLICLEGACY",
  tasknodeEncryptionPubkey: "encryption-legacy",
  proofPurpose: "wallet_create",
  databaseMirror: false,
});

delete process.env.TASKNODE_DATABASE_DISABLED;
process.env.TASKNODE_DATABASE_ENABLED = "true";

const { closePool, query } = await import("../server/db/pool.js");
const {
  accountWalletStorageStatus,
  delinkWalletFromAccount,
  findLinkedWalletOwner,
  getLinkedWallet,
  linkWalletToAccount,
  migrateLegacyAccountWallets,
} = await import("../server/repositories/account-wallets.js");

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const firstAccount = `acct_wallet_smoke_first_${suffix}`;
const secondAccount = `acct_wallet_smoke_second_${suffix}`;
const firstAddress = `rWalletSmokeFirst${suffix}`;
const secondAddress = `rWalletSmokeSecond${suffix}`;

try {
  assert.equal(accountWalletStorageStatus().adapter, "postgres");
  await query("DELETE FROM runtime_state_migrations WHERE name = 'account_wallets_to_postgres_v1'");
  const migrated = await migrateLegacyAccountWallets();
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.count, 1);
  assert.equal((await getLinkedWallet({ accountId: legacyAccount })).tasknodeEncryptionPubkey, "encryption-legacy");
  assert.equal((await migrateLegacyAccountWallets()).migrated, false, "the legacy import marker must make startup idempotent");
  const first = await linkWalletToAccount({
    accountId: firstAccount,
    address: firstAddress,
    publicKey: "EDPUBLICFIRST",
    tasknodeEncryptionPubkey: "encryption-first",
    challengeId: "challenge-first",
    signature: "signature-first",
    proofPurpose: "wallet_create",
  });
  assert.equal(first.ok, true);
  assert.equal(first.wallet.walletCreatedInAccount, true);
  assert.equal((await getLinkedWallet({ accountId: firstAccount })).tasknodeEncryptionPubkey, "encryption-first");

  const reclaimed = await linkWalletToAccount({
    accountId: secondAccount,
    address: firstAddress,
    publicKey: "EDPUBLICSECOND",
    challengeId: "challenge-second",
    signature: "signature-second",
    proofPurpose: "wallet_link",
  });
  assert.equal(reclaimed.reclaimedWalletCount, 1);
  assert.equal((await getLinkedWallet({ accountId: firstAccount })).status, "not_linked");
  assert.equal((await findLinkedWalletOwner({ address: firstAddress })).accountId, secondAccount);

  const relinked = await linkWalletToAccount({
    accountId: secondAccount,
    address: secondAddress,
    publicKey: "EDPUBLICSECONDNEW",
    tasknodeEncryptionPubkey: "encryption-second",
    challengeId: "challenge-third",
    signature: "signature-third",
    proofPurpose: "wallet_relink",
  });
  assert.equal(relinked.wallet.address, secondAddress);
  assert.equal(relinked.wallet.proofPurpose, "wallet_relink");
  assert.equal(relinked.wallet.proof.signatureHash.startsWith("sig_"), true);

  const delinked = await delinkWalletFromAccount({ accountId: secondAccount, reason: "smoke" });
  assert.equal(delinked.ok, true);
  assert.equal((await getLinkedWallet({ accountId: secondAccount })).status, "not_linked");
  assert.equal(await findLinkedWalletOwner({ address: secondAddress }), null);
  console.log("account wallet repository smoke ok: durable metadata, serialized reclaim, relink, delink");
} finally {
  await query("DELETE FROM account_linked_wallets WHERE account_id = ANY($1::text[])", [[firstAccount, secondAccount, legacyAccount]]).catch(() => {});
  await query("DELETE FROM runtime_state_migrations WHERE name = 'account_wallets_to_postgres_v1'").catch(() => {});
  await closePool();
  rmSync(tempDir, { recursive: true, force: true });
}
