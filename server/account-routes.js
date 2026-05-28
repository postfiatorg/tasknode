import { deleteAccountDatabaseData } from "./account-deletion-db.js";
import { deletedAccountArchiveId } from "./account-deletion-state.js";
import {
  deleteAccountRuntimeData,
  getAccountDeletionAuditSnapshot,
  getEthereumDepositAccount,
  getLinkedWallet,
} from "./runtime-store.js";

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
