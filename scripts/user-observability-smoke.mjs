import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasknode-user-observability-"));
const storePath = path.join(tempDir, "runtime-store.json");

const accountId = "acct_observability_1";
const walletOne = "rObsWalletOne1111111111111111111111111";
const walletTwo = "rObsWalletTwo2222222222222222222222222";
const now = new Date("2026-06-08T12:00:00.000Z").toISOString();

await writeFile(
  storePath,
  `${JSON.stringify({
    version: 1,
    accounts: {
      [accountId]: {
        id: accountId,
        status: "active",
        displayName: "Observer Example",
        publicDisplayName: "Observer Example",
        hiveHandle: "observer",
        profileVisibility: "public",
        primaryProvider: "telegram",
        linkedProviders: [
          {
            id: "telegram",
            kind: "oauth",
            label: "Telegram",
            username: "observer_telegram",
            displayName: "Observer Telegram",
            status: "verified",
            aliasVisibility: "private",
            linkedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      acct_observability_ambiguous_1: {
        id: "acct_observability_ambiguous_1",
        status: "active",
        displayName: "Ambiguous One",
        hiveHandle: "ambiguous_one",
        profileVisibility: "public",
        createdAt: now,
        updatedAt: now,
      },
      acct_observability_ambiguous_2: {
        id: "acct_observability_ambiguous_2",
        status: "active",
        displayName: "Ambiguous Two",
        hiveHandle: "ambiguous_two",
        profileVisibility: "public",
        createdAt: now,
        updatedAt: now,
      },
    },
    accountWallets: {
      [accountId]: {
        accountId,
        status: "linked",
        address: walletTwo,
        publicKey: "",
        tasknodeEncryptionPubkey: "",
        custody: "local_seed_required",
        linkedAt: now,
        updatedAt: now,
      },
    },
    authEvents: [
      {
        id: "auth_wallet_one_linked",
        accountId,
        eventType: "wallet_linked",
        provider: "wallet",
        decision: "accepted",
        metadata: { walletAddress: walletOne, linkedAt: now },
        createdAt: now,
      },
      {
        id: "auth_wallet_one_delinked",
        accountId,
        eventType: "wallet_delinked",
        provider: "wallet",
        decision: "accepted",
        metadata: { walletAddress: walletOne, linkedAt: now },
        createdAt: now,
      },
      {
        id: "auth_wallet_two_linked",
        accountId,
        eventType: "wallet_linked",
        provider: "wallet",
        decision: "accepted",
        metadata: { walletAddress: walletTwo, linkedAt: now },
        createdAt: now,
      },
    ],
  }, null, 2)}\n`,
  { mode: 0o600 }
);

process.env.TASKNODE_STORE_PATH = storePath;
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
delete process.env.DATABASE_URL;

