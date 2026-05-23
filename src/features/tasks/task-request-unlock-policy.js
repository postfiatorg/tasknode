export const TASK_REQUEST_UNLOCK_STATES = Object.freeze({
  NEEDS_SESSION: "needs_session",
  NEEDS_WALLET: "needs_wallet",
  NEEDS_LOCAL_VAULT: "needs_local_vault",
  LOCKED: "locked",
  UNLOCK_PENDING: "unlock_pending",
  INVALID_UNLOCK: "invalid_unlock",
  UNLOCKED: "unlocked",
});

const DEFAULT_MESSAGES = Object.freeze({
  needs_session: "Sign in before requesting a task.",
  needs_wallet: "Link a PFT wallet before requesting a task.",
  needs_local_vault: "Restore the local wallet vault before requesting a task.",
  unlock_pending: "Finish unlocking the linked wallet before publishing the task request.",
  locked: "Unlock the linked wallet before publishing the task request.",
  invalid_unlock: "Unlocked wallet state does not match the linked wallet. Unlock the linked wallet again.",
});

const TASK_SIGNING_MESSAGES = Object.freeze({
  needs_session: "Sign in before signing a task update.",
  needs_wallet: "Link a PFT wallet before signing task updates.",
  needs_local_vault: "Restore the local wallet vault on the Wallet page before signing.",
  unlock_pending: "Finish unlocking the linked wallet before signing.",
  locked: "Unlock the linked wallet before signing this task update.",
  invalid_unlock: "Unlocked wallet state does not match the linked wallet. Unlock the linked wallet again.",
});

export function evaluateTaskRequestUnlockPolicy({
  accountId = "",
  linkedWalletAddress = "",
  walletSecret = null,
  walletVault = {},
  unlockPending = false,
  messages = DEFAULT_MESSAGES,
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
      message: messages.needs_session,
      state: TASK_REQUEST_UNLOCK_STATES.NEEDS_SESSION,
    };
  }

  if (!normalizedWallet) {
    return {
      action: "open_wallet",
      allowed: false,
      message: messages.needs_wallet,
      state: TASK_REQUEST_UNLOCK_STATES.NEEDS_WALLET,
    };
  }

  if (unlockPending) {
    return {
      action: "wait",
      allowed: false,
      message: messages.unlock_pending,
      state: TASK_REQUEST_UNLOCK_STATES.UNLOCK_PENDING,
    };
  }

  if (!walletVault?.available || !vaultMatchesLinkedWallet) {
    return {
      action: "open_wallet",
      allowed: false,
      message: messages.needs_local_vault,
      state: TASK_REQUEST_UNLOCK_STATES.NEEDS_LOCAL_VAULT,
    };
  }

  if (!walletVault?.unlocked) {
    return {
      action: "unlock",
      allowed: false,
      message: messages.locked,
      state: TASK_REQUEST_UNLOCK_STATES.LOCKED,
    };
  }

  if (!walletSecret?.mnemonic || !secretMatchesAccount || !secretMatchesLinkedWallet) {
    return {
      action: "unlock",
      allowed: false,
      message: messages.invalid_unlock,
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

export function evaluateTaskSigningUnlockPolicy(props = {}) {
  return evaluateTaskRequestUnlockPolicy({
    ...props,
    messages: TASK_SIGNING_MESSAGES,
  });
}
