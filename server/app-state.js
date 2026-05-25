import {
  authProviders,
  chatModes,
  contextActions,
  devAuthStatus,
  readiness,
  usageActions,
  walletActions,
} from "./product-contracts.js";
import { ethereumDepositConfigStatus, publicDepositAccount } from "./ethereum-deposits.js";
import {
  conversationIdForSession,
  getEthereumDepositAccount,
  getLinkedWallet,
  resolveWalletInitiationGrantStatus,
} from "./runtime-store.js";
import {
  getHiveConversation,
  getChatMessages,
  listChatConversations,
  usageSummary,
} from "./repositories/chat-billing.js";
import {
  getContextDocument,
  getContextHistory,
} from "./repositories/context.js";
import { listTaskState } from "./repositories/tasks.js";
import { refreshLinkedWalletTaskProjection } from "./task-projection-refresh.js";

const signedOutUsageSummary = Object.freeze({
  currentSpendUsd: 0,
  currentCreditUsd: 0,
  availableCreditUsd: 0,
  ledgerEntryCount: 0,
});

function sessionState(session, providers, runtimeReadiness, linkedWallet) {
  const base = {
    accountLinks: providers,
    devAuth: devAuthStatus(),
    walletLink: {
      status: linkedWallet?.status || "not_linked",
      address: linkedWallet?.address || null,
      mode: "seed_based_pftl",
      canDelinkForTesting: true,
      seedStorageReady: runtimeReadiness.wallet.seedStorageReady,
      challengeProofReady: runtimeReadiness.wallet.challengeProofReady,
    },
  };

  if (!session) {
    return {
      ...base,
      status: "signed_out",
      displayName: null,
      primaryProvider: null,
      linkedProviders: [],
    };
  }

  return {
    ...base,
    ...session,
    status: "signed_in",
  };
}

