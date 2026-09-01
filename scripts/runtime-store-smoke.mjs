import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-runtime-store-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
delete process.env.CHAT_MODEL_FRONTIER_INSTANT;
delete process.env.CHAT_MODEL_FRONTIER_THINKING;
delete process.env.CHAT_MODEL_PRIVATE_INSTANT;
delete process.env.CHAT_MODEL_PRIVATE_THINKING;
delete process.env.CHAT_MODEL_HELP;
process.env.OPENAI_MODEL = "generic-openai-smoke-model";
process.env.OPENROUTER_API_KEY = "runtime-smoke-openrouter-key";
process.env.DEEPSEEK_API_KEY = "runtime-smoke-deepseek-key";
process.env.AMBIENT_API_KEY = "runtime-smoke-ambient-key";
delete process.env.OPENROUTER_MODEL;
delete process.env.DEEPSEEK_CHAT_MODEL;
delete process.env.OPENROUTER_CHAT_ENABLED;
delete process.env.TASKNODE_ENABLE_OPENROUTER_CHAT;
delete process.env.DEEPSEEK_CHAT_ENABLED;
delete process.env.TASKNODE_ENABLE_DEEPSEEK_CHAT;
delete process.env.TASKNODE_PFT_FAUCET_SEED;
delete process.env.FAUCET_SEED;
delete process.env.PFTL_FAUCET_WSS_URL;
delete process.env.PFTL_FAUCET_WSS_URL_FALLBACKS;

