import { deleteAccountDatabaseData } from "./account-deletion-db.js";
import { deletedAccountArchiveId } from "./account-deletion-state.js";
import {
  deleteAccountRuntimeData,
  getAccountDeletionAuditSnapshot,
  getEthereumDepositAccount,
  getLinkedWallet,
} from "./runtime-store.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

async function recordProviderUnlinkedForAccountDeletion({
  accountSnapshot = {},
  archiveId = "",
  database = {},
  reason = "",
  sessionId = "",
  walletAddress = "",
} = {}) {
  const providers = Array.isArray(accountSnapshot?.providers) ? accountSnapshot.providers : [];
  if (!archiveId || providers.length === 0) return;
  await Promise.allSettled(providers.map((provider) => recordUserObservabilityEvent({
    eventType: "user.provider.unlinked",
    accountId: archiveId,
    walletAddress,
    walletScope: walletAddress ? "historical" : "",
    provider: safeText(provider.provider, 80),
    providerUserIdHash: safeText(provider.providerUserIdHash, 180),
    sessionId,
    sourceSurface: "auth",
    sourceRoute: "server/account-routes.js::handleAccountRoute",
    resultStatus: "unlinked",
    reasonCode: "account_deleted",
    metadata: {
      archiveId,
      deletionAuditId: safeText(database?.deletionAudit?.id, 180),
      reason: safeText(reason, 240),
      providerIdentityHashPresent: Boolean(provider.providerUserIdHash),
    },
  })));
}

export async function handleAccountRoute({
  expiredSessionCookie,
  json,
  readJson,
  req,
  res,
  session,
  sessionId = "",
  url,
}) {
  if (url.pathname !== "/api/account/delete") return false;

  if (req.method !== "POST") {
    json(res, 405, {
      ok: false,
      error: "account_delete_method_not_allowed",
      message: "Account deletion requires POST.",
    });
    return true;
  }
  if (!session?.accountId) {
    json(res, 401, {
      ok: false,
      error: "account_delete_login_required",
      message: "Sign in before deleting an account.",
    });
    return true;
  }

  const payload = await readJson(req, 8192);
  if (payload?.confirm !== true) {
    json(res, 400, {
      ok: false,
      error: "account_delete_confirmation_required",
      message: "Confirm account deletion before continuing.",
    });
    return true;
  }

  const accountId = session.accountId;
  const linkedWallet = getLinkedWallet({ accountId });
  const depositAccount = getEthereumDepositAccount({ accountId });
  const walletAddress = linkedWallet?.address || "";
  const ethereumDepositAddress = depositAccount?.address || "";
  const accountSnapshot = getAccountDeletionAuditSnapshot({ accountId });
  const archiveId = deletedAccountArchiveId(accountId);
  const reason = String(payload?.reason || "user_requested_account_delete").slice(0, 240);

  try {
    const database = await deleteAccountDatabaseData({
      account: accountSnapshot,
      accountId,
      archiveId,
      actorSessionId: sessionId,
      ethereumDepositAddress,
      walletAddress,
      reason,
    });
    const runtime = deleteAccountRuntimeData({
      accountId,
      archiveId,
      actorSessionId: sessionId,
      reason,
    });
    await recordProviderUnlinkedForAccountDeletion({
      accountSnapshot,
      archiveId,
      database,
      reason,
      sessionId,
      walletAddress,
    });
    json(
      res,
      200,
      {
        ok: true,
        action: "account_delete",
        message: "Account deleted.",
        accountId,
        archiveId,
        removed: runtime.removed,
        database,
      },
      { "set-cookie": expiredSessionCookie() }
    );
  } catch (error) {
    json(res, error?.status || 500, {
      ok: false,
      error: "account_delete_failed",
      message: error?.message || "Account deletion failed.",
    });
  }
  return true;
}
