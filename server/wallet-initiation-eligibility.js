import {
  accountDeletionEmailHash,
  faucetProviderIdentityHash,
  findRuntimeBlockingAccountDeletionAudit,
} from "./account-deletion-audit.js";

export function walletInitiationAmountPft() {
  const amount = Number(process.env.TASKNODE_WALLET_INITIATION_PFT || 12);
  if (!Number.isFinite(amount) || amount <= 0) return 12;
  return Math.min(amount, 100);
}

export function walletInitiationAmountDrops() {
  return String(Math.round(walletInitiationAmountPft() * 1_000_000));
}

function walletInitiationIdentities(account) {
  const linked = Array.isArray(account?.linkedProviders) ? account.linkedProviders : [];
  return linked
    .filter((provider) => {
      const id = String(provider?.id || "").trim().toLowerCase();
      if (!id || id === "email" || id === "dev" || id === "wallet") return false;
      return provider?.kind === "oauth" && provider?.providerUserId;
    })
    .map((provider) => ({
      provider: String(provider.id || "").trim().toLowerCase(),
      providerUserId: String(provider.providerUserId || "").trim(),
      providerUserIdHash: faucetProviderIdentityHash(provider.id, provider.providerUserId),
      username: provider.username || null,
    }));
}

function walletInitiationEmailHash(account) {
  return accountDeletionEmailHash(account?.primaryEmailCanonical || "");
}

export function publicWalletInitiationGrant(grant) {
  if (!grant) return null;
  return {
    id: grant.id,
    status: grant.status,
    accountId: grant.accountId,
    walletAddress: grant.walletAddress,
    amountPft: grant.amountPft,
    amountDrops: grant.amountDrops,
    source: grant.source || "wallet_create",
    txHash: grant.txHash || null,
    provider: grant.provider || null,
    trigger: grant.trigger && typeof grant.trigger === "object" && !Array.isArray(grant.trigger) ? grant.trigger : undefined,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    error: grant.error || null,
  };
}

export function walletInitiationGrantStatusForState({
  accountId = "",
  walletAddress = "",
  source = "wallet_create",
  state = {},
  safeId,
  walletCreatedInAccountForRecord,
} = {}) {
  const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
  const normalizedWalletAddress = String(walletAddress || "").trim();
  const normalizedSource = String(source || "wallet_create").trim().toLowerCase();
  const amountPft = walletInitiationAmountPft();
  const amountDrops = walletInitiationAmountDrops();
  const unavailable = (reason, message, extra = {}) => ({ eligible: false, reason, amountPft, amountDrops, message, ...extra });
  const available = (extra = {}) => ({ eligible: true, reason: null, amountPft, amountDrops, ...extra });
  if (!normalizedAccountId) return unavailable("login_required", "Sign in with GitHub, X, Telegram, or Discord before claiming the wallet initiation gift.");
  const account = state.accounts?.[normalizedAccountId];
  if (!account) return unavailable("account_not_found", "The signed-in account was not found.");
  const identities = walletInitiationIdentities(account);
  const emailHash = walletInitiationEmailHash(account);
  const deletionAudit = findRuntimeBlockingAccountDeletionAudit({
    state,
    accountId: normalizedAccountId,
    walletAddress: normalizedWalletAddress,
    providerIdentityHashes: identities.map((identity) => identity.providerUserIdHash),
    emailHash,
  });
  if (deletionAudit) {
    return unavailable(
      "deleted_account_faucet_guard",
      "This sign-in identity previously deleted a Task Node account and is not eligible for another wallet initiation gift.",
      { deletionAudit }
    );
  }

  const activeGrants = (state.walletInitiationGrants || []).filter((grant) => (
    grant && ["processing", "completed", "unknown"].includes(grant.status)
  ));
  const latestAccountGrant = activeGrants
    .filter((grant) => grant?.accountId === normalizedAccountId)
    .sort((left, right) => (Date.parse(right.updatedAt || right.createdAt || "") || 0) - (Date.parse(left.updatedAt || left.createdAt || "") || 0))[0] || null;
  if (latestAccountGrant) {
    const message = latestAccountGrant.status === "completed"
      ? "This account already received its wallet initiation gift."
      : "This account already has a wallet initiation gift in progress.";
    return unavailable("account_registered", message, { grant: publicWalletInitiationGrant(latestAccountGrant) });
  }

  const walletRegistered = (address) => {
    const walletGrant = activeGrants.find((grant) => grant.walletAddress === address);
    return walletGrant ? unavailable("wallet_registered", "This wallet address is already registered for a wallet initiation gift.", { grant: publicWalletInitiationGrant(walletGrant) }) : null;
  };
  if (normalizedSource === "usdc_top_up") {
    const linkedWallet = state.accountWallets?.[normalizedAccountId] || null;
    if (!linkedWallet?.address || linkedWallet.status !== "linked") return unavailable("wallet_not_linked", "Create and link a PFT wallet before the USDC top-up grant can be sent.");
    if (normalizedWalletAddress && linkedWallet.address !== normalizedWalletAddress) return unavailable("wallet_mismatch", "The linked wallet does not match the wallet selected for the USDC top-up grant.");
    if (linkedWallet.proof?.purpose !== "wallet_create" && !walletCreatedInAccountForRecord(normalizedAccountId, linkedWallet)) return unavailable("wallet_create_proof_required", "The USDC top-up PFT grant is only available for wallets created in this account.");
    const walletBlock = walletRegistered(linkedWallet.address);
    if (walletBlock) return walletBlock;
    return available({ source: "usdc_top_up", provider: "ethereum_usdc_top_up", identities: [], emailHash, message: `${amountPft.toLocaleString("en-US")} PFT grant available after a qualifying USDC top-up.` });
  }

  if (identities.length === 0) {
    const reason = account.primaryProvider === "email" ? "email_ineligible" : "provider_required";
    const message = account.primaryProvider === "email"
      ? "Email-only accounts can receive the PFT wallet initiation gift after creating a wallet and crediting more than $10 USDC."
      : "Sign in with GitHub, X, Telegram, or Discord before claiming the wallet initiation gift.";
    return unavailable(reason, message);
  }
  if (normalizedWalletAddress) {
    const walletBlock = walletRegistered(normalizedWalletAddress);
    if (walletBlock) return walletBlock;
  }
  const identityHashSet = new Set(identities.map((identity) => identity.providerUserIdHash));
  const providerGrant = activeGrants.find((grant) => (
    Array.isArray(grant.providerUserIdHashes) &&
    grant.providerUserIdHashes.some((hash) => identityHashSet.has(hash))
  ));
  if (providerGrant) {
    return unavailable("provider_identity_registered", "This sign-in identity already received a wallet initiation gift.", { grant: publicWalletInitiationGrant(providerGrant) });
  }
  return available({ provider: identities[0].provider, identities, emailHash, message: `${amountPft.toLocaleString("en-US")} PFT initiation gift available after creating a new wallet.` });
}
