import {
  preparePftPaymentTransaction,
  submitSignedPftTransaction,
} from "./pftl-submit.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";

function normalizeText(value = "", max = 240) {
  return String(value || "").trim().slice(0, max);
}

function actionResponse({ status = 400, error = "", message = "", actionRequired = "", extra = {} } = {}) {
  return {
    status,
    body: {
      ok: false,
      error: error || "wallet_send_failed",
      message: message || "PFT send failed.",
      actionRequired: actionRequired || "",
      ...extra,
    },
  };
}

async function requireLinkedWallet(session = null) {
  if (!session?.accountId) {
    return {
      ok: false,
      response: actionResponse({
        status: 401,
        error: "wallet_login_required",
        message: "Sign in before sending PFT.",
        actionRequired: "Use the account that owns the linked wallet.",
      }),
    };
  }

  const linkedWallet = await getLinkedWallet({ accountId: session.accountId });
  if (linkedWallet.status !== "linked" || !linkedWallet.address) {
    return {
      ok: false,
      response: actionResponse({
        status: 409,
        error: "wallet_not_linked",
        message: "Link a PFT wallet before sending PFT.",
        actionRequired: "Open Wallet and link the seed wallet that should send funds.",
      }),
    };
  }

  return { ok: true, linkedWallet };
}

export async function walletSendPrepare(payload = {}, method = "GET", session = null) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "wallet_send_method_not_allowed",
      message: "Prepare PFT send with POST.",
    });
  }

  const boundary = await requireLinkedWallet(session);
  if (!boundary.ok) return boundary.response;

  try {
    const prepared = await preparePftPaymentTransaction({
      account: boundary.linkedWallet.address,
      destination: normalizeText(payload?.destination, 120),
      amountPft: normalizeText(payload?.amountPft, 80),
    });

    return {
      status: 200,
      body: {
        ok: true,
        action: "wallet_send_prepare",
        message: "Review and sign this PFT payment locally.",
        txJson: prepared.txJson,
        fromAddress: prepared.fromAddress,
        destination: prepared.destination,
        amountDrops: prepared.amountDrops,
        feeDrops: prepared.feeDrops,
        availableDrops: prepared.availableDrops,
        networkId: prepared.networkId,
      },
    };
  } catch (error) {
    return actionResponse({
      status: error?.status || 502,
      error: error?.code || error?.message || "wallet_send_prepare_failed",
      message: error?.message || "PFT payment could not be prepared.",
      actionRequired: "Check the destination address, amount, PFT balance, and PFTL connectivity.",
    });
  }
}

export async function walletSendSubmit(payload = {}, method = "GET", session = null) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "wallet_send_method_not_allowed",
      message: "Submit PFT send with POST.",
    });
  }

  const boundary = await requireLinkedWallet(session);
  if (!boundary.ok) return boundary.response;

  try {
    const submitted = await submitSignedPftTransaction({
      signedTxBlob: payload?.signedTxBlob || payload?.signed_tx_blob,
      expectedAccount: boundary.linkedWallet.address,
      expectedDestination: normalizeText(payload?.expectedDestination, 120),
      expectedAmountDrops: normalizeText(payload?.expectedAmountDrops, 80),
    });

    return {
      status: 200,
      body: {
        ok: true,
        action: "wallet_send_submit",
        message: "PFT sent.",
        txHash: submitted.txHash,
        ledgerIndex: submitted.ledgerIndex,
        engineResult: submitted.engineResult,
        fromAddress: submitted.account,
        destination: submitted.destination,
        networkId: submitted.networkId,
      },
    };
  } catch (error) {
    return actionResponse({
      status: error?.status || 502,
      error: error?.code || error?.message || "wallet_send_submit_failed",
      message: error?.message || "PFT payment could not be submitted.",
      actionRequired: "Prepare the payment again, sign with the linked wallet, and retry.",
    });
  }
}
