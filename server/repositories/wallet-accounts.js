import { createHash } from "node:crypto";
import { providerAliasDefaults } from "../account-identity.js";
import { databaseEnabled, transaction } from "../db/pool.js";
import { resolveOrCreateWalletLoginAccount as resolveRuntimeWalletAccount } from "../runtime-store.js";
import { getAccount, refreshDurableAccountCache } from "./accounts.js";

const stableId = (value, prefix) => `${prefix}_${createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24)}`;
function displayName(address = "") {
  const value = String(address || "").trim();
  return value.length <= 16 ? `Wallet ${value}` : `Wallet ${value.slice(0, 8)}...${value.slice(-6)}`;
}
function mergeWalletProvider(account, { address, publicKey }) {
  const providers = Array.isArray(account.linkedProviders) ? account.linkedProviders : [];
  const prior = providers.find((item) => item?.id === "wallet") || {};
  const next = providerAliasDefaults({
    ...prior, id: "wallet", label: "Wallet", kind: "wallet_signature", status: "verified",
    providerUserId: address, username: address, displayName: displayName(address), profileUrl: null,
    publicKey: String(publicKey || "").trim() || null, linkedAt: prior.linkedAt || new Date().toISOString(),
  });
  account.linkedProviders = providers.filter((item) => item?.id !== "wallet").concat(next);
}

export async function resolveOrCreateWalletLoginAccount(options = {}) {
  if (!databaseEnabled()) return resolveRuntimeWalletAccount(options);
  const address = String(options.address || "").trim();
  if (!address) return { ok: false, status: 400, error: "wallet_address_required" };
  const result = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wallet-account:${address}`]);
    const owner = await client.query(
      "SELECT account_id FROM account_linked_wallets WHERE wallet_address = $1 AND status = 'linked' LIMIT 1 FOR UPDATE",
      [address]
    );
    const accountId = owner.rows[0]?.account_id || stableId(address, "acct_wallet");
    const current = await client.query("SELECT account_json FROM app_accounts WHERE account_id = $1 FOR UPDATE", [accountId]);
    const now = new Date().toISOString();
    const account = current.rows[0]?.account_json || {
      id: accountId, status: "active", displayName: displayName(address), primaryProvider: "wallet",
      assurance: "high", profileVisibility: "public", linkedProviders: [], createdAt: now,
    };
    mergeWalletProvider(account, { address, publicKey: options.publicKey });
    account.status ||= "active"; account.displayName ||= displayName(address); account.primaryProvider ||= "wallet";
    account.assurance = "high"; account.updatedAt = now; account.lastProviderLoginAt = now;
    await client.query(
      `INSERT INTO app_accounts (account_id, account_json, hive_handle, status, created_at, updated_at)
       VALUES ($1,$2::jsonb,$3,$4,$5,$6) ON CONFLICT (account_id) DO UPDATE SET
         account_json = EXCLUDED.account_json, hive_handle = EXCLUDED.hive_handle,
         status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [account.id, JSON.stringify(account), account.hiveHandle || null, account.status, account.createdAt, account.updatedAt]
    );
    return { accountId, created: !current.rows[0], linked: !owner.rows[0], wallet: owner.rows[0] ? { accountId, address, status: "linked" } : null };
  });
  await refreshDurableAccountCache();
  return {
    ok: true, account: await getAccount(result.accountId), wallet: result.wallet,
    created: result.created, linked: result.linked, reclaimedWalletCount: 0,
  };
}
