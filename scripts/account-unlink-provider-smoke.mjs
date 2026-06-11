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
  findAccountByIdentity,
  getOrCreateProviderAccount,
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

console.log("account unlink provider smoke ok");
