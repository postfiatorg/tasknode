import { readPftlCacheOperatorHealth } from "./pftl-cache-maintenance.js";
import { readCachedAccountTx } from "./pftl-cache-sync.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";

export async function handlePftlCacheRoute({ url, res, session, json }) {
  if (url.pathname === "/api/pftl/cache/health") {
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "wallet_login_required",
        message: "Sign in before reading PFTL cache health.",
      });
      return true;
    }
    const result = await readPftlCacheOperatorHealth({
      accountId: session.accountId,
      query: {
        hotStaleMs: url.searchParams.get("hotStaleMs"),
        archiveStaleMs: url.searchParams.get("archiveStaleMs"),
        recentLimit: url.searchParams.get("recentLimit"),
      },
    });
    json(res, result.status || (result.ok ? 200 : 500), result);
    return true;
  }

  if (url.pathname !== "/api/pftl/cache/account-tx") return false;

  if (!session?.accountId) {
    json(res, 401, {
      ok: false,
      error: "wallet_login_required",
      message: "Sign in before reading cached PFTL transactions.",
    });
    return true;
  }

  const linkedWallet = await getLinkedWallet({ accountId: session.accountId });
  if (linkedWallet.status !== "linked" || !linkedWallet.address) {
    json(res, 409, {
      ok: false,
      error: "wallet_not_linked",
      message: "Link a PFT wallet before reading cached PFTL transactions.",
    });
    return true;
  }

  const requestedWallet = String(url.searchParams.get("wallet") || linkedWallet.address).trim();
  if (requestedWallet !== linkedWallet.address) {
    json(res, 403, {
      ok: false,
      error: "wallet_cache_forbidden",
      message: "Cached PFTL transaction reads are limited to the linked wallet for this account.",
    });
    return true;
  }

  const result = await readCachedAccountTx({
    walletAddress: linkedWallet.address,
    accountId: session.accountId,
    limit: url.searchParams.get("limit"),
    forceSync: url.searchParams.get("force") === "1",
    syncIfEmpty: url.searchParams.get("syncIfEmpty") !== "0",
  });
  json(res, result.status || (result.ok ? 200 : 502), result);
  return true;
}
