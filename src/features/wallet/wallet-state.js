export function walletVaultDisplayState(walletVault = {}, linkedWalletAddress = "") {
  const hasLinkedWallet = Boolean(String(linkedWalletAddress || walletVault?.address || "").trim());
  if (walletVault?.unlocked) {
    return {
      tone: "unlocked",
      label: "Unlocked",
      detail: "Local seed vault is unlocked for this browser session.",
    };
  }
  if (walletVault?.available) {
    return {
      tone: "locked",
      label: "Locked",
      detail: "Encrypted local seed vault is saved on this device.",
    };
  }
  if (hasLinkedWallet) {
    return {
      tone: "missing",
      label: "Vault missing",
      detail: "Wallet ownership is linked, but no encrypted local seed vault is saved in this browser.",
    };
  }
  return {
    tone: "missing",
    label: "No wallet",
    detail: "Link a seed wallet before restoring encrypted historical context.",
  };
}

function linkedWalletAddressFromState(state) {
  const wallet = state?.wallet?.pftWallet || {};
  return wallet.status === "linked" ? wallet.address || "" : "";
}

function hasClientPftBalance(wallet) {
  return wallet?.pftBalanceDrops !== null &&
    wallet?.pftBalanceDrops !== undefined &&
    wallet?.pftBalanceDrops !== "";
}

export function mergeAppStateWithClientWalletBalance(current, next) {
  if (!current || !next) return next;
  const currentAddress = linkedWalletAddressFromState(current);
  const nextAddress = linkedWalletAddressFromState(next);
  if (!currentAddress || currentAddress !== nextAddress) return next;
  if (next?.wallet?.pftBalanceStatus !== "checking") return next;
  if (!hasClientPftBalance(current.wallet)) return next;

  return {
    ...next,
    wallet: {
      ...next.wallet,
      pftBalanceDrops: current.wallet.pftBalanceDrops,
      pftBalanceStatus: current.wallet.pftBalanceStatus,
      pftBalanceSource: current.wallet.pftBalanceSource,
      pftBalanceFetchedAt: current.wallet.pftBalanceFetchedAt,
      pftBalanceAccountExists: current.wallet.pftBalanceAccountExists,
      pftBalanceError: current.wallet.pftBalanceError || "",
    },
  };
}

function sameLinkedWallet(current, address) {
  return current?.wallet?.pftWallet?.status === "linked" && current.wallet.pftWallet.address === address;
}

export function markWalletBalanceChecking(current, address) {
  if (!sameLinkedWallet(current, address)) return current;

  return {
    ...current,
    wallet: {
      ...current.wallet,
      pftBalanceStatus: current.wallet.pftBalanceDrops == null ? "checking" : current.wallet.pftBalanceStatus,
      pftBalanceError: "",
    },
  };
}

export function applyWalletBalanceResult(current, address, result) {
  if (!sameLinkedWallet(current, address)) return current;

  if (!result?.ok || !result.body?.ok) {
    return applyWalletBalanceError(
      current,
      address,
      result?.body?.message || result?.body?.error || "Balance read failed."
    );
  }

  return {
    ...current,
    wallet: {
      ...current.wallet,
      pftBalanceDrops: result.body.balanceDrops,
      pftBalanceStatus: "ready",
      pftBalanceSource: result.body.source || "",
      pftBalanceFetchedAt: result.body.fetchedAt || new Date().toISOString(),
      pftBalanceAccountExists: result.body.accountExists !== false,
      pftBalanceError: "",
    },
  };
}

export function applyWalletBalanceError(current, address, message) {
  if (!sameLinkedWallet(current, address)) return current;

  return {
    ...current,
    wallet: {
      ...current.wallet,
      pftBalanceStatus: "error",
      pftBalanceError: message,
    },
  };
}

function formatDrops(value) {
  const numeric = Number(value || 0) / 1_000_000;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(numeric);
}

export function formatPftBalance(wallet) {
  const drops = wallet?.pftBalanceDrops;
  if (drops === null || drops === undefined || drops === "") {
    if (wallet?.pftBalanceStatus === "error") return "Unavailable";
    if (wallet?.pftBalanceStatus === "checking") return "Checking";
    return "0";
  }

  return formatDrops(drops);
}

export function walletBalanceStatusLabel(wallet) {
  if (wallet?.pftBalanceStatus === "checking") return "Checking balance";
  if (wallet?.pftBalanceStatus === "error") return "Balance unavailable";
  if (wallet?.pftBalanceStatus === "ready") return "";
  return "Balance unavailable";
}

export function formatWalletTransactionAmount(tx) {
  const drops = Number(tx?.amountDrops || 0);
  const pft = Math.abs(drops) / 1_000_000;
  const sign = tx?.type === "in" ? "+" : tx?.type === "out" ? "-" : "";
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: pft > 0 && pft < 0.01 ? 6 : 0,
    maximumFractionDigits: pft > 0 && pft < 0.01 ? 6 : 2,
  }).format(pft);
  return `${sign}${formatted}`;
}

export function formatWalletTransactionTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatWalletTransactionGroup(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "Unknown";

  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfTxDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfTxDay) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function groupWalletTransactions(transactions = []) {
  const groups = [];
  const byLabel = new Map();
  for (const tx of transactions) {
    const group = formatWalletTransactionGroup(tx?.createdAt);
    if (!byLabel.has(group)) {
      const nextGroup = { group, items: [] };
      byLabel.set(group, nextGroup);
      groups.push(nextGroup);
    }
    byLabel.get(group).items.push(tx);
  }
  return groups;
}

export function truncateWalletNote(value) {
  const text = String(value || "").trim();
  if (text.length <= 46) return text;
  return `${text.slice(0, 22)}...${text.slice(-12)}`;
}
