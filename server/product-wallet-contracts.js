import {
  completeWalletInitiationGrant,
  failWalletInitiationGrant,
  reserveWalletInitiationGrant,
  resolveWalletInitiationGrantStatus,
} from "./runtime-store.js";
import {
  delinkWalletFromAccount,
  getLinkedWallet,
  linkWalletToAccount,
} from "./repositories/account-wallets.js";
import {
  consumeWalletChallenge,
  createWalletChallenge,
} from "./repositories/auth-challenges.js";
import { getDocsAccount } from "./repositories/collaboration.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import { maybeClaimUsdcTopUpInitiationGift } from "./ethereum-deposits.js";
import {
  pftInitiationFaucetStatus,
  sendPftInitiationGift,
} from "./pftl-faucet.js";
import {
  bestEffortDeactivatePftlSyncWallet,
  bestEffortRegisterPftlSyncWallet,
} from "./pftl-cache-sync.js";
import { verifyWalletSignature } from "./wallet-proof.js";

function hasAll(keys) {
  return keys.every((key) => Boolean(process.env[key]));
}

function safeEventText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function actionResponse({ status, error, action, message, actionRequired }) {
  return {
    status,
    body: {
      ok: false,
      error,
      action,
      message,
      actionRequired,
    },
  };
}

function walletAction({ id, label, path, requiredEnv = [], enabled = false, status, note, actionRequired }) {
  const configured = hasAll(requiredEnv);

  return {
    id,
    label,
    path,
    method: "POST",
    configured,
    enabled: configured && enabled,
    status: status || (configured ? (enabled ? "ready" : "disabled") : "missing_config"),
    actionRequired: configured ? actionRequired : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}


export function walletActions() {
  return [
    walletAction({
      id: "create_start",
      label: "Create seed wallet",
      path: "/api/wallet/create/start",
      enabled: true,
      note:
        "Generates a new 24-word seed wallet in the browser, links it by proof, saves the local vault, and then attempts the one-time initiation grant.",
      actionRequired:
        "OAuth accounts can receive the grant after the encrypted local seed vault is saved. Email accounts can qualify after creating a wallet, saving the vault, and crediting more than $10 USDC.",
    }),
    walletAction({
      id: "link_start",
      label: "Link seed wallet",
      path: "/api/wallet/link/start",
      enabled: true,
      note:
        "Starts a browser-only seed wallet proof. The seed phrase never leaves the device.",
      actionRequired:
        "Enter a 24-word recovery phrase locally, derive the XRPL address in the browser, and sign the server challenge.",
    }),
    walletAction({
      id: "unlock_start",
      label: "Unlock wallet action",
      path: "/api/wallet/unlock/start",
      requiredEnv: ["PFTL_RPC_URL", "PFTL_RPC_API_KEY"],
      note:
        "Unlocks only wallet-bound actions such as sending PFT, signing verifications, or inking context manifests.",
      actionRequired:
        "Implement unlock transaction boundaries and signing confirmation screens before enabling wallet unlock.",
    }),
    walletAction({
      id: "send_pft",
      label: "Send PFT",
      path: "/api/wallet/send/prepare",
      enabled: true,
      note:
        "Prepares a native PFTL Payment for the linked wallet. The browser signs locally and submits the signed blob to /api/wallet/send/submit.",
      actionRequired:
        "Unlock the matching local seed vault, enter a destination and amount, review the payment, then sign locally.",
    }),
    walletAction({
      id: "delink",
      label: "Delink wallet",
      path: "/api/wallet/delink",
      enabled: true,
      note:
        "Detaches the active wallet from this app account without touching chain history or server-side audit history.",
      actionRequired:
        "Confirm delink in the wallet tab. The browser should also clear the local encrypted vault.",
    }),
    walletAction({
      id: "relink_start",
      label: "Relink wallet",
      path: "/api/wallet/relink/start",
      enabled: true,
      note:
        "Starts a fresh wallet ownership proof for linking a wallet after delink or replacing the current proof.",
      actionRequired:
        "Enter the recovery phrase locally and sign a fresh relink challenge.",
    }),
    walletAction({
      id: "initiation_retry",
      label: "Retry initiation gift",
      path: "/api/wallet/initiation/retry",
      enabled: true,
      note:
        "Retries the one-time PFT initiation gift for a linked wallet only after the matching local seed vault is confirmed in the browser.",
      actionRequired:
        "Requires a signed-in account, a linked wallet, a confirmed local seed vault, and configured PFTL faucet credentials.",
    }),
  ];
}


export function walletActionByPath(pathname) {
  return walletActions().find((action) => action.path === pathname) || null;
}

export async function walletLinkStart(method, session = null) {
  const action = walletActionByPath("/api/wallet/link/start");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Start wallet linking with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before linking a seed wallet.",
      actionRequired: "Use an account login, then link the local seed wallet.",
    });
  }

  const result = await createWalletChallenge({
    accountId: session.accountId,
    purpose: "wallet_link",
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_challenge_failed",
      action: action.id,
      message: "Wallet link challenge could not be created.",
      actionRequired: "Sign in and try wallet linking again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_link_start",
      message: "Sign this challenge locally to link your wallet.",
      challenge: {
        id: result.challenge.id,
        accountId: result.challenge.accountId,
        purpose: result.challenge.purpose,
        message: result.challenge.message,
        expiresAt: result.challenge.expiresAt,
      },
      verifyPath: "/api/wallet/link/verify",
    },
  };
}