try {
  const {
    identitySnapshotForEvent,
    networkTaskCapacityDecision,
    recordBillingCreditAppliedEvent,
    recordChatFailureObservability,
    recordChatTurnObservability,
    recordUserObservabilityEvent,
    resolveUserIdentityVector,
    userObservabilitySince,
  } = await import("../server/repositories/user-observability.js");
  const { userObservabilityClientEvent } = await import("../server/product-contracts.js");

  const byHandle = await resolveUserIdentityVector({ handle: "observer" });
  assert.equal(byHandle.ok, true);
  assert.equal(byHandle.identity.accountId, accountId);
  assert.equal(byHandle.identity.publicHandle, "observer");
  assert.equal(byHandle.identity.providers[0].provider, "telegram");
  assert.equal(byHandle.identity.wallets.length, 2);
  assert.deepEqual(
    byHandle.identity.wallets.map((wallet) => wallet.walletAddress).sort(),
    [walletOne, walletTwo].sort()
  );
  assert.equal(byHandle.identity.wallets.find((wallet) => wallet.walletAddress === walletTwo).status, "active");
  assert.equal(byHandle.identity.wallets.find((wallet) => wallet.walletAddress === walletOne).status, "historical");
  const eventIdentitySnapshot = identitySnapshotForEvent(byHandle.identity);
  assert.equal(eventIdentitySnapshot.providerCount, 1);
  assert.equal(eventIdentitySnapshot.providers[0].provider, "telegram");
  assert.equal(Object.hasOwn(eventIdentitySnapshot.providers[0], "username"), false);

  const byProvider = await resolveUserIdentityVector({
    provider: "telegram",
    providerUsername: "observer_telegram",
  });
  assert.equal(byProvider.ok, true);
  assert.equal(byProvider.identity.accountId, accountId);

  const unresolved = await resolveUserIdentityVector({ handle: "missing_user" });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.error, "identity_not_resolved");

  const ambiguous = await resolveUserIdentityVector({ handle: "ambiguous" });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, "identity_ambiguous");

  const walletOneDecision = networkTaskCapacityDecision({
    eligibility: {
      status: "at_capacity",
      accountId,
      walletAddress: walletOne,
      capacity: {
        available: false,
        blockers: [{ taskId: "task_wallet_one", allocationId: "netalloc_wallet_one", state: "accepted" }],
      },
    },
    metrics: {
      accountOutstandingCount: 1,
      walletOutstandingCount: 1,
      accountOnlyPendingCount: 0,
    },
  });
  assert.equal(walletOneDecision.capacity_scope_used, "wallet");
  assert.equal(walletOneDecision.eligible, false);
  assert.equal(walletOneDecision.block_reason, "wallet_has_outstanding_network_task");
  assert.equal(walletOneDecision.wallet_outstanding_count, 1);

  const walletTwoDecision = networkTaskCapacityDecision({
    eligibility: {
      status: "available_for_routing",
      accountId,
      walletAddress: walletTwo,
      capacity: { available: true, blockers: [] },
    },
    metrics: {
      accountOutstandingCount: 1,
      walletOutstandingCount: 0,
      accountOnlyPendingCount: 0,
    },
  });
  assert.equal(walletTwoDecision.capacity_scope_used, "wallet");
  assert.equal(walletTwoDecision.eligible, true);
  assert.equal(walletTwoDecision.block_reason, "");
  assert.equal(walletTwoDecision.wallet_outstanding_count, 0);
  assert.equal(walletTwoDecision.account_outstanding_count, 1);

  const accountOnlyDecision = networkTaskCapacityDecision({
    eligibility: {
      status: "at_capacity",
      accountId,
      walletAddress: walletTwo,
      capacity: { available: false, blockers: [] },
    },
    metrics: {
      accountOutstandingCount: 1,
      walletOutstandingCount: 0,
      accountOnlyPendingCount: 1,
    },
  });
  assert.equal(accountOnlyDecision.capacity_scope_used, "account");
  assert.equal(accountOnlyDecision.block_reason, "account_has_pending_network_task");

  const skippedWrite = await recordUserObservabilityEvent({
    eventType: "user.network_task.capacity_checked",
    accountId,
    walletAddress: walletOne,
    decision: walletOneDecision,
  });
  assert.equal(skippedWrite.skipped, true);
  assert.equal(skippedWrite.reason, "database_not_configured");

  const chatTurnWrite = await recordChatTurnObservability({
    accountId,
    conversationId: "conv_observability_smoke",
    mode: "standard",
    provider: "openai",
    model: "gpt-4.1-mini",
    responseId: "resp_observability_smoke",
    modelRunId: "run_observability_smoke",
    user: { id: "msg_user_observability_smoke", body: "not persisted in observability" },
    assistant: { id: "msg_assistant_observability_smoke", body: "not persisted in observability" },
    usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9, costUsd: 0.01 },
  });
  assert.equal(chatTurnWrite.ok, false);
  assert.equal(chatTurnWrite.results.length, 2);
  assert.equal(chatTurnWrite.results.every((result) => result.skipped), true);

  const chatFailureWrite = await recordChatFailureObservability({
    accountId,
    conversationId: "conv_observability_smoke",
    mode: "standard",
    provider: "openai",
    error: new Error("provider_timeout"),
  });
  assert.equal(chatFailureWrite.skipped, true);
  assert.equal(chatFailureWrite.reason, "database_not_configured");

  const creditWrite = await recordBillingCreditAppliedEvent({
    entry: {
      id: "ledger_observability_smoke",
      accountId,
      amountUsd: 5,
      source: "admin_credit",
      uniqueKey: "admin_credit:observability_smoke",
    },
  });
  assert.equal(creditWrite.skipped, true);
  assert.equal(creditWrite.reason, "database_not_configured");

  const clientEventWrite = await userObservabilityClientEvent(
    {
      eventType: "user.ui.action_disabled",
      taskId: "task_observability_smoke",
      sourceSurface: "tasks",
      sourceRoute: "smoke",
      resultStatus: "disabled",
      reasonCode: "task_detail_loading",
      metadata: {
        action: "accept",
        nested: { label: "Accept task" },
      },
    },
    "POST",
    { id: "sess_observability_smoke", accountId }
  );
  assert.equal(clientEventWrite.status, 202);
  assert.equal(clientEventWrite.body.skipped, true);
  assert.equal(clientEventWrite.body.eventType, "user.ui.action_disabled");

  const syncWarningEventWrite = await userObservabilityClientEvent(
    {
      eventType: "user.ui.sync_warning_shown",
      sourceSurface: "tasks",
      sourceRoute: "smoke",
      resultStatus: "shown",
      reasonCode: "reducer_attention",
      metrics: { failedReducerCount: 1 },
      metadata: { label: "Task sync needs attention" },
    },
    "POST",
    { id: "sess_observability_smoke", accountId }
  );
  assert.equal(syncWarningEventWrite.status, 202);
  assert.equal(syncWarningEventWrite.body.skipped, true);
  assert.equal(syncWarningEventWrite.body.eventType, "user.ui.sync_warning_shown");

  const disallowedClientEvent = await userObservabilityClientEvent(
    { eventType: "user.chat.message_sent" },
    "POST",
    { id: "sess_observability_smoke", accountId }
  );
  assert.equal(disallowedClientEvent.status, 400);
  assert.equal(disallowedClientEvent.body.error, "user_observability_event_type_not_allowed");

  assert.match(userObservabilitySince("today"), /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.ok(Date.parse(userObservabilitySince("7d")) <= Date.now());

  console.log("user-observability-smoke: ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
