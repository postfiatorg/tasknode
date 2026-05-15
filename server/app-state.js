export function appState() {
  return {
    generatedAt: new Date().toISOString(),
    session: {
      status: "signed_out",
      displayName: null,
      primaryProvider: null,
      accountLinks: [
        { provider: "Telegram", status: "available" },
        { provider: "Discord", status: "available" },
        { provider: "X", status: "available" },
        { provider: "Email", status: "available" },
      ],
      walletLink: {
        status: "not_linked",
        mode: "seed_based_pftl",
        canDelinkForTesting: true,
      },
    },
    chat: {
      recents: [
        "Ship Task Node dev baseline",
        "Review seed wallet flow",
        "Draft usage ledger",
      ],
      defaultMode: "Private Instant",
      modes: [
        {
          label: "Private Instant",
          privacy: "Zero-data-retention provider route",
          latency: "Fast",
        },
        {
          label: "Private Thinking",
          privacy: "Zero-data-retention reasoning route",
          latency: "Deep",
        },
        {
          label: "Frontier Instant",
          privacy: "Frontier provider route",
          latency: "Fast",
        },
        {
          label: "Frontier Thinking",
          privacy: "Frontier provider reasoning route",
          latency: "Deep",
        },
      ],
      seedMessages: [
        {
          role: "assistant",
          body:
            "Task Node dev is live. The next product boundary is account-first execution: chat, tasks, wallet, context, and usage state come from the app server before legacy PFTasks code is wired in.",
        },
      ],
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
      chatCreditUsd: 0,
      pftWallet: {
        status: "not_linked",
        custody: "local_seed_required",
        signingRequiredFor: [
          "Send PFT",
          "Sign PFT verifications",
          "Ink context manifests to PFTL pointers",
        ],
      },
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
      currentSpendUsd: 0,
      currentPeriod: "Dev session",
      controls: [
        "Show estimated cost before expensive actions",
        "Confirm large context imports and deep reasoning calls",
        "Make all credits, debits, rewards, and refunds ledger-backed",
      ],
    },
    context: {
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