export async function walletCreateStart(method, session = null) {
  const action = walletActionByPath("/api/wallet/create/start");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Start wallet creation with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before creating a seed wallet.",
      actionRequired: "Use a non-email account login, then create the local seed wallet.",
    });
  }

  const result = await createWalletChallenge({
    accountId: session.accountId,
    purpose: "wallet_create",
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_challenge_failed",
      action: action.id,
      message: "Wallet creation challenge could not be created.",
      actionRequired: "Sign in and try wallet creation again.",
    });
  }

  const gift = await resolveWalletInitiationGrantStatus({ accountId: session.accountId });

  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_create_start",
      message: "Sign this challenge locally to create and link your wallet.",
      challenge: {
        id: result.challenge.id,
        accountId: result.challenge.accountId,
        purpose: result.challenge.purpose,
        message: result.challenge.message,
        expiresAt: result.challenge.expiresAt,
      },
      verifyPath: "/api/wallet/link/verify",
      initiationGift: {
        eligible: Boolean(gift.eligible),
        reason: gift.reason || null,
        amountPft: gift.amountPft,
        amountDrops: gift.amountDrops,
        message: gift.message,
      },
    },
  };
}

async function claimWalletCreateInitiationGift({ accountId = "", walletAddress = "" } = {}) {
  const eligibility = await resolveWalletInitiationGrantStatus({ accountId, walletAddress });
  const linkedWallet = await getLinkedWallet({ accountId });
  if (linkedWallet.proofPurpose !== "wallet_create") {
    return {
      ok: false,
      status: "not_eligible",
      reason: "wallet_create_proof_required",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: "The wallet initiation gift is only available for wallets created in this account, not linked or relinked wallets.",
      grant: eligibility.grant || null,
    };
  }

  if (!eligibility.eligible) {
    return {
      ok: false,
      status: "not_eligible",
      reason: eligibility.reason || "wallet_initiation_not_eligible",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: eligibility.message,
      grant: eligibility.grant || null,
    };
  }

  const faucet = pftInitiationFaucetStatus();
  if (!faucet.configured) {
    return {
      ok: false,
      status: "not_configured",
      reason: "faucet_not_configured",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: faucet.actionRequired,
    };
  }

  const reserved = await reserveWalletInitiationGrant({
    accountId,
    walletAddress,
    amountDrops: eligibility.amountDrops,
    amountPft: eligibility.amountPft,
  });
  if (!reserved.ok) {
    return {
      ok: false,
      status: "not_eligible",
      reason: reserved.error || reserved.eligibility?.reason || "wallet_initiation_not_eligible",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: reserved.eligibility?.message || "Wallet initiation gift is not eligible.",
      grant: reserved.eligibility?.grant || null,
    };
  }

  try {
    const sent = await sendPftInitiationGift({
      destination: walletAddress,
      amountDrops: eligibility.amountDrops,
      memo: `Task Node initiation gift for ${accountId}`,
    });
    const completed = await completeWalletInitiationGrant({
      grantId: reserved.internalGrant.id,
      txHash: sent.txHash,
      faucetAddress: sent.faucetAddress,
    });
    return {
      ok: true,
      status: "completed",
      amountPft: sent.amountPft,
      amountDrops: sent.amountDrops,
      txHash: sent.txHash,
      faucetAddress: sent.faucetAddress,
      message: `${sent.amountPft.toLocaleString("en-US")} PFT initiation gift sent.`,
      grant: completed.grant || reserved.grant,
    };
  } catch (error) {
    const failed = await failWalletInitiationGrant({
      grantId: reserved.internalGrant.id,
      error: error?.message || "wallet_initiation_failed",
      unknown: Boolean(error?.submitted),
    });
    return {
      ok: false,
      status: failed.grant?.status || "failed",
      reason: error?.message || "wallet_initiation_failed",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: "Wallet was created, but the PFT initiation gift could not be sent yet.",
      grant: failed.grant || reserved.grant,
    };
  }
}

