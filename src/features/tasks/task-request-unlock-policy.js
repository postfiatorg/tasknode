export const TASK_REQUEST_UNLOCK_STATES = Object.freeze({
  NEEDS_SESSION: "needs_session",
  NEEDS_WALLET: "needs_wallet",
  NEEDS_LOCAL_VAULT: "needs_local_vault",
  LOCKED: "locked",
  UNLOCK_PENDING: "unlock_pending",
  INVALID_UNLOCK: "invalid_unlock",
  UNLOCKED: "unlocked",
});

export function evaluateTaskRequestUnlockPolicy({
  accountId = "",
  linkedWalletAddress = "",
  walletSecret = null,
  walletVault = {},
  unlockPending = false,
} = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedWallet = String(linkedWalletAddress || "").trim();
  const vaultAddress = String(walletVault?.address || "").trim();
  const secretAddress = String(walletSecret?.address || "").trim();
  const vaultMatchesLinkedWallet = Boolean(vaultAddress && normalizedWallet && vaultAddress === normalizedWallet);
  const secretMatchesLinkedWallet = Boolean(secretAddress && normalizedWallet && secretAddress === normalizedWallet);
  const secretMatchesAccount = Boolean(walletSecret?.accountId && walletSecret.accountId === normalizedAccountId);

  if (!normalizedAccountId) {
    return {
      action: "login",
      allowed: false,
      message: "Sign in before requesting a task.",
      state: TASK_REQUEST_UNLOCK_STATES.NEEDS_SESSION,
    };
  }

  if (!normalizedWallet) {
    return {
      action: "open_wallet",
      allowed: false,
      message: "Link a PFT wallet before requesting a task.",
      state: TASK_REQUEST_UNLOCK_STATES.NEEDS_WALLET,
    };
  }

  if (unlockPending) {
    return {
      action: "wait",
      allowed: false,
      message: "Finish unlocking the linked wallet before publishing the task request.",
      state: TASK_REQUEST_UNLOCK_STATES.UNLOCK_PENDING,
    };
  }

  if (!walletVault?.available || !vaultMatchesLinkedWallet) {
    return {
      action: "open_wallet",
      allowed: false,
      message: "Restore the local wallet vault before requesting a task.",
      state: TASK_REQUEST_UNLOCK_STATES.NEEDS_LOCAL_VAULT,
    };
  }

  if (!walletVault?.unlocked) {
    return {
      action: "unlock",
      allowed: false,
      message: "Unlock the linked wallet before publishing the task request.",
      state: TASK_REQUEST_UNLOCK_STATES.LOCKED,
    };
  }

  if (!walletSecret?.mnemonic || !secretMatchesAccount || !secretMatchesLinkedWallet) {
    return {
      action: "unlock",
      allowed: false,
      message: "Unlocked wallet state does not match the linked wallet. Unlock the linked wallet again.",
      state: TASK_REQUEST_UNLOCK_STATES.INVALID_UNLOCK,
    };
  }

  return {
    action: "submit",
    allowed: true,
    message: "",
    state: TASK_REQUEST_UNLOCK_STATES.UNLOCKED,
  };
}
