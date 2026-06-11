import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.TASKNODE_STORE_PATH = path.join(
  await mkdtemp(path.join(os.tmpdir(), "tasknode-unlink-smoke-")),
  "runtime-store.json"
);
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_AUTH_SECRET = "account-unlink-smoke-secret";

const runtime = await import("../server/runtime-store.js");
const {
  createAccountSession,
  findAccountByEmail,
  findAccountByIdentity,
  getOrCreateProviderAccount,
  getSession,
  linkProviderToAccount,
  unlinkProviderFromAccount,
} = runtime;

// Account created from a Discord identity, then a GitHub identity linked on.
const account = getOrCreateProviderAccount({
  provider: "discord",
  providerUserId: "discord-wrong-account",
  username: "wrongdiscord",
});
assert.ok(account?.id);
const linkResult = linkProviderToAccount({
  accountId: account.id,
  provider: "github",
  providerUserId: "github-user-1",
  username: "kenobi",
});
assert.equal(linkResult.ok, true);

// Unsupported and unknown providers are refused.
assert.equal(unlinkProviderFromAccount({ accountId: account.id, provider: "email" }).error, "provider_unlink_unsupported");
assert.equal(unlinkProviderFromAccount({ accountId: account.id, provider: "x" }).error, "provider_not_linked");
assert.equal(unlinkProviderFromAccount({ accountId: "acct_missing", provider: "discord" }).error, "account_not_found");

// Unlinking Discord works while GitHub remains as a login method.
const unlinked = unlinkProviderFromAccount({ accountId: account.id, provider: "discord" });
assert.equal(unlinked.ok, true);
assert.equal(unlinked.provider, "discord");
assert.equal(unlinked.remainingLoginMethods, 1);
assert.ok(!unlinked.account.linkedProviders.some((item) => item?.id === "discord"));

// The identity mapping is freed: lookup no longer resolves, and the same
// Discord identity can now create/attach to a different account.
assert.equal(findAccountByIdentity("discord", "discord-wrong-account"), null);
const otherAccount = getOrCreateProviderAccount({
  provider: "discord",
  providerUserId: "discord-wrong-account",
  username: "wrongdiscord",
});
assert.ok(otherAccount?.id);
assert.notEqual(otherAccount.id, account.id);

// primaryProvider was discord; it must have been reassigned to a remaining method.
const refreshed = unlinked.account;
assert.notEqual(refreshed.primaryProvider, "discord");

// Lockout guard: GitHub is now the only login method (no verified email), so
// unlinking it is refused.
const blocked = unlinkProviderFromAccount({ accountId: account.id, provider: "github" });
assert.equal(blocked.ok, false);
assert.equal(blocked.error, "provider_unlink_last_login_method");
assert.ok(
  findAccountByIdentity("github", "github-user-1")?.id === account.id,
  "blocked unlink must not free the identity"
);

// Double unlink reports not linked.
assert.equal(unlinkProviderFromAccount({ accountId: account.id, provider: "discord" }).error, "provider_not_linked");

// --- Verified-email scenarios (the codex P1 repro) ---

// Discord founds the account AND supplies a verified email.
const emailAccount = getOrCreateProviderAccount({
  provider: "discord",
  providerUserId: "discord-email-user",
  username: "emailuser",
  emailInfo: { email: "kenobi@example.com", verified: true },
});
assert.ok(emailAccount?.id);
assert.equal(findAccountByEmail("kenobi@example.com")?.id, emailAccount.id);

// Lockout: discord is the only provider and the email is discord-owned, so
// the email is not an independent login method and unlink is refused.
assert.equal(
  unlinkProviderFromAccount({ accountId: emailAccount.id, provider: "discord" }).error,
  "provider_unlink_last_login_method"
);

// Link GitHub, then unlink Discord: identity AND the discord-owned email
// mapping must both be freed.
assert.equal(
  linkProviderToAccount({ accountId: emailAccount.id, provider: "github", providerUserId: "github-user-2" }).ok,
  true
);
const sessionBefore = createAccountSession(
  { ...emailAccount, primaryProvider: "discord", linkedProviders: [] },
  { provider: "discord" }
);
const emailUnlink = unlinkProviderFromAccount({ accountId: emailAccount.id, provider: "discord" });
assert.equal(emailUnlink.ok, true);
assert.equal(emailUnlink.remainingLoginMethods, 1);
assert.equal(findAccountByIdentity("discord", "discord-email-user"), null);
assert.equal(findAccountByEmail("kenobi@example.com"), null, "discord-owned email mapping must be freed");
assert.ok(!emailUnlink.account.primaryEmailCanonical, "provider-owned email leaves with the provider");

// Fresh Discord login with the same id + verified email founds a NEW account
// instead of re-entering the old one through the email bridge.
const freshLogin = getOrCreateProviderAccount({
  provider: "discord",
  providerUserId: "discord-email-user",
  username: "emailuser",
  emailInfo: { email: "kenobi@example.com", verified: true },
});
assert.ok(freshLogin?.id);
assert.notEqual(freshLogin.id, emailAccount.id, "fresh login must not re-enter the unlinked account");

// The freed identity+email can also link to a different account without
// provider_email_conflict (checked against a third account).
const properAccount = getOrCreateProviderAccount({
  provider: "github",
  providerUserId: "github-user-3",
  username: "proper",
});
const relinkElsewhere = linkProviderToAccount({
  accountId: properAccount.id,
  provider: "x",
  providerUserId: "x-user-1",
  emailInfo: { email: "kenobi@example.com", verified: true },
});
assert.equal(relinkElsewhere.ok, false, "email now belongs to the fresh-login account");
assert.equal(relinkElsewhere.error, "provider_email_conflict");

// Session sync (the codex P2): the live session must not keep a stale
// primaryProvider after the primary is unlinked.
const syncedSession = getSession(sessionBefore.sessionId);
assert.equal(syncedSession?.primaryProvider, "github");
assert.ok(!(syncedSession?.linkedProviders || []).some((item) => item?.id === "discord"));

// Email heir: when two providers verified the same email and the owner is
// unlinked, the mapping transfers to the remaining provider instead of
// being dropped.
const heirAccount = getOrCreateProviderAccount({
  provider: "discord",
  providerUserId: "discord-heir-user",
  emailInfo: { email: "heir@example.com", verified: true },
});
assert.equal(
  linkProviderToAccount({
    accountId: heirAccount.id,
    provider: "github",
    providerUserId: "github-heir-user",
    emailInfo: { email: "heir@example.com", verified: true },
  }).ok,
  true
);
// github supplied the email last, so it owns it; unlink github -> discord inherits.
const heirUnlink = unlinkProviderFromAccount({ accountId: heirAccount.id, provider: "github" });
assert.equal(heirUnlink.ok, true);
assert.equal(findAccountByEmail("heir@example.com")?.id, heirAccount.id, "shared email must survive via the heir");
assert.equal(heirUnlink.account.emailProvider, "discord");
assert.equal(heirUnlink.account.primaryEmailCanonical, "heir@example.com");

console.log("account unlink provider smoke ok");
