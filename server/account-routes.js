import { deleteAccountDatabaseData } from "./account-deletion-db.js";
import { exportAccountDatabaseData } from "./account-export.js";
import { deletedAccountArchiveId } from "./account-deletion-state.js";
import {
  deleteAccountRuntimeData,
  exportAccountRuntimeData,
} from "./runtime-store.js";
import { getAccountDeletionAuditSnapshot, unlinkProviderFromAccount } from "./repositories/accounts.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";
import { getEthereumDepositAccount } from "./repositories/ethereum-deposit-accounts.js";
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
  if (url.pathname === "/api/account/unlink-provider") {
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "provider_unlink_method_not_allowed",
        message: "Use POST to unlink a connected account.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "provider_unlink_login_required",
        message: "Sign in before unlinking a connected account.",
      });
      return true;
    }
    const payload = await readJson(req);
    const provider = String(payload?.provider || "").trim().toLowerCase();
    if (payload?.confirm !== true) {
      json(res, 400, {
        ok: false,
        error: "provider_unlink_confirmation_required",
        message: "Confirm the unlink before continuing.",
      });
      return true;
    }
    const result = await unlinkProviderFromAccount({ accountId: session.accountId, provider });
    if (!result.ok) {
      const messages = {
        provider_unlink_unsupported: "This account type cannot be unlinked here.",
        provider_not_linked: "That provider is not linked to this account.",
        provider_unlink_last_login_method:
          "This is the only way to sign in to this account. Link another provider or a verified email before unlinking it.",
      };
      json(res, result.error === "provider_unlink_last_login_method" ? 409 : 400, {
        ok: false,
        error: result.error,
        message: messages[result.error] || "The connected account could not be unlinked.",
      });
      return true;
    }
    await recordUserObservabilityEvent({
      eventType: "user.account.provider_unlinked",
      accountId: session.accountId,
      sourceSurface: "settings_security",
      sourceRoute: "server/account-routes.js::handleAccountRoute",
      resultStatus: "ok",
      detail: {
        provider: result.provider,
        remainingLoginMethods: result.remainingLoginMethods,
      },
    }).catch(() => null);
    json(res, 200, {
      ok: true,
      provider: result.provider,
      remainingLoginMethods: result.remainingLoginMethods,
      message: "Connected account unlinked. It can now be linked to a different Task Node account.",
    });
    return true;
  }

  if (url.pathname === "/api/account/export") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "account_export_method_not_allowed", message: "Account export requires GET." });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, { ok: false, error: "account_export_login_required", message: "Sign in before exporting account data." });
      return true;
    }
    const generatedAt = new Date().toISOString();
    const database = await exportAccountDatabaseData({ accountId: session.accountId });
    const runtime = exportAccountRuntimeData({ accountId: session.accountId });
    json(res, 200, {
      schema: "tasknode.account-export.v1",
      generatedAt,
      accountId: session.accountId,
      runtime,
      database,
    }, {
      "content-disposition": `attachment; filename="tasknode-export-${generatedAt.slice(0, 10)}.json"`,
    });
    return true;
  }

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
  const linkedWallet = await getLinkedWallet({ accountId });
  const depositAccount = await getEthereumDepositAccount({ accountId });
  const walletAddress = linkedWallet?.address || "";
  const ethereumDepositAddress = depositAccount?.address || "";
  const accountSnapshot = await getAccountDeletionAuditSnapshot({ accountId });
  const archiveId = deletedAccountArchiveId(accountId);
  const reason = "user_requested_account_delete";

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
