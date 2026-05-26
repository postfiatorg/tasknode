import { createHash, randomUUID } from "node:crypto";

function digest(value = "") {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

export function deletedAccountArchiveId(accountId = "") {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `deleted_account_${stamp}_${digest(accountId)}`.slice(0, 120);
}

function deleteMatchingKeys(object = {}, predicate = () => false) {
  let count = 0;
  for (const key of Object.keys(object || {})) {
    if (!predicate(key, object[key])) continue;
    delete object[key];
    count += 1;
  }
  return count;
}

export function deleteRuntimeAccountDataForState({
  state,
  accountId = "",
  reason = "user_requested_account_delete",
  actorSessionId = "",
  archiveId = "",
  safeId,
} = {}) {
  const normalizedAccountId = safeId(accountId, "account");
  const account = state.accounts?.[normalizedAccountId] || null;
  const effectiveArchiveId = archiveId || deletedAccountArchiveId(normalizedAccountId);
  const emailCanonical = String(account?.primaryEmailCanonical || "").trim().toLowerCase();
  const activeDeposit = state.ethereumDepositAccounts?.[normalizedAccountId] || null;
  const walletAddress = state.accountWallets?.[normalizedAccountId]?.address || activeDeposit?.address || "";
  const hadContextDocument = Boolean(state.contextDocuments?.[normalizedAccountId]);

  const removed = {
    account: account ? 1 : 0,
    accountEmails: deleteMatchingKeys(state.accountEmails, (email, owner) => owner === normalizedAccountId || email === emailCanonical),
    accountIdentities: deleteMatchingKeys(state.accountIdentities, (key, owner) => owner === normalizedAccountId),
    sessions: deleteMatchingKeys(state.sessions, (id, session) => session?.accountId === normalizedAccountId || id === actorSessionId),
    oauthStates: deleteMatchingKeys(state.oauthStates, (id, row) => row?.linkAccountId === normalizedAccountId),
    emailChallenges: deleteMatchingKeys(state.emailChallenges, (id, challenge) => challenge?.canonicalEmail === emailCanonical),
    walletChallenges: deleteMatchingKeys(state.walletChallenges, (id, challenge) => challenge?.accountId === normalizedAccountId),
    telegramBotPreferences: deleteMatchingKeys(state.telegramBotPreferences, (id, preference) => preference?.accountId === normalizedAccountId || id.startsWith(`${normalizedAccountId}:`)),
    conversations: 0,
    ledgerEntries: 0,
    telegramBotEvents: 0,
    walletInitiationGrants: 0,
    contextDocuments: 0,
    contextHistorySnapshots: 0,
    accountWallet: state.accountWallets?.[normalizedAccountId] ? 1 : 0,
    ethereumDeposit: activeDeposit ? 1 : 0,
    retiredDepositsArchived: 0,
    authEvents: 0,
  };

  delete state.accounts[normalizedAccountId];
  delete state.accountWallets[normalizedAccountId];
  delete state.contextDocuments[normalizedAccountId];
  if (hadContextDocument) removed.contextDocuments = 1;

  removed.conversations = deleteMatchingKeys(state.conversations, (conversationId) => (
    state.conversationMeta?.[conversationId]?.accountId === normalizedAccountId ||
    conversationId.startsWith(`account_${normalizedAccountId}`)
  ));
  deleteMatchingKeys(state.conversationMeta, (conversationId, meta) => (
    meta?.accountId === normalizedAccountId || conversationId.startsWith(`account_${normalizedAccountId}`)
  ));
  removed.contextHistorySnapshots = deleteMatchingKeys(state.contextHistorySnapshots, (key, snapshot) => (
    snapshot?.accountId === normalizedAccountId || key === normalizedAccountId || key.startsWith(`${normalizedAccountId}:`)
  ));

  const beforeLedger = state.ledgerEntries.length;
  state.ledgerEntries = state.ledgerEntries.filter((entry) => entry?.accountId !== normalizedAccountId);
  removed.ledgerEntries = beforeLedger - state.ledgerEntries.length;

  const beforeTelegramBotEvents = state.telegramBotEvents?.length || 0;
  state.telegramBotEvents = (state.telegramBotEvents || []).filter((event) => event?.accountId !== normalizedAccountId);
  removed.telegramBotEvents = beforeTelegramBotEvents - state.telegramBotEvents.length;

  const beforeGrants = state.walletInitiationGrants.length;
  state.walletInitiationGrants = state.walletInitiationGrants.filter((grant) => (
    grant?.accountId !== normalizedAccountId &&
    (!walletAddress || grant?.walletAddress !== walletAddress)
  ));
  removed.walletInitiationGrants = beforeGrants - state.walletInitiationGrants.length;

  if (activeDeposit) {
    state.ethereumDepositRetiredAccounts.push({
      ...activeDeposit,
      accountId: effectiveArchiveId,
      status: "retired_account_deleted",
      retiredAt: new Date().toISOString(),
      retireReason: reason,
    });
    delete state.ethereumDepositAddressIndex[String(activeDeposit.address || "").toLowerCase()];
    delete state.ethereumDepositAccounts[normalizedAccountId];
  }
  for (const deposit of state.ethereumDepositRetiredAccounts || []) {
    if (deposit?.accountId !== normalizedAccountId) continue;
    deposit.accountId = effectiveArchiveId;
    deposit.archivedAt = deposit.archivedAt || new Date().toISOString();
    removed.retiredDepositsArchived += 1;
  }

  const beforeAuthEvents = state.authEvents.length;
  state.authEvents = state.authEvents.filter((event) => event?.accountId !== normalizedAccountId);
  removed.authEvents = beforeAuthEvents - state.authEvents.length;
  state.authEvents.push({
    id: randomUUID(),
    accountId: effectiveArchiveId,
    eventType: "account_deleted",
    provider: "account",
    email: null,
    decision: "accepted",
    metadata: { accountHash: digest(normalizedAccountId), reason },
    createdAt: new Date().toISOString(),
  });
  state.authEvents = state.authEvents.slice(-1000);

  return { ok: true, accountId: normalizedAccountId, archiveId: effectiveArchiveId, removed };
}
