#!/usr/bin/env node
// A member who signs in with a method their account does not know gets a second, empty account.
// These checks cover what happens when they then try to link that sign-in, or their wallet.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL) throw new Error("duplicate_account_absorb_smoke_database_url_required");
const tempDir = mkdtempSync(join(tmpdir(), "tasknode-duplicate-accounts-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.TASKNODE_MEMORY_ENABLED = "false";

const { closePool, query } = await import("../server/db/pool.js");
const {
  absorbEmptyDuplicateAccount, findAccountByEmail, findAccountByIdentity, getAccount,
  getOrCreateProviderAccount, linkProviderToAccount,
} = await import("../server/repositories/accounts.js");
const { getLinkedWallet, linkWalletToAccount } = await import("../server/repositories/account-wallets.js");
const { createAccountSession, getSession } = await import("../server/repositories/auth-sessions.js");
const { walletLinkStart, walletLinkVerify } = await import("../server/product-contracts.js");
const { generateTaskNodeMnemonic, signWalletChallenge } = await import("../src/wallet-core.js");

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const accountIds = [];
const wallets = [];
const signIn = async (provider, name, email = "") => {
  const account = await getOrCreateProviderAccount({
    provider, providerUserId: `${provider}-${name}-${suffix}`, username: `${name}-${suffix}`,
    ...(email ? { emailInfo: { email, verified: true } } : {}),
  });
  accountIds.push(account.id);
  return account;
};
const link = (accountId, provider, name, email = "") => linkProviderToAccount({
  accountId, provider, providerUserId: `${provider}-${name}-${suffix}`, username: `${name}-${suffix}`,
  ...(email ? { emailInfo: { email, verified: true } } : {}),
});
const giveWallet = async (accountId, label) => {
  const address = `rDuplicate${label}${suffix}`;
  wallets.push(address);
  assert.equal((await linkWalletToAccount({ accountId, address })).ok, true);
  return address;
};
const status = async (accountId) => (await query("SELECT status, hive_handle, account_json FROM app_accounts WHERE account_id = $1", [accountId])).rows[0];

try {
  // 1. Signed in to the real account, linking a sign-in that sits on an empty duplicate.
  const realEmail = `one-${suffix}@example.test`;
  const real = await signIn("github", "one");
  await giveWallet(real.id, "One");
  const stray = await signIn("discord", "one", realEmail);
  assert.notEqual(stray.id, real.id);
  const straySession = await createAccountSession(stray, { provider: "discord", assurance: "medium" });
  const linked = await link(real.id, "discord", "one", realEmail);
  assert.equal(linked.ok, true, "linking a sign-in held by an empty duplicate must succeed");
  assert.equal(linked.account.id, real.id);
  assert.equal((await findAccountByIdentity("discord", `discord-one-${suffix}`)).id, real.id);
  assert.equal((await findAccountByEmail(realEmail)).id, real.id, "the duplicate's verified email moves with it");
  const retired = await status(stray.id);
  assert.equal(retired.status, "merged");
  assert.equal(retired.account_json.mergedIntoAccountId, real.id);
  assert.deepEqual(retired.account_json.linkedProviders, []);
  assert.equal(await getSession(straySession.sessionId), null, "sessions on the retired duplicate are revoked");
  assert.equal((await signIn("discord", "one", realEmail)).id, real.id, "the moved sign-in now opens the real account");
  assert.equal((await query("SELECT count(*)::integer AS n FROM account_merge_events WHERE source_account_id = $1 AND target_account_id = $2", [stray.id, real.id])).rows[0].n, 1);

  // 2. Signed in to the empty duplicate, linking the sign-in that belongs to the real account.
  const real2 = await signIn("github", "two");
  const wallet2 = await giveWallet(real2.id, "Two");
  const stray2 = await signIn("x", "two");
  const stray2Session = await createAccountSession(stray2, { provider: "x", assurance: "medium" });
  const reversed = await link(stray2.id, "github", "two");
  assert.equal(reversed.ok, true, "linking the real account's sign-in from an empty duplicate must succeed");
  assert.equal(reversed.account.id, real2.id, "the member ends up in the account that holds the work");
  assert.equal((await findAccountByIdentity("x", `x-two-${suffix}`)).id, real2.id);
  assert.equal((await getSession(stray2Session.sessionId)).accountId, real2.id, "the member's session follows them to the real account");
  assert.equal((await status(stray2.id)).status, "merged");
  assert.equal((await getLinkedWallet({ accountId: real2.id })).address, wallet2, "the wallet never changes account");

  // 3. Two accounts that both hold something are never combined automatically.
  const busyA = await signIn("github", "three");
  await giveWallet(busyA.id, "ThreeA");
  const busyB = await signIn("discord", "three");
  await giveWallet(busyB.id, "ThreeB");
  const refused = await link(busyA.id, "discord", "three");
  assert.deepEqual(refused, { ok: false, error: "provider_identity_conflict" }, "accounts that both hold a wallet stay separate, and the owner is not disclosed");
  assert.equal((await status(busyA.id)).status, "active");
  assert.equal((await status(busyB.id)).status, "active");
  assert.equal((await findAccountByIdentity("discord", `discord-three-${suffix}`)).id, busyB.id);

  // 4. A duplicate with real content is kept.
  const real4 = await signIn("github", "four");
  await giveWallet(real4.id, "Four");
  const used4 = await signIn("discord", "four");
  await query("INSERT INTO chat_conversations (id, account_id, title) VALUES ($1,$2,'kept')", [`conv_dup_${suffix}`, used4.id]);
  assert.equal((await link(real4.id, "discord", "four")).error, "provider_identity_conflict", "a duplicate that holds a conversation is not absorbed");
  assert.equal((await status(used4.id)).status, "active");
  await query("DELETE FROM chat_conversations WHERE id = $1", [`conv_dup_${suffix}`]);

  // 5. A blacklist entry on either side blocks the merge.
  const real5 = await signIn("github", "five");
  const stray5 = await signIn("discord", "five");
  await query("INSERT INTO account_blacklist (id, account_id, reason_code, status) VALUES ($1,$2,'smoke','active')", [`bl_dup_${suffix}`, real5.id]);
  assert.equal((await absorbEmptyDuplicateAccount({ sourceAccountId: stray5.id, targetAccountId: real5.id, reason: "smoke" })).error, "duplicate_account_blacklisted");
  assert.equal((await link(real5.id, "discord", "five")).error, "provider_identity_conflict", "a blacklisted account cannot pick up sign-ins this way");
  assert.equal((await status(stray5.id)).status, "active");
  await query("DELETE FROM reinstatement_cases WHERE blacklist_id = $1", [`bl_dup_${suffix}`]).catch(() => {});
  await query("DELETE FROM account_blacklist WHERE id = $1", [`bl_dup_${suffix}`]);

  // 6. A duplicate holding the same provider under a different identity is a different person's login.
  const real6 = await signIn("github", "six");
  const other6 = await signIn("github", "six-other", `six-${suffix}@example.test`);
  assert.equal((await link(real6.id, "discord", "six", `six-${suffix}@example.test`)).error, "provider_email_conflict", "two different GitHub identities are never folded into one account");
  assert.equal((await status(other6.id)).status, "active");

  // 7. The wallet path, with a real signature: signed in to an empty duplicate, proving the wallet
  //    of the real account. The sign-in and the session move to the wallet's account.
  const mnemonic = generateTaskNodeMnemonic();
  const real7 = await signIn("github", "seven");
  const real7Session = await createAccountSession(real7, { provider: "github", assurance: "medium" });
  const start7 = await walletLinkStart("POST", real7Session.session);
  const proof7 = signWalletChallenge(mnemonic, start7.body.challenge.message);
  wallets.push(proof7.address);
  const first7 = await walletLinkVerify({ challengeId: start7.body.challenge.id, address: proof7.address, publicKey: proof7.publicKey, signature: proof7.signature }, "POST", real7Session.session);
  assert.equal(first7.status, 200);
  assert.equal(first7.body.accountSwitched, false);
  const stray7 = await signIn("x", "seven");
  const stray7Session = await createAccountSession(stray7, { provider: "x", assurance: "medium" });
  const startStray = await walletLinkStart("POST", stray7Session.session);
  const proofStray = signWalletChallenge(mnemonic, startStray.body.challenge.message);
  const switched = await walletLinkVerify({ challengeId: startStray.body.challenge.id, address: proofStray.address, publicKey: proofStray.publicKey, signature: proofStray.signature }, "POST", stray7Session.session);
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.accountSwitched, true);
  assert.equal(switched.body.wallet.accountId, real7.id);
  assert.equal((await getSession(stray7Session.sessionId)).accountId, real7.id, "the session that proved the wallet now belongs to the wallet's account");
  assert.equal((await findAccountByIdentity("x", `x-seven-${suffix}`)).id, real7.id);
  assert.equal((await status(stray7.id)).status, "merged");
  assert.ok((await getAccount(real7.id)).linkedProviders.some((provider) => provider.id === "x"));

  // 8. The wallet path still refuses when the signed-in account has its own wallet.
  const busy8 = await signIn("discord", "eight");
  await giveWallet(busy8.id, "Eight");
  const busy8Session = await createAccountSession(busy8, { provider: "discord", assurance: "medium" });
  const start8 = await walletLinkStart("POST", busy8Session.session);
  const proof8 = signWalletChallenge(mnemonic, start8.body.challenge.message);
  const refused8 = await walletLinkVerify({ challengeId: start8.body.challenge.id, address: proof8.address, publicKey: proof8.publicKey, signature: proof8.signature }, "POST", busy8Session.session);
  assert.equal(refused8.status, 409);
  assert.equal(refused8.body.error, "wallet_owned_by_other_account");
  assert.equal(JSON.stringify(refused8.body).includes(real7.id), false, "a refusal never names the other account");
  assert.equal((await getSession(busy8Session.sessionId)).accountId, busy8.id);
  assert.equal((await status(busy8.id)).status, "active");

  console.log("duplicate account absorb smoke ok: sign-in and wallet links fold an empty duplicate into the real account in both directions; accounts with a wallet, content, a blacklist entry or a clashing login stay separate");
} finally {
  await query("DELETE FROM account_merge_events WHERE source_account_id = ANY($1::text[]) OR target_account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM user_observability_events WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM auth_sessions WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM billing_ledger_entries WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM billing_accounts WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM pftl_sync_wallets WHERE wallet_address = ANY($1::text[])", [wallets]).catch(() => {});
  await query("DELETE FROM account_linked_wallets WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM account_provider_identities WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM account_email_identities WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await query("DELETE FROM app_accounts WHERE account_id = ANY($1::text[])", [accountIds]).catch(() => {});
  await closePool();
  rmSync(tempDir, { recursive: true, force: true });
}