function localVaultConfirmationRequired({ action }) {
  return actionResponse({
    status: 409,
    error: "local_vault_confirmation_required",
    action: action.id,
    message: "Unlock or save the matching local seed vault before sending the PFT initiation grant.",
    actionRequired: "Open Wallet, unlock the local vault for the linked address, then retry the PFT grant.",
  });
}

function walletCreateGrantPendingVault({ accountId = "", walletAddress = "" } = {}) {
  return resolveWalletInitiationGrantStatus({ accountId, walletAddress }).then((eligibility) => {
    if (!eligibility.eligible) {
      return {
        ok: false,
        status: "not_eligible",
        reason: eligibility.reason || "wallet_initiation_not_eligible",
        amountPft: eligibility.amountPft,
        amountDrops: eligibility.amountDrops,
        message: eligibility.message,
        grant: eligibility.grant || null,
      };
    }
    return {
      ok: false,
      status: "local_vault_required",
      reason: "local_vault_required",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: "Seed wallet linked. Save the encrypted local seed vault before sending the PFT initiation gift.",
      grant: null,
    };
  });
}

export async function walletInitiationRetry(method, session = null, payload = {}) {
  const action = walletActionByPath("/api/wallet/initiation/retry");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Retry the wallet initiation gift with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before retrying a wallet initiation gift.",
      actionRequired: "Use the account that owns the linked wallet.",
    });
  }

  if (payload?.localVaultConfirmed !== true) {
    return localVaultConfirmationRequired({ action });
  }

  const linkedWallet = await getLinkedWallet({ accountId: session.accountId });
  if (linkedWallet.status !== "linked" || !linkedWallet.address) {
    return actionResponse({
      status: 409,
      error: "wallet_not_linked",
      action: action.id,
      message: "Link a wallet before retrying the initiation gift.",
      actionRequired: "Create or link a wallet first.",
    });
  }

  let initiationGift = await claimWalletCreateInitiationGift({
    accountId: session.accountId,
    walletAddress: linkedWallet.address,
  });
  if (!initiationGift.ok && linkedWallet.walletCreatedInAccount) {
    const usdcGift = await maybeClaimUsdcTopUpInitiationGift({ accountId: session.accountId });
    if (usdcGift) initiationGift = usdcGift;
  }

  return {
    status: initiationGift.ok ? 200 : initiationGift.status === "not_eligible" ? 409 : 502,
    body: {
      ok: Boolean(initiationGift.ok),
      action: action.id,
      message: initiationGift.message,
      initiationGift,
      wallet: linkedWallet,
    },
  };
}

