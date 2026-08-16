function exportClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function exportRuntimeAccountDataForState({ state = {}, accountId = "", safeId } = {}) {
  const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
  const conversationIds = new Set(Object.entries(state.conversationMeta || {})
    .filter(([, meta]) => meta?.accountId === normalizedAccountId)
    .map(([conversationId]) => conversationId));
  const scopedObject = (source = {}) => Object.fromEntries(Object.entries(source || {})
    .filter(([key, value]) => key === normalizedAccountId || value?.accountId === normalizedAccountId));
  return exportClone({
    account: state.accounts?.[normalizedAccountId] || null,
    linkedWallet: state.accountWallets?.[normalizedAccountId] || null,
    ethereumDepositAccount: state.ethereumDepositAccounts?.[normalizedAccountId] || null,
    retiredEthereumDepositAccounts: (state.ethereumDepositRetiredAccounts || [])
      .filter((entry) => entry?.accountId === normalizedAccountId),
    contextDocument: state.contextDocuments?.[normalizedAccountId] || null,
    contextHistorySnapshots: scopedObject(state.contextHistorySnapshots),
    conversations: Object.fromEntries([...conversationIds]
      .map((conversationId) => [conversationId, state.conversations?.[conversationId] || []])),
    conversationMetadata: Object.fromEntries([...conversationIds]
      .map((conversationId) => [conversationId, state.conversationMeta?.[conversationId] || {}])),
    ledgerEntries: (state.ledgerEntries || []).filter((entry) => entry?.accountId === normalizedAccountId),
    telegramBotPreferences: scopedObject(state.telegramBotPreferences),
    telegramBotEvents: (state.telegramBotEvents || []).filter((entry) => entry?.accountId === normalizedAccountId),
    walletInitiationGrants: (state.walletInitiationGrants || []).filter((entry) => entry?.accountId === normalizedAccountId),
    authEvents: (state.authEvents || []).filter((entry) => entry?.accountId === normalizedAccountId),
  });
}