export async function appState(session = null, { refreshTaskProjection = false } = {}) {
  const providers = authProviders();
  const runtimeReadiness = await readiness();
  const modes = chatModes();
  const accountId = session?.accountId || "";
  const enabledMode =
    modes.find((mode) => mode.label === "Frontier Instant" && mode.enabled) ||
    modes.find((mode) => mode.enabled);
  const conversationId = conversationIdForSession(session);
  const usage = accountId
    ? await usageSummary({ accountId, conversationId })
    : signedOutUsageSummary;
  const linkedWallet = getLinkedWallet({ accountId });
  const ethDepositStatus = ethereumDepositConfigStatus();
  const ethDepositAccount = getEthereumDepositAccount({ accountId });
  const walletLinked = linkedWallet.status === "linked" && Boolean(linkedWallet.address);
  const initiationGift = await resolveWalletInitiationGrantStatus({
    accountId,
    walletAddress: walletLinked ? linkedWallet.address : "",
  });
  const usdcTopUpInitiationGift = walletLinked
    ? await resolveWalletInitiationGrantStatus({
        accountId,
        walletAddress: linkedWallet.address,
        source: "usdc_top_up",
      })
    : {
        eligible: false,
        reason: walletLinked ? null : "wallet_not_linked",
        amountPft: initiationGift.amountPft,
        amountDrops: initiationGift.amountDrops,
        message: "Create and link a wallet before the USDC top-up grant can be sent.",
      };
  if (refreshTaskProjection && walletLinked) {
    await refreshLinkedWalletTaskProjection({
      accountId,
      walletAddress: linkedWallet.address,
      syncKind: "task_list_refresh",
    });
  }
  const tasks = await listTaskState({
    accountId,
    walletAddress: walletLinked ? linkedWallet.address : "",
  });

  return {
    generatedAt: new Date().toISOString(),
    session: sessionState(session, providers, runtimeReadiness, linkedWallet),
    chat: {
      conversationId,
      conversationsPath: "/api/chat/conversations",
      historyPath: "/api/chat/history",
      recents: accountId ? await listChatConversations({ accountId }) : [],
      hiveConversation: accountId ? await getHiveConversation({ accountId }) : null,
      defaultMode: enabledMode?.label || "Private Instant",
      modes,
      seedMessages: accountId ? await getChatMessages({ accountId, conversationId }) : [],
    },
    tasks,
    wallet: {
      pftBalanceDrops: walletLinked ? null : 0,
      pftBalanceStatus: walletLinked ? "checking" : "not_linked",
      pftBalanceSource: null,
      pftBalanceFetchedAt: null,
      pftBalancePath: "/api/wallet/balance",
      pftTransactionsPath: "/api/wallet/transactions",
      lifecycle: {
        oneWalletPerAccount: true,
        delinkForTestingRequired: true,
        relinkRequiresOwnershipProof: true,
        localSeedStorageReady: runtimeReadiness.wallet.seedStorageReady,
      },
      pftWallet: {
        ...linkedWallet,
        pftlRpcConfigured: runtimeReadiness.wallet.pftlRpcConfigured,
        seedStorageReady: runtimeReadiness.wallet.seedStorageReady,
        challengeProofReady: runtimeReadiness.wallet.challengeProofReady,
        signingRequiredFor: [
          "Send PFT",
          "Sign PFT verifications",
          "Ink context manifests to PFTL pointers",
        ],
      },
      actions: walletActions(),
      initiationGift,
      usdcTopUpInitiationGift,
      chatCreditUsd: usage.availableCreditUsd,
      fundingRails: [
        {
          label: "Ethereum mainnet deposit address",
          status: ethDepositStatus.status,
          note:
            "Account-scoped custodial receive address for ETH, USDC, and USDT. No wallet-connect or user withdrawal surface.",
        },
      ],
      ethereumDeposit: publicDepositAccount(ethDepositAccount),
    },
    usage: {
      billingModel: "usage_based",
      currentSpendUsd: usage.currentSpendUsd,
      currentCreditUsd: usage.currentCreditUsd,
      availableCreditUsd: usage.availableCreditUsd,
      currentPeriod: "Dev session",
      estimatePath: "/api/chat/estimate",
      chatSendPath: "/api/chat/send",
      chatStreamPath: "/api/chat/stream",
      actionsPath: "/api/usage/actions",
      fundingActions: usageActions(),
      ethereumDeposit: publicDepositAccount(ethDepositAccount),
      chatEstimateReady: runtimeReadiness.billing.chatEstimateReady,
      chatExecutionReady: runtimeReadiness.billing.chatExecutionReady,
      adminCreditReady: runtimeReadiness.billing.adminCreditReady,
      ledgerReady: runtimeReadiness.billing.ledgerReady,
      durableLedgerReady: runtimeReadiness.billing.durableLedgerReady,
      ledgerEntryCount: usage.ledgerEntryCount,
      controls: [
        "Show estimated cost before expensive actions",
        "Confirm large context imports and deep reasoning calls",
        "Make all credits, debits, rewards, and refunds ledger-backed",
      ],
    },
    context: {
      actions: contextActions(),
      document: await getContextDocument({ accountId: session?.accountId || "" }),
      history: await getContextHistory({
        accountId: session?.accountId || "",
        walletAddress: walletLinked ? linkedWallet.address : "",
      }),
      savePath: "/api/context/edit/save",
      historyPath: "/api/context/history",
      importReady: runtimeReadiness.context.importReady,
      editReady: runtimeReadiness.context.editReady,
      historyCacheReady: runtimeReadiness.context.historyCacheReady,
      encryptedCidHydrationReady: runtimeReadiness.context.encryptedCidHydrationReady,
      manifestInkReady: runtimeReadiness.context.manifestInkReady,
      sources: [
        {
          label: "PFT Context",
          status: runtimeReadiness.context.historyCacheReady ? "cache projection ready" : "supported later",
          note:
            "PFTL wallet sync stores account transactions in Postgres; reducer events project encrypted context CIDs into the context history read model.",
        },
        {
          label: "Google Docs share link",
          status: "research",
          note:
            "Import via shared URL without forcing Google login for the first release path.",
        },
        {
          label: "Notion shared document",
          status: "research",
          note:
            "Evaluate current Notion backend hooks before promising native edit support.",
        },
      ],
      manifestPolicy:
        "Context is useful before wallet setup. Users explicitly choose when to ink a PFTL pointer manifest.",
    },
  };
}
