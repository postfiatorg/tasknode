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
const { deriveWalletSummary, generateTaskNodeMnemonic, signWalletChallenge } = await import("../src/wallet-core.js");

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

  // 7. The wallet path, with real signatures. A restored account holds a wallet but no sign-in, so
  //    nobody can open it. Proving that wallet from an empty duplicate moves the sign-in and the
  //    session to it.
  const prove = async (session, mnemonic) => {
    const start = await walletLinkStart("POST", session.session);
    const proof = signWalletChallenge(mnemonic, start.body.challenge.message, { purpose: "wallet_proof" });
    return walletLinkVerify({ challengeId: start.body.challenge.id, address: proof.address, publicKey: proof.publicKey, signature: proof.signature }, "POST", session.session);
  };
  const addressOf = (mnemonic) => deriveWalletSummary(mnemonic).address;
  const orphanMnemonic = generateTaskNodeMnemonic();
  const orphanId = `acct_oauth_orphan_${suffix}`;
  const orphanAt = new Date().toISOString();
  await query(
    "INSERT INTO app_accounts (account_id, account_json, status, created_at, updated_at) VALUES ($1,$2::jsonb,'active',$3,$3)",
    [orphanId, JSON.stringify({ id: orphanId, status: "active", displayName: "Restored Work", profileVisibility: "public", linkedProviders: [], assurance: "low", recoverySource: "durable_profile_census", createdAt: orphanAt, updatedAt: orphanAt }), orphanAt]
  );
  accountIds.push(orphanId);
  wallets.push(addressOf(orphanMnemonic));
  assert.equal((await linkWalletToAccount({ accountId: orphanId, address: addressOf(orphanMnemonic) })).ok, true);
  const stray7 = await signIn("x", "seven");
  const stray7Session = await createAccountSession(stray7, { provider: "x", assurance: "medium" });
  const switched = await prove(stray7Session, orphanMnemonic);
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.accountSwitched, true);
  assert.equal(switched.body.wallet.accountId, orphanId);
  assert.equal((await getSession(stray7Session.sessionId)).accountId, orphanId, "the session that proved the wallet now belongs to the wallet's account");
  assert.equal((await findAccountByIdentity("x", `x-seven-${suffix}`)).id, orphanId);
  assert.equal((await status(stray7.id)).status, "merged");
  assert.equal((await status(orphanId)).account_json.recoverySource, undefined, "a reconnected account is no longer waiting to be reclaimed");
  assert.ok((await getAccount(orphanId)).linkedProviders.some((provider) => provider.id === "x"));

  // 8. A seed phrase alone never opens an account that has a sign-in of its own.
  const ownedMnemonic = generateTaskNodeMnemonic();
  const owned8 = await signIn("github", "eight");
  const owned8Session = await createAccountSession(owned8, { provider: "github", assurance: "medium" });
  wallets.push(addressOf(ownedMnemonic));
  const first8 = await prove(owned8Session, ownedMnemonic);
  assert.equal(first8.status, 200);
  assert.equal(first8.body.accountSwitched, false);
  const intruder8 = await signIn("discord", "eight-intruder");
  const intruder8Session = await createAccountSession(intruder8, { provider: "discord", assurance: "medium" });
  const refused8 = await prove(intruder8Session, ownedMnemonic);
  assert.equal(refused8.status, 409);
  assert.equal(refused8.body.error, "wallet_owned_by_other_account");
  assert.equal(JSON.stringify(refused8.body).includes(owned8.id), false, "a refusal never names the other account");
  assert.equal((await getSession(intruder8Session.sessionId)).accountId, intruder8.id, "the intruder's session stays on their own account");
  assert.equal((await status(intruder8.id)).status, "active");
  assert.equal((await findAccountByIdentity("discord", `discord-eight-intruder-${suffix}`)).id, intruder8.id);

  // 9. An account with a wallet of its own is not folded into a restored account either.
  const orphan9Mnemonic = generateTaskNodeMnemonic();
  const orphan9Id = `acct_oauth_orphan9_${suffix}`;
  await query(
    "INSERT INTO app_accounts (account_id, account_json, status, created_at, updated_at) VALUES ($1,$2::jsonb,'active',$3,$3)",
    [orphan9Id, JSON.stringify({ id: orphan9Id, status: "active", displayName: "Restored Work", profileVisibility: "public", linkedProviders: [], assurance: "low", createdAt: orphanAt, updatedAt: orphanAt }), orphanAt]
  );
  accountIds.push(orphan9Id);
  wallets.push(addressOf(orphan9Mnemonic));
  assert.equal((await linkWalletToAccount({ accountId: orphan9Id, address: addressOf(orphan9Mnemonic) })).ok, true);
  const busy9 = await signIn("discord", "nine");
  await giveWallet(busy9.id, "Nine");
  const busy9Session = await createAccountSession(busy9, { provider: "discord", assurance: "medium" });
  assert.equal((await prove(busy9Session, orphan9Mnemonic)).body.error, "wallet_owned_by_other_account");
  assert.equal((await status(busy9.id)).status, "active");

  // 10. Credit beyond the untouched sign-up credit is the member's, so that account is kept.
  const real10 = await signIn("github", "ten");
  const credited10 = await signIn("discord", "ten");
  await query(
    `INSERT INTO billing_accounts (account_id, current_credit_usd, ledger_entry_count) VALUES ($1,25,1)
     ON CONFLICT (account_id) DO UPDATE SET current_credit_usd = 25`,
    [credited10.id]
  );
  await query(
    "INSERT INTO billing_ledger_entries (id, account_id, kind, amount_usd, source) VALUES ($1,$2,'account_credit',20,'admin_credit')",
    [`ledger_dup_${suffix}`, credited10.id]
  );
  assert.equal((await absorbEmptyDuplicateAccount({ sourceAccountId: credited10.id, targetAccountId: real10.id, reason: "smoke" })).error, "duplicate_account_has_activity");
  const kept10 = await link(real10.id, "discord", "ten");
  assert.equal(kept10.account.id, credited10.id, "the account holding the credit is the one that survives");
  assert.equal(Number((await query("SELECT current_credit_usd FROM billing_accounts WHERE account_id = $1", [credited10.id])).rows[0].current_credit_usd), 25);
  assert.equal((await query("SELECT status FROM billing_accounts WHERE account_id = $1", [credited10.id])).rows[0].status, "active");

  // 11. Ownership seen before the merge is checked again inside it.
  const real11 = await signIn("github", "eleven");
  const stray11 = await signIn("discord", "eleven");
  assert.equal((await absorbEmptyDuplicateAccount({
    sourceAccountId: stray11.id, targetAccountId: real11.id, reason: "smoke",
    expectations: [{ kind: "identity", provider: "discord", providerUserId: `discord-eleven-${suffix}`, accountId: real11.id }],
  })).error, "duplicate_account_ownership_changed");
  assert.equal((await status(stray11.id)).status, "active");

  // 12. A retired account is closed for good: no session, no wallet, no sign-in can attach to it.
  const lateSession = await createAccountSession(stray, { provider: "discord", assurance: "medium" });
  assert.equal(await getSession(lateSession.sessionId), null, "a session issued for a retired account is not honoured");
  assert.equal((await linkWalletToAccount({ accountId: stray.id, address: `rDuplicateLate${suffix}` })).error, "wallet_account_retired");
  assert.equal((await link(stray.id, "telegram", "late")).error, "account_not_found");

  console.log("duplicate account absorb smoke ok: sign-in and wallet links fold an empty duplicate into the real account in both directions; a wallet proof reconnects only an account with no sign-in; accounts with a wallet, content, credit, a blacklist entry or a clashing login stay separate, and retired accounts stay closed");
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
