import { accountWalletCloudFacts } from "./runtime-store.js";

function addCandidate(candidates, address = "", patch = {}) {
  const normalizedAddress = String(address || "").trim();
  if (!normalizedAddress) return;
  const existing = candidates.get(normalizedAddress) || {
    address: normalizedAddress,
    status: "historical",
    sources: [],
    linkedAt: null,
    updatedAt: null,
  };
  candidates.set(normalizedAddress, {
    ...existing,
    ...patch,
    address: normalizedAddress,
    status: patch.status || existing.status,
    sources: Array.from(new Set([...(existing.sources || []), ...(patch.sources || [])])),
    linkedAt: patch.linkedAt || existing.linkedAt || null,
    updatedAt: patch.updatedAt || existing.updatedAt || null,
  });
}

function activeOwnersForAddress(activeWallets = {}, address = "", exceptAccountId = "") {
  const normalizedAddress = String(address || "").trim();
  if (!normalizedAddress) return [];
  return Object.entries(activeWallets).filter(([ownerAccountId, wallet]) => {
    if (ownerAccountId === exceptAccountId) return false;
    return wallet?.status === "linked" && String(wallet.address || "").trim() === normalizedAddress;
  });
}

export function getAccountWalletCloud({ accountId = "" } = {}) {
  const facts = accountWalletCloudFacts({ accountId });
  const candidates = new Map();
  const activeWallet = facts.activeWallet || null;
  if (activeWallet?.status === "linked" && activeWallet?.address) {
    addCandidate(candidates, activeWallet.address, {
      status: "linked",
      sources: ["active_link"],
      linkedAt: activeWallet.linkedAt || null,
      updatedAt: activeWallet.updatedAt || null,
    });
  }

  for (const event of facts.authEvents || []) {
    const eventType = String(event.eventType || "");
    const walletAddress = event.metadata?.walletAddress || "";
    const previousWalletAddress = event.metadata?.previousWalletAddress || "";
    if (eventType === "wallet_reclaimed_from_account") {
      candidates.delete(String(walletAddress || "").trim());
      continue;
    }
    if (["wallet_linked", "wallet_relinked", "wallet_delinked"].includes(eventType)) {
      addCandidate(candidates, walletAddress, {
        status: eventType === "wallet_delinked" ? "historical" : "linked_history",
        sources: [eventType],
        linkedAt: event.metadata?.linkedAt || event.createdAt || null,
        updatedAt: event.createdAt || null,
      });
    }
    if (eventType === "wallet_relinked" && previousWalletAddress) {
      addCandidate(candidates, previousWalletAddress, {
        status: "historical",
        sources: ["wallet_relinked_previous"],
        updatedAt: event.createdAt || null,
      });
    }
  }

  const wallets = Array.from(candidates.values())
    .filter((wallet) => activeOwnersForAddress(facts.activeWallets, wallet.address, facts.accountId).length === 0)
    .sort((left, right) => {
      if (left.address === activeWallet?.address) return -1;
      if (right.address === activeWallet?.address) return 1;
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    });

  return {
    accountId: facts.accountId,
    activeWalletAddress: activeWallet?.status === "linked" ? activeWallet.address || "" : "",
    wallets,
  };
}