export async function walletLinkVerify(payload, method, session = null) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: "wallet_link_verify",
      message: "Wallet link verification requires POST.",
      actionRequired: "Verify wallet linking with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: "wallet_link_verify",
      message: "Sign in before verifying a seed wallet.",
      actionRequired: "Use an account login, then verify the local wallet proof.",
    });
  }

  const challengeResult = await consumeWalletChallenge({
    accountId: session.accountId,
    challengeId: payload?.challengeId,
    purpose: ["wallet_link", "wallet_relink", "wallet_create"],
  });

  if (!challengeResult.ok) {
    return actionResponse({
      status: challengeResult.status || 400,
      error: challengeResult.error || "wallet_challenge_invalid",
      action: "wallet_link_verify",
      message: "Wallet link challenge is invalid or expired.",
      actionRequired: "Start wallet linking again and sign the fresh challenge.",
    });
  }

  const address = String(payload?.address || "").trim();
  const publicKey = String(payload?.publicKey || "").trim();
  const tasknodeEncryptionPubkey = String(payload?.tasknodeEncryptionPubkey || payload?.tasknode_encryption_pubkey || "").trim();
  const signature = String(payload?.signature || "").trim();
  const verified = verifyWalletSignature({
    message: challengeResult.challenge.message,
    signature,
    publicKey,
    address,
  });

  if (!verified) {
    return actionResponse({
      status: 400,
      error: "wallet_signature_invalid",
      action: "wallet_link_verify",
      message: "Wallet signature did not verify.",
      actionRequired: "Confirm the recovery phrase and sign the latest challenge again.",
    });
  }

  const previousLinkedWallet = await getLinkedWallet({ accountId: session.accountId });
  const result = await linkWalletToAccount({
    accountId: session.accountId,
    address,
    publicKey,
    tasknodeEncryptionPubkey,
    challengeId: challengeResult.challenge.id,
    signature,
    proofPurpose: challengeResult.challenge.purpose,
  });

  if (!result.ok) {
    if (result.error === "wallet_owned_by_other_account") {
      await recordUserObservabilityEvent({
        eventType: "user.wallet.ownership_conflict",
        accountId: session.accountId,
        walletAddress: address,
        walletScope: "active",
        sourceSurface: "wallet",
        sourceRoute: "server/product-wallet-contracts.js::walletLinkVerify",
        resultStatus: "rejected",
        reasonCode: result.error,
      }).catch(() => null);
    }
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_link_failed",
      action: "wallet_link_verify",
      message:
        result.error === "wallet_owned_by_other_account"
          ? "That wallet is already linked to a different account."
          : "Wallet link could not be saved.",
      actionRequired:
        result.error === "wallet_owned_by_other_account"
          ? "Use the distinct wallet belonging to this account. Wallet ownership is not moved by linking."
          : "Start wallet linking again and sign a fresh challenge.",
    });
  }

  await bestEffortRegisterPftlSyncWallet({
    accountId: session.accountId,
    walletAddress: result.wallet.address,
    reason: challengeResult.challenge.purpose,
  });
  if (
    previousLinkedWallet?.status === "linked" &&
    previousLinkedWallet.address &&
    previousLinkedWallet.address !== result.wallet.address
  ) {
    await bestEffortDeactivatePftlSyncWallet({
      walletAddress: previousLinkedWallet.address,
      reason: "wallet_relinked",
    });
  }
  await Promise.allSettled([
    recordUserObservabilityEvent({
      eventType: "user.wallet.linked",
      accountId: session.accountId,
      walletAddress: result.wallet.address,
      walletScope: "active",
      sourceSurface: "wallet",
      sourceRoute: "server/product-wallet-contracts.js::walletLinkVerify",
      resultStatus: "linked",
      reasonCode: challengeResult.challenge.purpose,
      metadata: {
        proofPurpose: challengeResult.challenge.purpose,
        reclaimedWalletCount: 0,
        publicKeyPresent: Boolean(publicKey),
        encryptionPublicKeyPresent: Boolean(tasknodeEncryptionPubkey),
      },
    }),
    recordUserObservabilityEvent({
      eventType: "user.wallet.selected",
      accountId: session.accountId,
      walletAddress: result.wallet.address,
      walletScope: "active",
      sourceSurface: "wallet",
      sourceRoute: "server/product-wallet-contracts.js::walletLinkVerify",
      resultStatus: "selected",
      reasonCode: challengeResult.challenge.purpose,
      metadata: {
        selectionSource: "wallet_link_verify",
      },
    }),
  ]);

  const reclaimedWalletCount = 0;
  const isCreate = challengeResult.challenge.purpose === "wallet_create";
  const initiationGift = isCreate
    ? await walletCreateGrantPendingVault({
        accountId: session.accountId,
        walletAddress: result.wallet.address,
      })
    : null;
  const message = isCreate
    ? "Seed wallet created. Save the local vault to send the PFT initiation gift."
    : "Seed wallet linked.";
  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_link_verify",
      message,
      reclaimedWalletCount,
      initiationGift,
      wallet: result.wallet,
    },
  };
}

export async function walletRelinkStart(method, session = null) {
  const action = walletActionByPath("/api/wallet/relink/start");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Start wallet relinking with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before relinking a seed wallet.",
      actionRequired: "Use an account login, then prove control of the wallet.",
    });
  }

  const result = await createWalletChallenge({
    accountId: session.accountId,
    purpose: "wallet_relink",
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_challenge_failed",
      action: action.id,
      message: "Wallet relink challenge could not be created.",
      actionRequired: "Sign in and try wallet relinking again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_relink_start",
      message: "Sign this challenge locally to relink your wallet.",
      challenge: {
        id: result.challenge.id,
        accountId: result.challenge.accountId,
        purpose: result.challenge.purpose,
        message: result.challenge.message,
        expiresAt: result.challenge.expiresAt,
      },
      verifyPath: "/api/wallet/link/verify",
    },
  };
}

