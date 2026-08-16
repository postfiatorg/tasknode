import {
  accountIdentityProfile,
  applyAccountAliasVisibility,
  applyAccountHiveHandle,
  applyAccountProfileVisibility,
  checkHiveHandleAvailability as checkAvailability,
  suggestHiveHandles as suggestHandles,
} from "../account-identity.js";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  checkHiveHandleAvailability as checkRuntimeAvailability,
  getAccountExpertReview as getRuntimeExpertReview,
  getAccountIdentityProfile as getRuntimeProfile,
  getAccountProfileVisibility as getRuntimeVisibility,
  listAccountIdentityProfiles as listRuntimeProfiles,
  listDiscoverableAccountWalletIdentities as listRuntimeDiscoverableWalletIdentities,
  listPublicAccountWalletIdentities as listRuntimePublicWalletIdentities,
  setAccountAliasVisibility as setRuntimeAliasVisibility,
  setAccountExpertReview as setRuntimeExpertReview,
  setAccountHiveHandle as setRuntimeHiveHandle,
  setAccountProfileVisibility as setRuntimeProfileVisibility,
  suggestHiveHandles as suggestRuntimeHandles,
} from "../runtime-store.js";
import { getAccount, refreshDurableAccountCache } from "./accounts.js";

function fromRow(row) { return row?.account_json && typeof row.account_json === "object" ? row.account_json : null; }
function publicWalletIdentity(account, wallet = {}) {
  if (!account?.id) return null;
  const identityProfile = accountIdentityProfile(account, { accounts: { [account.id]: account }, includeSuggestions: false });
  if (!identityProfile || wallet.status !== "linked" || !wallet.wallet_address) return null;
  const firstPublicAlias = (identityProfile.publicAliases || []).find((alias) => alias?.handle);
  const displayName = (
    identityProfile.publicDisplayName
    || (identityProfile.hiveHandle ? `@${identityProfile.hiveHandle}` : "")
    || (firstPublicAlias?.handle ? `@${String(firstPublicAlias.handle).replace(/^@+/, "")}` : "")
  ).trim();
  if (!displayName) return null;
  return {
    accountId: account.id,
    walletAddress: wallet.wallet_address,
    displayName: displayName.slice(0, 80),
    hiveHandle: identityProfile.hiveHandle || "",
    publicDisplayName: identityProfile.publicDisplayName || "",
    publicAliases: identityProfile.publicAliases || [],
    publicTrustBadges: identityProfile.publicTrustBadges || [],
    profileVisibility: identityProfile.profileVisibility || "public",
    profileDiscoverable: identityProfile.profileDiscoverable !== false,
  };
}
async function allAccounts(client = null, { lock = false } = {}) {
  const runner = client || { query };
  const result = await runner.query(`SELECT account_id, account_json FROM app_accounts${lock ? " FOR UPDATE" : ""}`);
  return Object.fromEntries(result.rows.map((row) => [row.account_id, row.account_json]));
}
async function persistProfileAccount(client, account) {
  const profile = accountIdentityProfile(account, { accounts: { [account.id]: account }, includeSuggestions: false });
  await client.query(
    `UPDATE app_accounts SET account_json = $2::jsonb, hive_handle = $3,
       status = $4, updated_at = $5 WHERE account_id = $1`,
    [account.id, JSON.stringify(account), account.hiveHandle || null, account.status || "active", account.updatedAt]
  );
  await client.query(
    `UPDATE auth_sessions SET session_json = session_json || $2::jsonb
      WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [account.id, JSON.stringify({
      displayName: profile?.displayName || account.displayName,
      hiveHandle: profile?.hiveHandle || "", publicDisplayName: profile?.publicDisplayName || "",
      profileVisibility: profile?.profileVisibility || "public",
    })]
  );
}
async function mutateProfile(runtimeFallback, apply, params) {
  if (!databaseEnabled()) return runtimeFallback(params);
  const result = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('account-profile-handles'))");
    const accounts = await allAccounts(client, { lock: true });
    const changed = apply({ accounts, ...params });
    if (!changed.ok) return changed;
    await persistProfileAccount(client, changed.account);
    return { ...changed, account: changed.account };
  });
  if (result.ok) {
    await refreshDurableAccountCache();
    result.account = await getAccount(result.account.id);
  }
  return result;
}

export async function getAccountIdentityProfile({ accountId = "" } = {}) {
  if (!databaseEnabled()) return getRuntimeProfile({ accountId });
  const result = await query("SELECT account_json FROM app_accounts WHERE account_id = $1", [String(accountId || "").trim()]);
  const account = fromRow(result.rows[0]);
  return account ? accountIdentityProfile(account, { accounts: { [account.id]: account }, includeSuggestions: false }) : null;
}
export async function getAccountProfileVisibility({ accountId = "" } = {}) {
  if (!databaseEnabled()) return getRuntimeVisibility({ accountId });
  const profile = await getAccountIdentityProfile({ accountId });
  return {
    visibility: profile?.profileVisibility === "private" ? "private" : "public",
    discoverable: profile?.profileDiscoverable !== false,
  };
}
export async function getAccountExpertReview({ accountId = "" } = {}) {
  if (!databaseEnabled()) return getRuntimeExpertReview({ accountId });
  const result = await query("SELECT account_json->'expertReview' AS expert_review FROM app_accounts WHERE account_id = $1", [String(accountId || "").trim()]);
  const review = result.rows[0]?.expert_review;
  return review && typeof review === "object" && !Array.isArray(review) ? review : {};
}
export async function setAccountExpertReview({ accountId = "", review = {} } = {}) {
  if (!databaseEnabled()) return setRuntimeExpertReview({ accountId, review });
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedReview = review && typeof review === "object" && !Array.isArray(review) ? structuredClone(review) : {};
  const result = await transaction(async (client) => {
    const locked = await client.query("SELECT account_json FROM app_accounts WHERE account_id = $1 FOR UPDATE", [normalizedAccountId]);
    const account = fromRow(locked.rows[0]);
    if (!account) return { ok: false, status: 404, error: "account_not_found" };
    account.expertReview = normalizedReview;
    account.updatedAt = new Date().toISOString();
    await persistProfileAccount(client, account);
    return { ok: true, expertReview: normalizedReview };
  });
  if (result.ok) await refreshDurableAccountCache();
  return result;
}
export async function listAccountIdentityProfiles() {
  if (!databaseEnabled()) return listRuntimeProfiles();
  const result = await query("SELECT account_json FROM app_accounts WHERE status = 'active' ORDER BY account_id");
  return result.rows
    .map((row) => fromRow(row))
    .filter(Boolean)
    .map((account) => accountIdentityProfile(account, { accounts: { [account.id]: account }, includeSuggestions: false }))
    .filter(Boolean);
}
export async function listPublicAccountWalletIdentities() {
  if (!databaseEnabled()) return listRuntimePublicWalletIdentities();
  const result = await query(
    `SELECT accounts.account_json, wallets.wallet_address, wallets.status
       FROM account_linked_wallets wallets
       JOIN app_accounts accounts ON accounts.account_id = wallets.account_id
      WHERE wallets.status = 'linked' AND accounts.status = 'active'
      ORDER BY accounts.account_id`
  );
  return result.rows
    .map((row) => publicWalletIdentity(fromRow(row), row))
    .filter(Boolean);
}
export async function listDiscoverableAccountWalletIdentities() {
  if (!databaseEnabled()) return listRuntimeDiscoverableWalletIdentities();
  return (await listPublicAccountWalletIdentities())
    .filter((identity) => identity.profileDiscoverable === true && identity.profileVisibility !== "private");
}
export async function checkHiveHandleAvailability(params = {}) {
  if (!databaseEnabled()) return checkRuntimeAvailability(params);
  return checkAvailability({ ...params, accounts: await allAccounts() });
}
export async function suggestHiveHandles(params = {}) {
  if (!databaseEnabled()) return suggestRuntimeHandles(params);
  return suggestHandles({ ...params, accounts: await allAccounts() });
}
export async function setAccountHiveHandle(params = {}) {
  return mutateProfile(setRuntimeHiveHandle, applyAccountHiveHandle, params);
}
export async function setAccountAliasVisibility(params = {}) {
  return mutateProfile(setRuntimeAliasVisibility, applyAccountAliasVisibility, params);
}
export async function setAccountProfileVisibility(params = {}) {
  return mutateProfile(setRuntimeProfileVisibility, applyAccountProfileVisibility, params);
}
export function accountProfileStorageStatus() { return { adapter: databaseEnabled() ? "postgres" : "runtime" }; }
