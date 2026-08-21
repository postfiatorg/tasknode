#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL) throw new Error("account_repository_smoke_database_url_required");
const tempDir = mkdtempSync(join(tmpdir(), "tasknode-accounts-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";
const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const email = `legacy-${suffix}@example.test`;
const runtime = await import("../server/runtime-store.js");
const legacy = runtime.getOrCreateEmailAccount({ email, canonicalEmail: email, maskedEmail: "l***@example.test" });
runtime.linkProviderToAccount({ accountId: legacy.id, provider: "github", providerUserId: `legacy-github-${suffix}`, username: `legacy-${suffix}` });

delete process.env.TASKNODE_DATABASE_DISABLED;
process.env.TASKNODE_DATABASE_ENABLED = "true";
const { closePool, query } = await import("../server/db/pool.js");
const {
  accountStorageStatus,
  findAccountByEmail,
  findAccountByIdentity,
  getOrCreateEmailAccount,
  getOrCreateProviderAccount,
  linkProviderToAccount,
  migrateLegacyAccounts,
  unlinkProviderFromAccount,
} = await import("../server/repositories/accounts.js");
const {
  getAccountIdentityProfile,
  getAccountExpertReview,
  getAccountProfileVisibility,
  listDiscoverableAccountWalletIdentities,
  listPublicAccountWalletIdentities,
  setAccountAliasVisibility,
  setAccountExpertReview,
  setAccountHiveHandle,
  setAccountProfileVisibility,
} = await import("../server/repositories/account-profiles.js");
const { linkWalletToAccount } = await import("../server/repositories/account-wallets.js");
const { resolveOrCreateWalletLoginAccount } = await import("../server/repositories/wallet-accounts.js");

const accountIds = [legacy.id];
try {
  assert.equal(accountStorageStatus().adapter, "postgres");
  await query("DELETE FROM runtime_state_migrations WHERE name = 'app_accounts_to_postgres_v1'");
  const migrated = await migrateLegacyAccounts();
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.count, 1);
  assert.equal((await findAccountByEmail(email)).id, legacy.id);
  assert.equal((await findAccountByIdentity("github", `legacy-github-${suffix}`)).id, legacy.id);
  assert.equal((await migrateLegacyAccounts()).migrated, false);

  const concurrentEmail = `concurrent-${suffix}@example.test`;
  const emailAccounts = await Promise.all(Array.from({ length: 6 }, () => getOrCreateEmailAccount({
    email: concurrentEmail, canonicalEmail: concurrentEmail, maskedEmail: "c***@example.test",
  })));
  assert.equal(new Set(emailAccounts.map((account) => account.id)).size, 1, "email ownership must serialize");
  accountIds.push(emailAccounts[0].id);

  const recoveredEmail = `recovered-${suffix}@example.test`;
  const recoveredEmailAccountId = `acct_email_${createHash("sha256").update(recoveredEmail).digest("hex").slice(0, 24)}`;
  const recoveredEmailHandle = `email-${Math.random().toString(36).slice(2, 10)}`;
  const recoveredEmailAt = new Date().toISOString();
  await query(
    `INSERT INTO app_accounts (account_id, account_json, hive_handle, status, created_at, updated_at)
     VALUES ($1, $2::jsonb, $3, 'active', $4, $4)`,
    [recoveredEmailAccountId, JSON.stringify({
      id: recoveredEmailAccountId, status: "active", displayName: "Recovered Email Member",
      hiveHandle: recoveredEmailHandle, profileVisibility: "public", linkedProviders: [], assurance: "low",
      recoverySource: "durable_profile_census", createdAt: recoveredEmailAt, updatedAt: recoveredEmailAt,
    }), recoveredEmailHandle, recoveredEmailAt]
  );
  accountIds.push(recoveredEmailAccountId);
  const claimedRecoveredEmailAccount = await getOrCreateEmailAccount({
    email: recoveredEmail, canonicalEmail: recoveredEmail, maskedEmail: "r***@example.test",
  });
  assert.equal(claimedRecoveredEmailAccount.id, recoveredEmailAccountId, "email login must reclaim its recovered durable account shell");
  assert.equal(claimedRecoveredEmailAccount.hiveHandle, recoveredEmailHandle, "email reclaim must retain the chosen Hive handle");
  assert.equal((await getAccountIdentityProfile({ accountId: recoveredEmailAccountId })).handleRequired, false, "recovered email login must not ask for a handle again");
  assert.equal((await findAccountByEmail(recoveredEmail)).id, recoveredEmailAccountId, "email reclaim must restore durable email ownership");
  assert.equal((await query("SELECT account_json->>'recoverySource' AS source FROM app_accounts WHERE account_id = $1", [recoveredEmailAccountId])).rows[0].source, null);

  const oauthAccounts = await Promise.all(Array.from({ length: 6 }, () => getOrCreateProviderAccount({
    provider: "discord", providerUserId: `discord-${suffix}`, username: `discord-${suffix}`,
  })));
  assert.equal(new Set(oauthAccounts.map((account) => account.id)).size, 1, "provider identity ownership must serialize");
  accountIds.push(oauthAccounts[0].id);

  const oauthEmail = `oauth-${suffix}@example.test`;
  const oauthEmailAccount = await getOrCreateProviderAccount({
    provider: "github", providerUserId: `github-email-${suffix}`, username: `github-email-${suffix}`,
    emailInfo: { email: oauthEmail, verified: true },
  });
  assert.equal((await findAccountByEmail(oauthEmail)).id, oauthEmailAccount.id, "new OAuth accounts must exist before their verified email identity is linked");
  accountIds.push(oauthEmailAccount.id);

  const recoveredProviderUserId = `github-recovered-${suffix}`;
  const recoveredAccountId = `acct_oauth_${createHash("sha256").update(`github:${recoveredProviderUserId}`).digest("hex").slice(0, 24)}`;
  const recoveredHandle = `recovered-${Math.random().toString(36).slice(2, 10)}`;
  const recoveredAt = new Date().toISOString();
  await query(
    `INSERT INTO app_accounts (account_id, account_json, status, created_at, updated_at)
     VALUES ($1, $2::jsonb, 'active', $3, $3)`,
    [recoveredAccountId, JSON.stringify({
      id: recoveredAccountId, status: "active", displayName: "Recovered Member",
      hiveHandle: recoveredHandle,
      profileVisibility: "public", linkedProviders: [], assurance: "low",
      recoverySource: "durable_profile_census", createdAt: recoveredAt, updatedAt: recoveredAt,
    }), recoveredAt]
  );
  accountIds.push(recoveredAccountId);
  const claimedRecoveredAccount = await getOrCreateProviderAccount({
    provider: "github", providerUserId: recoveredProviderUserId, username: `recovered-${suffix}`,
  });
  assert.equal(claimedRecoveredAccount.id, recoveredAccountId, "the founding OAuth identity must reclaim its recovered durable account shell");
  assert.equal(claimedRecoveredAccount.hiveHandle, recoveredHandle, "reclaiming a recovered account must retain its chosen Hive handle");
  assert.equal((await getAccountIdentityProfile({ accountId: recoveredAccountId })).handleRequired, false, "the recovered login must not ask the member to choose their handle again");
  assert.equal((await query("SELECT account_json->>'recoverySource' AS source FROM app_accounts WHERE account_id = $1", [recoveredAccountId])).rows[0].source, null);

  const conflict = await linkProviderToAccount({
    accountId: emailAccounts[0].id,
    provider: "discord",
    providerUserId: `discord-${suffix}`,
  });
  assert.equal(conflict.error, "provider_identity_conflict");
  const linked = await linkProviderToAccount({
    accountId: emailAccounts[0].id,
    provider: "github",
    providerUserId: `github-${suffix}`,
    username: `github-${suffix}`,
  });
  assert.equal(linked.ok, true);
  const handle = `smoke-${Math.random().toString(36).slice(2, 10)}`;
  const handleResults = await Promise.all([
    setAccountHiveHandle({ accountId: emailAccounts[0].id, handle }),
    setAccountHiveHandle({ accountId: oauthAccounts[0].id, handle }),
  ]);
  assert.equal(handleResults.filter((item) => item.ok).length, 1, "handle uniqueness must serialize across accounts");
  const handleOwner = handleResults[0].ok ? emailAccounts[0].id : oauthAccounts[0].id;
  assert.equal((await getAccountIdentityProfile({ accountId: handleOwner })).hiveHandle, handle);
  assert.equal((await setAccountAliasVisibility({ accountId: emailAccounts[0].id, provider: "github", visibility: "public", discloseHandle: true })).ok, true);
  assert.equal((await setAccountProfileVisibility({ accountId: emailAccounts[0].id, visibility: "private" })).ok, true);
  assert.equal((await getAccountIdentityProfile({ accountId: emailAccounts[0].id })).profileVisibility, "private");
  const unlinked = await unlinkProviderFromAccount({ accountId: emailAccounts[0].id, provider: "github" });
  assert.equal(unlinked.ok, true);
  assert.equal(await findAccountByIdentity("github", `github-${suffix}`), null);
  const blocked = await unlinkProviderFromAccount({ accountId: oauthAccounts[0].id, provider: "discord" });
  assert.equal(blocked.error, "provider_unlink_last_login_method");
  const walletAddress = `rAccountRepositorySmoke${suffix}`;
  const walletAccount = await resolveOrCreateWalletLoginAccount({ address: walletAddress, publicKey: "EDACCOUNTREPOSITORY" });
  assert.equal(walletAccount.ok, true);
  accountIds.push(walletAccount.account.id);
  assert.equal((await linkWalletToAccount({ accountId: walletAccount.account.id, address: walletAddress, publicKey: "EDACCOUNTREPOSITORY", proofPurpose: "wallet_login" })).ok, true);
  assert.equal((await resolveOrCreateWalletLoginAccount({ address: walletAddress, publicKey: "EDACCOUNTREPOSITORY" })).account.id, walletAccount.account.id);
  const walletHandle = `wallet-${Math.random().toString(36).slice(2, 10)}`;
  assert.equal((await setAccountHiveHandle({ accountId: walletAccount.account.id, handle: walletHandle })).ok, true);
  assert.ok((await listPublicAccountWalletIdentities()).some((identity) => identity.accountId === walletAccount.account.id));
  assert.ok((await listDiscoverableAccountWalletIdentities()).some((identity) => identity.accountId === walletAccount.account.id));
  assert.deepEqual(await getAccountProfileVisibility({ accountId: walletAccount.account.id }), { visibility: "public", discoverable: true });
  assert.equal((await setAccountProfileVisibility({ accountId: walletAccount.account.id, visibility: "private" })).ok, true);
  assert.ok(!(await listDiscoverableAccountWalletIdentities()).some((identity) => identity.accountId === walletAccount.account.id));
  assert.equal((await setAccountExpertReview({ accountId: walletAccount.account.id, review: { topic: "protocol safety", score: 92 } })).ok, true);
  assert.deepEqual(await getAccountExpertReview({ accountId: walletAccount.account.id }), { topic: "protocol safety", score: 92 });
  console.log("account repository smoke ok: lossless import, unique identity ownership, durable public/discoverable profiles, conflict and lockout guards");
} finally {
  await query("DELETE FROM account_linked_wallets WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM app_accounts WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM runtime_state_migrations WHERE name = 'app_accounts_to_postgres_v1'").catch(() => {});
  await closePool();
  rmSync(tempDir, { recursive: true, force: true });
}
