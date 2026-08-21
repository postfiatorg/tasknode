import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.TASKNODE_STORE_PATH = path.join(
  await mkdtemp(path.join(os.tmpdir(), "tasknode-qa-worker-access-")),
  "runtime-store.json"
);
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_AUTH_SECRET = "qa-worker-access-smoke-secret";
process.env.TASKNODE_EMAIL_DEV_DELIVERY = "true";
process.env.TASKNODE_INITIAL_PROVIDER_CREDIT_USD = "0";

const { appState } = await import("../server/app-state.js");
const {
  createAccountSession,
  getOrCreateEmailAccount,
  linkProviderToAccount,
} = await import("../server/runtime-store.js");
const { appendUsageCredit } = await import("../server/repositories/chat-billing.js");

const account = getOrCreateEmailAccount({
  email: "qa-worker@example.test",
  canonicalEmail: "qa-worker@example.test",
});
assert.ok(account?.id, "email account should be created");

const telegramLink = linkProviderToAccount({
  accountId: account.id,
  provider: "telegram",
  providerUserId: "qa-worker-telegram",
  username: "qa_worker_tg",
  displayName: "QA Worker Telegram",
});
assert.equal(telegramLink.ok, true, "telegram should link");

const discordLink = linkProviderToAccount({
  accountId: account.id,
  provider: "discord",
  providerUserId: "qa-worker-discord",
  username: "qa_worker_discord",
  displayName: "QA Worker Discord",
});
assert.equal(discordLink.ok, true, "discord should link");

const { session } = createAccountSession(discordLink.account, {
  provider: "discord",
  assurance: "medium",
});

const linkedState = await appState(session);
const linkedAliases = linkedState.session.identityProfile.aliases.map((alias) => alias.provider).sort();
assert.deepEqual(linkedAliases, ["discord", "telegram"], "telegram and discord should project into identity aliases");
assert.equal(
  linkedState.session.identityProfile.qaWorkerAccess.usdcTopUp,
  false,
  "linked providers without a USDC top-up should not qualify"
);

await appendUsageCredit({
  accountId: account.id,
  amountUsd: 12,
  source: "ethereum_deposit",
  uniqueKey: "ethereum_deposit:qa-worker:usdt",
  metadata: { asset: "USDT" },
});
const nonUsdcState = await appState(session);
assert.equal(
  nonUsdcState.session.identityProfile.qaWorkerAccess.usdcTopUp,
  false,
  "non-USDC top-up should not qualify"
);

await appendUsageCredit({
  accountId: account.id,
  amountUsd: 12,
  source: "ethereum_deposit",
  uniqueKey: "ethereum_deposit:qa-worker:usdc",
  metadata: { asset: "USDC" },
});
const usdcState = await appState(session);
assert.equal(
  usdcState.session.identityProfile.qaWorkerAccess.usdcTopUp,
  true,
  "USDC chat wallet top-up should qualify"
);
assert.equal(
  usdcState.session.identityProfile.qaWorkerAccess.proofMethod,
  "billing_ledger_usdc_top_up",
  "proof method should describe the objective backend source"
);

console.log("qa_worker_access_smoke ok");
