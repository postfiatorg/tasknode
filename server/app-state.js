import {
  authProviders,
  chatModes,
  contextActions,
  devAuthStatus,
  readiness,
  usageActions,
  walletActions,
} from "./product-contracts.js";
import { getChatMessages, usageSummary } from "./runtime-store.js";

function sessionState(session, providers, runtimeReadiness) {
  const base = {
    accountLinks: providers,
    devAuth: devAuthStatus(),
    walletLink: {
      status: "not_linked",
      mode: "seed_based_pftl",
      canDelinkForTesting: true,
      seedStorageReady: runtimeReadiness.wallet.seedStorageReady,
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

export function appState(session = null) {
  const providers = authProviders();
  const runtimeReadiness = readiness();
  const modes = chatModes();
  const enabledMode = modes.find((mode) => mode.enabled);
  const usage = usageSummary();

  return {
    generatedAt: new Date().toISOString(),
    session: sessionState(session, providers, runtimeReadiness),
    chat: {
      recents: [
        "Ship Task Node dev baseline",
        "Review seed wallet flow",
        "Draft usage ledger",
      ],
      defaultMode: enabledMode?.label || "Private Instant",
      modes,
      seedMessages: getChatMessages("dev"),
    },
    tasks: {
      personalRequestEnabled: true,
      networkRequestEnabled: false,
      alphaRequestEnabled: false,
      dailyRewardCap: 8,
      outstanding: [
        {
          id: "tn-dev-001",
          title: "Wire account-first login contract",
          kind: "Personal",
          status: "Next",
          pft: 3600,
          due: "Dev milestone",
          summary:
            "Define account session, provider links, and seed-wallet onboarding surfaces without requiring wallet authentication for normal app access.",
        },
        {
          id: "tn-dev-002",
          title: "Specify seed wallet storage and delink flow",
          kind: "Personal",
          status: "Research",
          pft: 3000,
          due: "Security gate",
          summary:
            "Choose local seed storage, backup, recovery, delink, and relink rules before any real PFTL signing UI ships.",
        },
      ],
      routed: [
        {
          id: "routed-network",
          title: "Network and alpha tasks will appear here when routed",
          kind: "Routed",
          status: "Receive only",
          summary:
            "Users can receive network and alpha work in this app, but cannot request those task classes through the personal task path.",
        },
      ],
    },
    wallet: {
      pftBalanceDrops: 0,
      lifecycle: {
        oneWalletPerAccount: true,
        delinkForTestingRequired: true,
        relinkRequiresOwnershipProof: true,
        localSeedStorageReady: runtimeReadiness.wallet.seedStorageReady,
      },
      pftWallet: {
        status: "not_linked",
        custody: "local_seed_required",
        pftlRpcConfigured: runtimeReadiness.wallet.pftlRpcConfigured,
        seedStorageReady: runtimeReadiness.wallet.seedStorageReady,
        signingRequiredFor: [
          "Send PFT",
          "Sign PFT verifications",
          "Ink context manifests to PFTL pointers",
        ],
      },
      actions: walletActions(),
      chatCreditUsd: usage.availableCreditUsd,
      fundingRails: [
        {
          label: "USDC or USDT deposit address",
          status: "research",
          note: "Candidate safest top-up path if per-user addresses can be operated cleanly.",
        },
        {
          label: "MetaMask funding",
          status: "research",
          note: "Funding rail only; not the core PFTL wallet path.",
        },
        {
          label: "Phantom funding",
          status: "research",
          note: "Funding rail only; chain and settlement flow still need a decision.",
        },
      ],
    },
    usage: {
      billingModel: "usage_based",
      currentSpendUsd: usage.currentSpendUsd,
      currentCreditUsd: usage.currentCreditUsd,
      availableCreditUsd: usage.availableCreditUsd,
      currentPeriod: "Dev session",
      estimatePath: "/api/chat/estimate",
      chatSendPath: "/api/chat/send",
      actionsPath: "/api/usage/actions",
      fundingActions: usageActions(),
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
      importReady: runtimeReadiness.context.importReady,
      editReady: runtimeReadiness.context.editReady,
      manifestInkReady: runtimeReadiness.context.manifestInkReady,
      sources: [
        {
          label: "PFT Context",
          status: "supported later",
          note:
            "Existing PFDocs/PFT pointer behavior should be preserved for portable manifests.",
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