export async function walletDelink(payload, method, session = null) {
  const action = walletActionByPath("/api/wallet/delink");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Delink wallet with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before delinking a wallet.",
      actionRequired: "Use an account login, then delink the wallet from the wallet tab.",
    });
  }

  const linkedWallet = await getLinkedWallet({ accountId: session.accountId });
  if (linkedWallet.status !== "linked" || !linkedWallet.address) {
    return actionResponse({
      status: 409,
      error: "wallet_not_linked",
      action: action.id,
      message: "No active wallet is linked to this account.",
      actionRequired: "Link a wallet before attempting to delink.",
    });
  }

  const confirmAddress = String(payload?.confirmAddress || "").trim();
  if (confirmAddress && confirmAddress !== linkedWallet.address) {
    return actionResponse({
      status: 400,
      error: "wallet_delink_confirmation_mismatch",
      action: action.id,
      message: "Wallet delink confirmation did not match the linked wallet.",
      actionRequired: "Refresh the wallet tab and confirm the current linked wallet.",
    });
  }

  const docsAccount = await getDocsAccount({ accountId: session.accountId }).catch(() => null);
  if (
    docsAccount?.status === "active" &&
    docsAccount.envelopeWalletAddress === linkedWallet.address &&
    payload?.confirmDocsAccessLoss !== true
  ) {
    return actionResponse({
      status: 409,
      error: "wallet_delink_docs_rekey_required",
      action: action.id,
      message: "This wallet is the active encryption recipient for your Docs library.",
      actionRequired: "Re-wrap or export the Docs root key before delinking, or explicitly confirm permanent Docs access loss.",
    });
  }

  const result = await delinkWalletFromAccount({
    accountId: session.accountId,
    actorSessionId: session.id,
    reason: payload?.reason || "user_requested",
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_delink_failed",
      action: action.id,
      message: "Wallet could not be delinked.",
      actionRequired: "Refresh the wallet tab and try again.",
    });
  }

  await bestEffortDeactivatePftlSyncWallet({
    walletAddress: result.wallet.address,
    reason: payload?.reason || "user_delinked",
  });
  await recordUserObservabilityEvent({
    eventType: "user.wallet.delinked",
    accountId: session.accountId,
    walletAddress: result.wallet.address,
    walletScope: "historical",
    sourceSurface: "wallet",
    sourceRoute: "server/product-wallet-contracts.js::walletDelink",
    resultStatus: "delinked",
    reasonCode: safeEventText(payload?.reason || "user_requested", 180),
    metadata: {
      delinkedAt: result.wallet.delinkedAt || "",
    },
  }).catch(() => {});

  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_delink",
      message: "Wallet delinked. Local vault data should be cleared from this browser.",
      wallet: {
        status: "delinked",
        address: result.wallet.address,
        delinkedAt: result.wallet.delinkedAt,
      },
    },
  };
}

export async function walletActionStart(pathname, method, session = null, payload = {}) {
  if (pathname === "/api/wallet/create/start") {
    return walletCreateStart(method, session);
  }
  if (pathname === "/api/wallet/initiation/retry") {
    return walletInitiationRetry(method, session, payload);
  }
  if (pathname === "/api/wallet/relink/start") {
    return walletRelinkStart(method, session);
  }
  if (pathname === "/api/wallet/delink") {
    return walletDelink(payload, method, session);
  }

  const action = walletActionByPath(pathname);

  if (!action) {
    return actionResponse({
      status: 404,
      error: "unknown_wallet_action",
      action: pathname,
      message: "Unknown wallet action.",
    });
  }

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Call the wallet action with the declared method.",
    });
  }

  if (!action.configured) {
    return actionResponse({
      status: 409,
      error: "wallet_action_not_configured",
      action: action.id,
      message: `${action.label} is not configured for this environment.`,
      actionRequired: action.actionRequired,
    });
  }

  return actionResponse({
    status: 503,
    error: "wallet_action_disabled",
    action: action.id,
    message: `${action.label} is configured but disabled until the wallet custody boundary is implemented.`,
    actionRequired: action.actionRequired,
  });
}