try {
  const { HDNodeWallet } = await import("ethers");
  const depositReceiveNode = HDNodeWallet.fromPhrase(
    "test test test test test test test test test test test junk",
    undefined,
    "m/44'/60'/0'/0"
  );
  process.env.ETH_DEPOSIT_XPUB = depositReceiveNode.neuter().extendedKey;
  process.env.ETH_DEPOSIT_ETH_USD_PRICE = "2000";
  process.env.ETH_DEPOSIT_START_INDEX = "1";

  const {
    actualChatCost,
    chatExecutionStatus,
    modelForMode,
  } = await import("../server/chat-router.js");
  const {
    appendUsageCredit,
    appendChatTurn,
    createAccountSession,
    deleteAccountRuntimeData,
    deleteChatConversation,
    delinkWalletFromAccount,
    getContextDocument,
    getContextHistory,
    getAccountProfileVisibility,
    getEthereumDepositAccount,
    getLinkedWallet,
    getOrCreateEmailAccount,
    getOrCreateProviderAccount,
    linkWalletToAccount,
    listChatConversations,
    renameChatConversation,
    completeWalletInitiationGrant,
    reserveWalletInitiationGrant,
    saveContextDocument,
    saveContextHistoryProjection,
    updateEthereumDepositSync,
    usageSummary,
    walletInitiationGrantStatus,
  } = await import("../server/runtime-store.js");
  const {
    getAccountWalletCloud,
  } = await import("../server/account-wallet-cloud.js");
  const {
    chatModes,
    usageActions,
    walletActionStart,
    walletCreateStart,
    walletLinkStart,
    walletLinkVerify,
    walletRelinkStart,
    usageTopUpStart,
    usageTopUpSync,
  } = await import("../server/product-contracts.js");
  const {
    generateTaskNodeMnemonic,
    signWalletChallenge,
  } = await import("../src/wallet-core.js");
  const { appState } = await import("../server/app-state.js");

  if (modelForMode("Instant") !== "deepseek/deepseek-v4-flash-0731") {
    throw new Error("Instant must default to Ambient DeepSeek V4 Flash 7/31.");
  }
  if (modelForMode("Thinking") !== "z-ai/glm-5.2") {
    throw new Error("Thinking must default to Ambient GLM 5.2.");
  }
  if (modelForMode("Help") !== "deepseek/deepseek-v4-flash-0731") {
    throw new Error("Help must default to Ambient DeepSeek V4 Flash 7/31.");
  }
  if (!chatExecutionStatus("Instant").enabled || !chatExecutionStatus("Thinking").enabled) {
    throw new Error("Canonical Ambient chat modes should be enabled when Ambient is configured.");
  }
  const canonicalModeLabels = chatModes().map((mode) => mode.label);
  if (canonicalModeLabels.join(",") !== "Instant,Thinking,Help") {
    throw new Error(`Only canonical chat modes should be exposed: ${canonicalModeLabels.join(", ")}`);
  }


  const { runEthereumDepositSmoke } = await import("./ethereum-deposit-smoke.mjs");
  await runEthereumDepositSmoke({
    appendChatTurn,
    appendUsageCredit,
    depositReceiveNode,
    getEthereumDepositAccount,
    getOrCreateEmailAccount,
    linkWalletToAccount,
    updateEthereumDepositSync,
    usageActions,
    usageTopUpStart,
    usageTopUpSync,
  });

  const first = appendUsageCredit({
    accountId: "acct_runtime_smoke",
    amountUsd: 5,
    source: "initial_provider_credit",
    note: "runtime smoke",
    uniqueKey: "initial_provider_credit:acct_runtime_smoke",
  });
  const replay = appendUsageCredit({
    accountId: "acct_runtime_smoke",
    amountUsd: 5,
    source: "initial_provider_credit",
    note: "runtime smoke replay",
    uniqueKey: "initial_provider_credit:acct_runtime_smoke",
  });
  const summary = usageSummary({ accountId: "acct_runtime_smoke" });

  if (!first?.id || replay?.id !== first.id || replay?.idempotentReplay !== true) {
    throw new Error("Initial provider credit is not idempotent.");
  }

  if (summary.currentCreditUsd !== 5 || summary.ledgerEntryCount !== 1) {
    throw new Error(`Unexpected credit summary: ${JSON.stringify(summary)}`);
  }

  const oauthAccount = getOrCreateProviderAccount({
    provider: "github",
    providerUserId: "runtime-smoke-gh",
    username: "runtime-smoke",
  });
  if (oauthAccount.profileVisibility !== "public") {
    throw new Error(`OAuth accounts should default public: ${JSON.stringify(oauthAccount)}`);
  }
  const createFlowAccount = getOrCreateProviderAccount({
    provider: "github",
    providerUserId: "runtime-smoke-create-gh",
    username: "runtime-smoke-create",
  });
  const createFlowSession = createAccountSession(createFlowAccount, { provider: "github", assurance: "medium" });
  const createStart = await walletCreateStart("POST", createFlowSession.session);
  const createMnemonic = generateTaskNodeMnemonic();
  const createProof = signWalletChallenge(createMnemonic, createStart.body.challenge.message);
  const createVerify = await walletLinkVerify({
    challengeId: createStart.body.challenge.id,
    address: createProof.address,
    publicKey: createProof.publicKey,
    signature: createProof.signature,
  }, "POST", createFlowSession.session);
  const createLinkedWallet = getLinkedWallet({ accountId: createFlowAccount.id });
  if (
    createStart.status !== 200 ||
    createStart.body.challenge.accountId !== createFlowAccount.id ||
    createStart.body.challenge.purpose !== "wallet_create" ||
    createVerify.status !== 200 ||
    createLinkedWallet.status !== "linked" ||
    createLinkedWallet.address !== createProof.address ||
    createVerify.body.initiationGift?.status !== "local_vault_required"
  ) {
    throw new Error(`Create wallet flow did not link with a local-vault gate: ${JSON.stringify({ createStart, createVerify, createLinkedWallet })}`);
  }
  const retryWithoutVault = await walletActionStart(
    "/api/wallet/initiation/retry",
    "POST",
    createFlowSession.session
  );
  if (
    retryWithoutVault.status !== 409 ||
    retryWithoutVault.body?.error !== "local_vault_confirmation_required"
  ) {
    throw new Error(`Initiation retry should require local vault confirmation: ${JSON.stringify(retryWithoutVault)}`);
  }
  const retryWithoutFaucet = await walletActionStart(
    "/api/wallet/initiation/retry",
    "POST",
    createFlowSession.session,
    { localVaultConfirmed: true }
  );
  if (
    retryWithoutFaucet.status !== 502 ||
    retryWithoutFaucet.body?.initiationGift?.reason !== "faucet_not_configured"
  ) {
    throw new Error(`Initiation retry should report faucet configuration without relinking: ${JSON.stringify(retryWithoutFaucet)}`);
  }

  const linkFlowAccount = getOrCreateProviderAccount({ provider: "github", providerUserId: "runtime-smoke-link-gh", username: "runtime-smoke-link" });
  const linkFlowSession = createAccountSession(linkFlowAccount, { provider: "github", assurance: "medium" });
  const linkStart = await walletLinkStart("POST", linkFlowSession.session);
  const linkProof = signWalletChallenge(generateTaskNodeMnemonic(), linkStart.body.challenge.message);
  const linkVerify = await walletLinkVerify({ challengeId: linkStart.body.challenge.id, address: linkProof.address, publicKey: linkProof.publicKey, signature: linkProof.signature }, "POST", linkFlowSession.session);
  const linkLinkedWallet = getLinkedWallet({ accountId: linkFlowAccount.id });
  if (linkStart.status !== 200 || linkStart.body.challenge.accountId !== linkFlowAccount.id || linkStart.body.challenge.purpose !== "wallet_link" || linkVerify.status !== 200 || linkLinkedWallet.status !== "linked" || linkLinkedWallet.address !== linkProof.address) {
    throw new Error(`Link wallet flow did not persist linked proof: ${JSON.stringify({ linkStart, linkVerify, linkLinkedWallet })}`);
  }
  const relinkStart = await walletRelinkStart("POST", linkFlowSession.session);
  if (relinkStart.status !== 200 || relinkStart.body.challenge.accountId !== linkFlowAccount.id || relinkStart.body.challenge.purpose !== "wallet_relink") {
    throw new Error(`Relink wallet challenge lost its account binding: ${JSON.stringify(relinkStart)}`);
  }
  const retryAfterLink = await walletActionStart("/api/wallet/initiation/retry", "POST", linkFlowSession.session, { localVaultConfirmed: true });
  if (retryAfterLink.status !== 409 || retryAfterLink.body?.initiationGift?.reason !== "wallet_create_proof_required") {
    throw new Error(`Initiation retry must reject linked-only wallets: ${JSON.stringify(retryAfterLink)}`);
  }
  const emailAccount = getOrCreateEmailAccount({ email: "runtime-smoke@example.com", canonicalEmail: "runtime-smoke@example.com", maskedEmail: "r***@example.com" });
  const emailSession = createAccountSession(emailAccount, { provider: "email", assurance: "low" });
  if (
    emailAccount.profileVisibility !== "public" ||
    emailSession.session.profileVisibility !== "public" ||
    getAccountProfileVisibility({ accountId: emailAccount.id }).visibility !== "public"
  ) {
    throw new Error(`Email accounts and sessions should default public: ${JSON.stringify({ emailAccount, emailSession })}`);
  }
  const emailGift = walletInitiationGrantStatus({ accountId: emailAccount.id });
  if (emailGift.eligible || emailGift.reason !== "email_ineligible") {
    throw new Error(`Email-only accounts must not be initiation-gift eligible: ${JSON.stringify(emailGift)}`);
  }
  const emailTopUpGrantAccount = getOrCreateEmailAccount({ email: "runtime-smoke-usdc-grant@example.com", canonicalEmail: "runtime-smoke-usdc-grant@example.com", maskedEmail: "r***@example.com" });
  linkWalletToAccount({ accountId: emailTopUpGrantAccount.id, address: "rRuntimeSmokeUsdcTopUpGrant1111111", publicKey: "runtime-smoke-usdc-topup-pubkey", challengeId: "runtime-smoke-usdc-topup-challenge", signature: "runtime-smoke-usdc-topup-signature", proofPurpose: "wallet_create" });
  const emailTopUpGift = walletInitiationGrantStatus({ accountId: emailTopUpGrantAccount.id, walletAddress: "rRuntimeSmokeUsdcTopUpGrant1111111", source: "usdc_top_up" });
  if (!emailTopUpGift.eligible || emailTopUpGift.amountPft !== 12) {
    throw new Error(`Email account with a created wallet should be USDC top-up grant eligible: ${JSON.stringify(emailTopUpGift)}`);
  }
  linkWalletToAccount({ accountId: emailTopUpGrantAccount.id, address: "rRuntimeSmokeUsdcTopUpGrant1111111", publicKey: "runtime-smoke-usdc-topup-relink-pubkey", challengeId: "runtime-smoke-usdc-topup-relink-challenge", signature: "runtime-smoke-usdc-topup-relink-signature", proofPurpose: "wallet_relink" });
  const relinkedWallet = getLinkedWallet({ accountId: emailTopUpGrantAccount.id });
  const relinkedTopUpGift = walletInitiationGrantStatus({ accountId: emailTopUpGrantAccount.id, walletAddress: relinkedWallet.address, source: "usdc_top_up" });
  if (relinkedWallet.walletCreatedInAccount !== true || !relinkedTopUpGift.eligible || relinkedTopUpGift.amountPft !== 12) {
    throw new Error(`Relinked created wallet should remain USDC top-up grant eligible: ${JSON.stringify({ relinkedWallet, relinkedTopUpGift })}`);
  }
  const reservedTopUpGift = await reserveWalletInitiationGrant({
    accountId: emailTopUpGrantAccount.id,
    walletAddress: "rRuntimeSmokeUsdcTopUpGrant1111111",
    amountDrops: emailTopUpGift.amountDrops,
    amountPft: emailTopUpGift.amountPft,
    source: "usdc_top_up",
    trigger: {
      asset: "USDC",
      amountUsd: 12.34,
      ledgerEntryId: "ledger_runtime_smoke_usdc_topup",
      depositAccountId: "ethdep_runtime_smoke_usdc_topup",
      topUpUniqueKey: "ethereum_deposit:ethdep_runtime_smoke_usdc_topup:USDC:12340000",
    },
  });
  if (
    !reservedTopUpGift.ok ||
    reservedTopUpGift.grant.status !== "processing" ||
    reservedTopUpGift.grant.source !== "usdc_top_up"
  ) {
    throw new Error(`USDC top-up grant was not reserved for an email account: ${JSON.stringify(reservedTopUpGift)}`);
  }
  await completeWalletInitiationGrant({ grantId: reservedTopUpGift.internalGrant.id, txHash: "RUNTIME_SMOKE_USDC_TOPUP_INIT_TX", faucetAddress: "rRuntimeSmokeFaucet" });
  const replayTopUpGift = walletInitiationGrantStatus({ accountId: emailTopUpGrantAccount.id, walletAddress: "rRuntimeSmokeUsdcTopUpGrant1111111", source: "usdc_top_up" });
  if (replayTopUpGift.eligible || replayTopUpGift.reason !== "account_registered") {
    throw new Error(`USDC top-up grant must be account-idempotent: ${JSON.stringify(replayTopUpGift)}`);
  }
  const firstGiftStatus = walletInitiationGrantStatus({
    accountId: oauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInit1111111111111",
  });
  if (!firstGiftStatus.eligible || firstGiftStatus.amountPft !== 12) {
    throw new Error(`OAuth account should be eligible for one wallet initiation gift: ${JSON.stringify(firstGiftStatus)}`);
  }
  const reservedGift = await reserveWalletInitiationGrant({
    accountId: oauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInit1111111111111",
    amountDrops: firstGiftStatus.amountDrops,
    amountPft: firstGiftStatus.amountPft,
  });
  if (!reservedGift.ok || reservedGift.grant.status !== "processing") {
    throw new Error(`Wallet initiation grant was not reserved: ${JSON.stringify(reservedGift)}`);
  }
  const completedGift = await completeWalletInitiationGrant({
    grantId: reservedGift.internalGrant.id,
    txHash: "RUNTIME_SMOKE_INIT_TX",
    faucetAddress: "rRuntimeSmokeFaucet",
  });
  if (!completedGift.ok || completedGift.grant.status !== "completed") {
    throw new Error(`Wallet initiation grant was not completed: ${JSON.stringify(completedGift)}`);
  }
  const replayGift = walletInitiationGrantStatus({
    accountId: oauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInit1111111111111",
  });
  if (replayGift.eligible || replayGift.reason !== "account_registered") {
    throw new Error(`Wallet initiation grant must be account-idempotent: ${JSON.stringify(replayGift)}`);
  }
  const deletedGiftAccount = deleteAccountRuntimeData({
    accountId: oauthAccount.id,
    archiveId: "deleted_account_runtime_smoke_oauth",
    actorSessionId: "runtime-smoke-session",
    reason: "runtime_smoke_recreate_guard",
  });
  if (!deletedGiftAccount.ok || deletedGiftAccount.removed.accountDeletionAudit !== 1) {
    throw new Error(`Account deletion should create a deletion audit record: ${JSON.stringify(deletedGiftAccount)}`);
  }
  const recreatedOauthAccount = getOrCreateProviderAccount({
    provider: "github",
    providerUserId: "runtime-smoke-gh",
    username: "runtime-smoke",
  });
  const recreatedGift = walletInitiationGrantStatus({
    accountId: recreatedOauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInitReplay111111",
  });
  if (recreatedGift.eligible || recreatedGift.reason !== "deleted_account_faucet_guard") {
    throw new Error(`Deleted account identity must not be eligible for another initiation grant: ${JSON.stringify(recreatedGift)}`);
  }
  process.env.TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_ACCOUNT_IDS = recreatedOauthAccount.id;
  const exemptRecreatedGift = walletInitiationGrantStatus({
    accountId: recreatedOauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInitReplay111111",
  });
  delete process.env.TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_ACCOUNT_IDS;
  if (!exemptRecreatedGift.eligible) {
    throw new Error(`Configured QA account exemption should allow recycled account testing: ${JSON.stringify(exemptRecreatedGift)}`);
  }

  const persistedChat = appendChatTurn({
    accountId: "acct_runtime_smoke",
    conversationId: "account_acct_runtime_smoke_default",
    mode: "Frontier Instant",
    provider: "openai",
    model: "chat-latest",
    responseId: "runtime-smoke-response",
    userMessage: "Bill this message.",
    assistantMessage: "Billed.",
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      costUsd: actualChatCost("Frontier Instant", { inputTokens: 120, outputTokens: 30 }),
    },
  });
  const debitedSummary = usageSummary({ accountId: "acct_runtime_smoke" });
  const expectedDebit = actualChatCost("Frontier Instant", { inputTokens: 120, outputTokens: 30 });

  if (
    !persistedChat.ledgerEntry ||
    persistedChat.ledgerEntry.kind !== "chat_debit" ||
    debitedSummary.currentSpendUsd !== expectedDebit ||
    debitedSummary.availableCreditUsd !== Number((5 - expectedDebit).toFixed(6))
  ) {
    throw new Error(
      `Usage debit did not affect available balance: ${JSON.stringify({ persistedChat, debitedSummary })}`
    );
  }

  appendChatTurn({
    accountId: "acct_runtime_smoke",
    conversationId: "account_acct_runtime_smoke_mutation",
    mode: "Frontier Instant",
    provider: "openai",
    model: "chat-latest",
    responseId: "runtime-smoke-mutation",
    userMessage: "Rename this chat.",
    assistantMessage: "Ready.",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  });

  const renamedChat = renameChatConversation({
    accountId: "acct_runtime_smoke",
    conversationId: "account_acct_runtime_smoke_mutation",
    title: "Renamed runtime smoke chat",
  });
  const renamedList = listChatConversations({ accountId: "acct_runtime_smoke" });

  if (
    !renamedChat.ok ||
    !renamedList.some((chat) => chat.conversationId === "account_acct_runtime_smoke_mutation" && chat.title === "Renamed runtime smoke chat")
  ) {
    throw new Error(`Chat rename did not persist: ${JSON.stringify({ renamedChat, renamedList })}`);
  }

  const deletedChat = deleteChatConversation({
    accountId: "acct_runtime_smoke",
    conversationId: "account_acct_runtime_smoke_mutation",
  });
  const deletedList = listChatConversations({ accountId: "acct_runtime_smoke" });

  if (
    !deletedChat.ok ||
    deletedList.some((chat) => chat.conversationId === "account_acct_runtime_smoke_mutation")
  ) {
    throw new Error(`Chat delete did not remove the conversation: ${JSON.stringify({ deletedChat, deletedList })}`);
  }

  const savedContext = saveContextDocument({
    accountId: "acct_runtime_smoke",
    title: "Runtime smoke context",
    body: "This account-scoped context remains available without a linked wallet.",
  });

  if (!savedContext.ok) {
    throw new Error(`Native context did not save: ${JSON.stringify(savedContext)}`);
  }

  const projected = saveContextHistoryProjection({
    accountId: "acct_runtime_smoke",
    projection: {
      walletAddress: "rSmokeWalletAddress",
      contextRevisions: [
        {
          id: "ctx-1",
          cid: "ipfs://bafyContextSmoke",
          tx_hash: "ABC123",
          created_at: "2026-05-16T00:00:00.000Z",
          word_count: 42,
        },
      ],
      tasks: [
        {
          id: "task-1",
          title: "Private task title",
          status: "rewarded",
          verification_type: "text",
        },
      ],
      taskEvents: [
        {
          id: "event-1",
          task_id: "task-1",
          event_type: "submission_recorded",
          event_payload: JSON.stringify({
            artifact_cid: "ipfs://bafyEvidenceSmoke",
            response_text: "PRIVATE EVIDENCE TEXT MUST NOT BE STORED",
          }),
          created_at: "2026-05-16T00:01:00.000Z",
        },
      ],
    },
  });
  const unlinkedContext = getContextDocument({ accountId: "acct_runtime_smoke" });
  const unlinkedHistory = getContextHistory({ accountId: "acct_runtime_smoke" });
  const history = getContextHistory({
    accountId: "acct_runtime_smoke",
    walletAddress: "rSmokeWalletAddress",
  });
  const otherWalletHistory = getContextHistory({
    accountId: "acct_runtime_smoke",
    walletAddress: "rDifferentSmokeWallet",
  });
  const serializedHistory = JSON.stringify(history);

  if (!projected.ok || history.contextUpdateCount !== 1 || history.taskEventCount !== 1) {
    throw new Error(`Unexpected context history summary: ${serializedHistory}`);
  }

  if (unlinkedContext.revision !== 1 || unlinkedHistory.contextUpdateCount !== 0 || unlinkedHistory.canHydrate) {
    throw new Error(
      `Unlinked context/history boundary failed: ${JSON.stringify({ unlinkedContext, unlinkedHistory })}`
    );
  }

  if (otherWalletHistory.contextUpdateCount !== 0 || otherWalletHistory.pointerCount !== 0) {
    throw new Error(`Wallet-scoped history leaked to another wallet: ${JSON.stringify(otherWalletHistory)}`);
  }

  const accountSession = { accountId: "acct_runtime_smoke" };
  const linked = linkWalletToAccount({
    accountId: accountSession.accountId,
    address: "rSmokeWalletAddress",
    publicKey: "smoke-public-key",
    challengeId: "smoke-challenge",
    signature: "smoke-signature",
  });
  const linkedState = await appState(accountSession);

  if (!linked.ok || linkedState.context.history.contextUpdateCount !== 1) {
    throw new Error(`Linked wallet history did not appear: ${JSON.stringify(linkedState.context.history)}`);
  }

  const delinked = delinkWalletFromAccount({ accountId: accountSession.accountId });
  const delinkedState = await appState(accountSession);

  if (
    !delinked.ok ||
    delinkedState.context.document.revision !== 1 ||
    delinkedState.context.history.pointerCount !== 0 ||
    delinkedState.context.history.canHydrate
  ) {
    throw new Error(`Delinked app state boundary failed: ${JSON.stringify(delinkedState.context)}`);
  }

  const relinked = linkWalletToAccount({
    accountId: accountSession.accountId,
    address: "rSmokeWalletAddress",
    publicKey: "smoke-public-key",
    challengeId: "smoke-challenge-2",
    signature: "smoke-signature-2",
    proofPurpose: "wallet_relink",
  });
  const relinkedState = await appState(accountSession);

  if (!relinked.ok || relinkedState.context.history.contextUpdateCount !== 1) {
    throw new Error(`Relinked wallet history did not reappear: ${JSON.stringify(relinkedState.context.history)}`);
  }

  delinkWalletFromAccount({ accountId: accountSession.accountId });
  const linkedOther = linkWalletToAccount({
    accountId: accountSession.accountId,
    address: "rDifferentSmokeWallet",
    publicKey: "smoke-public-key-3",
    challengeId: "smoke-challenge-3",
    signature: "smoke-signature-3",
    proofPurpose: "wallet_relink",
  });
  const otherLinkedState = await appState(accountSession);

  if (!linkedOther.ok || otherLinkedState.context.history.pointerCount !== 0) {
    throw new Error(`Different linked wallet saw old history: ${JSON.stringify(otherLinkedState.context.history)}`);
  }
  const accountWalletCloud = getAccountWalletCloud({ accountId: accountSession.accountId });
  const cloudAddresses = accountWalletCloud.wallets.map((wallet) => wallet.address).sort();
  if (
    accountWalletCloud.activeWalletAddress !== "rDifferentSmokeWallet" ||
    !cloudAddresses.includes("rSmokeWalletAddress") ||
    !cloudAddresses.includes("rDifferentSmokeWallet")
  ) {
    throw new Error(`Account wallet cloud did not retain linked-wallet history: ${JSON.stringify(accountWalletCloud)}`);
  }

  const reclaimAddress = "rReclaimSmokeWallet";
  const firstOwner = linkWalletToAccount({
    accountId: "acct_reclaim_owner_a",
    address: reclaimAddress,
    publicKey: "smoke-reclaim-public-key",
    challengeId: "smoke-reclaim-challenge-a",
    signature: "smoke-reclaim-signature-a",
  });
  const reclaimed = linkWalletToAccount({
    accountId: "acct_reclaim_owner_b",
    address: reclaimAddress,
    publicKey: "smoke-reclaim-public-key",
    challengeId: "smoke-reclaim-challenge-b",
    signature: "smoke-reclaim-signature-b",
    proofPurpose: "wallet_relink",
  });
  const firstOwnerWallet = getLinkedWallet({ accountId: "acct_reclaim_owner_a" });
  const secondOwnerWallet = getLinkedWallet({ accountId: "acct_reclaim_owner_b" });

  if (
    !firstOwner.ok ||
    reclaimed.ok ||
    reclaimed.error !== "wallet_owned_by_other_account" ||
    firstOwnerWallet.status !== "linked" ||
    firstOwnerWallet.address !== reclaimAddress ||
    secondOwnerWallet.status !== "not_linked"
  ) {
    throw new Error(
      `Wallet ownership conflict boundary failed: ${JSON.stringify({ firstOwner, reclaimed, firstOwnerWallet, secondOwnerWallet })}`
    );
  }
  const firstOwnerCloud = getAccountWalletCloud({ accountId: "acct_reclaim_owner_a" });
  if (!firstOwnerCloud.wallets.some((wallet) => wallet.address === reclaimAddress)) {
    throw new Error(`Rejected wallet transfer altered the owner cloud: ${JSON.stringify(firstOwnerCloud)}`);
  }

  if (!history.latestContextPointer?.cid || history.latestContextPointer.cid !== "bafyContextSmoke") {
    throw new Error("Latest context pointer was not normalized.");
  }

  if (!serializedHistory.includes("bafyEvidenceSmoke")) {
    throw new Error("Projected task event CID was not retained.");
  }

  if (serializedHistory.includes("PRIVATE EVIDENCE TEXT MUST NOT BE STORED")) {
    throw new Error("Context history projection leaked raw event payload text.");
  }

  console.log("runtime store smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
