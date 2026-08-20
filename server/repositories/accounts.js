import { createHash } from "node:crypto";
import { accountIdentityProfile, providerAliasDefaults } from "../account-identity.js";
import { accountDeletionAuditSnapshot } from "../account-deletion-audit.js";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  findAccountByEmail as findRuntimeByEmail,
  findAccountByIdentity as findRuntimeByIdentity,
  getAccount as getRuntimeAccount,
  getLinkedProviderForAccount as getRuntimeLinkedProvider,
  getOrCreateEmailAccount as getOrCreateRuntimeEmail,
  getOrCreateProviderAccount as getOrCreateRuntimeProvider,
  legacyAccountStateSnapshotForMigration,
  linkProviderToAccount as linkRuntimeProvider,
  replaceRuntimeAccountStateFromDurable,
  unlinkProviderFromAccount as unlinkRuntimeProvider,
} from "../runtime-store.js";

const oauthProviders = new Set(["github", "telegram", "x", "discord"]);
const stableId = (value, prefix) => `${prefix}_${createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24)}`;
const identityKey = (provider, userId) => `${String(provider || "").toLowerCase()}:${String(userId || "").trim()}`;
function providerLabel(provider) {
  return ({ github: "GitHub", x: "X", discord: "Discord", telegram: "Telegram", wallet: "Wallet" })[provider] || "Provider";
}
function displayNameFromEmail(email = "") {
  const words = String(email).split("@")[0].replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length ? words.slice(0, 2).map((word) => `${word[0].toUpperCase()}${word.slice(1)}`).join(" ") : "Task Node member";
}
function publicAccount(account = null) {
  if (!account) return null;
  const profile = accountIdentityProfile(account, { accounts: { [account.id]: account }, includeSuggestions: false });
  return {
    id: account.id, status: account.status || "active", displayName: profile?.displayName || account.displayName,
    hiveHandle: profile?.hiveHandle || "", publicDisplayName: profile?.publicDisplayName || "",
    profileVisibility: profile?.profileVisibility || "public", profileDiscoverable: profile?.profileDiscoverable !== false,
    primaryProvider: account.primaryProvider || "email", primaryEmailCanonical: account.primaryEmailCanonical || "",
    emailProvider: account.emailProvider || "", linkedProviders: account.linkedProviders || [],
    assurance: account.assurance || "low", createdAt: account.createdAt, updatedAt: account.updatedAt,
  };
}
function linkedProvider(options = {}) {
  const metadata = options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata) ? options.metadata : {};
  return providerAliasDefaults({
    id: options.provider, label: providerLabel(options.provider), kind: "oauth", status: "linked",
    providerUserId: options.providerUserId, username: options.username || null,
    displayName: options.displayName || null, profileUrl: options.profileUrl || null,
    email: options.email || null, emailVerified: options.emailVerified === true,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  });
}
function mergeProvider(account, incoming) {
  const providers = Array.isArray(account.linkedProviders) ? account.linkedProviders : [];
  const prior = providers.find((item) => item?.id === incoming.id) || {};
  const merged = providerAliasDefaults({
    ...prior, ...incoming, aliasVisibility: prior.aliasVisibility || incoming.aliasVisibility,
    discloseHandle: prior.discloseHandle === true || incoming.discloseHandle === true,
    discloseVerifiedBadge: prior.discloseVerifiedBadge === true || incoming.discloseVerifiedBadge === true,
    linkedAt: prior.linkedAt || new Date().toISOString(),
  });
  account.linkedProviders = providers.filter((item) => item?.id !== incoming.id).concat(merged);
}
function accountFromRow(row) { return row?.account_json && typeof row.account_json === "object" ? row.account_json : null; }
async function saveAccount(client, account) {
  await client.query(
    `INSERT INTO app_accounts (account_id, account_json, hive_handle, status, created_at, updated_at)
     VALUES ($1,$2::jsonb,$3,$4,$5,$6) ON CONFLICT (account_id) DO UPDATE SET
       account_json = EXCLUDED.account_json, hive_handle = EXCLUDED.hive_handle,
       status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
    [account.id, JSON.stringify(account), account.hiveHandle || null, account.status || "active", account.createdAt, account.updatedAt]
  );
  const payload = publicAccount(account);
  await client.query(
    `UPDATE auth_sessions SET session_json = session_json || $2::jsonb
      WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [account.id, JSON.stringify({
      displayName: payload.displayName, hiveHandle: payload.hiveHandle,
      publicDisplayName: payload.publicDisplayName, profileVisibility: payload.profileVisibility,
      primaryProvider: payload.primaryProvider, linkedProviders: payload.linkedProviders,
    })]
  );
}
async function refreshRuntimeCache() {
  if (!databaseEnabled()) return;
  const [accounts, emails, identities] = await Promise.all([
    query("SELECT account_id, account_json FROM app_accounts"),
    query("SELECT email_canonical, account_id FROM account_email_identities"),
    query("SELECT provider, provider_user_id, account_id FROM account_provider_identities"),
  ]);
  replaceRuntimeAccountStateFromDurable({
    accounts: Object.fromEntries(accounts.rows.map((row) => [row.account_id, row.account_json])),
    emails: Object.fromEntries(emails.rows.map((row) => [row.email_canonical, row.account_id])),
    identities: Object.fromEntries(identities.rows.map((row) => [identityKey(row.provider, row.provider_user_id), row.account_id])),
  });
}
async function lookupAccount(client, accountId) {
  const result = await client.query("SELECT account_json FROM app_accounts WHERE account_id = $1 FOR UPDATE", [accountId]);
  return accountFromRow(result.rows[0]);
}

export async function getAccount(accountId = "") {
  if (!databaseEnabled()) return getRuntimeAccount(accountId);
  const result = await query("SELECT account_json FROM app_accounts WHERE account_id = $1", [String(accountId || "").trim()]);
  return publicAccount(accountFromRow(result.rows[0]));
}
export async function getAccountDeletionAuditSnapshot({ accountId = "" } = {}) {
  if (!databaseEnabled()) {
    const { getAccountDeletionAuditSnapshot: runtimeSnapshot } = await import("../runtime-store.js");
    return runtimeSnapshot({ accountId });
  }
  const result = await query("SELECT account_json FROM app_accounts WHERE account_id = $1", [String(accountId || "").trim()]);
  return accountDeletionAuditSnapshot(accountFromRow(result.rows[0]));
}
export async function findAccountByEmail(email = "") {
  if (!databaseEnabled()) return findRuntimeByEmail(email);
  const result = await query(
    `SELECT accounts.account_json FROM account_email_identities identities
      JOIN app_accounts accounts ON accounts.account_id = identities.account_id
      WHERE identities.email_canonical = $1`, [String(email || "").trim().toLowerCase()]
  );
  return publicAccount(accountFromRow(result.rows[0]));
}
export async function findAccountByIdentity(provider = "", providerUserId = "") {
  if (!databaseEnabled()) return findRuntimeByIdentity(provider, providerUserId);
  const result = await query(
    `SELECT accounts.account_json FROM account_provider_identities identities
      JOIN app_accounts accounts ON accounts.account_id = identities.account_id
      WHERE identities.provider = $1 AND identities.provider_user_id = $2`,
    [String(provider).toLowerCase(), String(providerUserId).trim()]
  );
  return publicAccount(accountFromRow(result.rows[0]));
}
export async function getLinkedProviderForAccount({ accountId = "", provider = "" } = {}) {
  if (!databaseEnabled()) return getRuntimeLinkedProvider({ accountId, provider });
  const account = await getAccount(accountId);
  return (account?.linkedProviders || []).find((item) => item?.id === String(provider).toLowerCase()) || null;
}

export async function getOrCreateEmailAccount(options = {}) {
  if (!databaseEnabled()) return getOrCreateRuntimeEmail(options);
  const canonical = String(options.canonicalEmail || "").trim().toLowerCase();
  if (!canonical) return null;
  const result = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`email:${canonical}`]);
    const owner = await client.query("SELECT account_id FROM account_email_identities WHERE email_canonical = $1 FOR UPDATE", [canonical]);
    const now = new Date().toISOString();
    let account = owner.rows[0] ? await lookupAccount(client, owner.rows[0].account_id) : null;
    if (!account) {
      const id = stableId(canonical, "acct_email");
      account = {
        id, status: "active", displayName: displayNameFromEmail(canonical), primaryEmailOriginal: options.email,
        primaryEmailCanonical: canonical, primaryEmailVerified: true, primaryProvider: "email", assurance: "low",
        profileVisibility: "public", linkedProviders: [{ id: "email", label: "Email", kind: "email_code", status: "verified", maskedEmail: options.maskedEmail || null }],
        createdAt: now, updatedAt: now, emailLastSeenAt: now,
      };
    } else {
      account.profileVisibility = account.profileVisibility === "private" ? "private" : "public";
      account.primaryEmailOriginal = options.email || account.primaryEmailOriginal; account.updatedAt = now; account.emailLastSeenAt = now;
    }
    await saveAccount(client, account);
    await client.query(
      `INSERT INTO account_email_identities (email_canonical, account_id) VALUES ($1,$2)
       ON CONFLICT (email_canonical) DO UPDATE SET account_id = EXCLUDED.account_id, updated_at = now()`, [canonical, account.id]
    );
    return publicAccount(account);
  });
  await refreshRuntimeCache(); return result;
}

export async function getOrCreateProviderAccount(options = {}) {
  if (!databaseEnabled()) return getOrCreateRuntimeProvider(options);
  const provider = String(options.provider || "").trim().toLowerCase(); const userId = String(options.providerUserId || "").trim();
  if (!provider || !userId) return null;
  const email = options.emailInfo?.verified === true ? String(options.emailInfo.email || "").trim().toLowerCase() : "";
  const result = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`identity:${identityKey(provider, userId)}`]);
    if (email) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`email:${email}`]);
    const identity = await client.query("SELECT account_id FROM account_provider_identities WHERE provider = $1 AND provider_user_id = $2 FOR UPDATE", [provider, userId]);
    const emailOwner = email ? await client.query("SELECT account_id FROM account_email_identities WHERE email_canonical = $1 FOR UPDATE", [email]) : { rows: [] };
    const now = new Date().toISOString(); let accountId = identity.rows[0]?.account_id || emailOwner.rows[0]?.account_id || "";
    if (!accountId) {
      const derived = stableId(identityKey(provider, userId), "acct_oauth");
      accountId = (await lookupAccount(client, derived)) ? stableId(`${identityKey(provider, userId)}:refound:${now}`, "acct_oauth") : derived;
    }
    let account = await lookupAccount(client, accountId);
    if (!account) account = { id: accountId, status: "active", displayName: options.displayName || options.username || providerLabel(provider), primaryProvider: provider, assurance: "medium", profileVisibility: "public", linkedProviders: [], createdAt: now };
    mergeProvider(account, linkedProvider({ ...options, provider, providerUserId: userId, email: options.emailInfo?.email || "", emailVerified: options.emailInfo?.verified === true }));
    account.status ||= "active"; account.displayName ||= options.displayName || options.username || providerLabel(provider);
    account.primaryProvider ||= provider; account.assurance = account.assurance === "high" ? "high" : "medium"; account.updatedAt = now; account.lastProviderLoginAt = now;
    if (email && (!emailOwner.rows[0] || emailOwner.rows[0].account_id === accountId) && (!account.primaryEmailCanonical || account.primaryEmailCanonical === email)) {
      account.primaryEmailOriginal = options.emailInfo.email; account.primaryEmailCanonical = email; account.primaryEmailVerified = true;
      account.emailProvider ||= provider; account.emailLastSeenAt = now;
    }
    await saveAccount(client, account);
    if (email && (!emailOwner.rows[0] || emailOwner.rows[0].account_id === accountId) && account.primaryEmailCanonical === email) {
      await client.query("INSERT INTO account_email_identities (email_canonical, account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [email, accountId]);
    }
    await client.query(
      `INSERT INTO account_provider_identities (provider, provider_user_id, account_id, identity_json)
       VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (provider, provider_user_id) DO UPDATE SET identity_json = EXCLUDED.identity_json, updated_at = now()`,
      [provider, userId, accountId, JSON.stringify({ username: options.username || "", displayName: options.displayName || "" })]
    );
    return publicAccount(account);
  });
  await refreshRuntimeCache(); return result;
}

export async function linkProviderToAccount(options = {}) {
  if (!databaseEnabled()) return linkRuntimeProvider(options);
  const accountId = String(options.accountId || "").trim(); const provider = String(options.provider || "").trim().toLowerCase(); const userId = String(options.providerUserId || "").trim();
  if (!accountId || !provider || !userId) return { ok: false, error: "provider_link_invalid" };
  const email = options.emailInfo?.verified === true ? String(options.emailInfo.email || "").trim().toLowerCase() : "";
  const result = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`identity:${identityKey(provider, userId)}`]);
    const account = await lookupAccount(client, accountId); if (!account) return { ok: false, error: "account_not_found" };
    const owner = await client.query("SELECT account_id FROM account_provider_identities WHERE provider = $1 AND provider_user_id = $2 FOR UPDATE", [provider, userId]);
    if (owner.rows[0] && owner.rows[0].account_id !== accountId) return { ok: false, error: "provider_identity_conflict" };
    if (email) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`email:${email}`]);
      const emailOwner = await client.query("SELECT account_id FROM account_email_identities WHERE email_canonical = $1 FOR UPDATE", [email]);
      if (emailOwner.rows[0] && emailOwner.rows[0].account_id !== accountId) return { ok: false, error: "provider_email_conflict" };
    }
    const now = new Date().toISOString(); mergeProvider(account, linkedProvider({ ...options, provider, providerUserId: userId, email: options.emailInfo?.email || "", emailVerified: options.emailInfo?.verified === true }));
    account.status ||= "active"; account.displayName ||= options.displayName || options.username || providerLabel(provider); account.primaryProvider ||= provider;
    account.assurance = account.assurance === "high" ? "high" : "medium"; account.updatedAt = now; account.lastProviderLinkAt = now;
    if (email && (!account.primaryEmailCanonical || account.primaryEmailCanonical === email)) {
      account.primaryEmailOriginal = options.emailInfo.email; account.primaryEmailCanonical = email; account.primaryEmailVerified = true; account.emailProvider ||= provider; account.emailLastSeenAt = now;
      await client.query("INSERT INTO account_email_identities (email_canonical, account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [email, accountId]);
    }
    await saveAccount(client, account);
    await client.query("INSERT INTO account_provider_identities (provider, provider_user_id, account_id, identity_json) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING", [provider, userId, accountId, JSON.stringify({ username: options.username || "" })]);
    return { ok: true, account: publicAccount(account) };
  });
  await refreshRuntimeCache(); return result;
}

export async function unlinkProviderFromAccount(options = {}) {
  if (!databaseEnabled()) return unlinkRuntimeProvider(options);
  const accountId = String(options.accountId || "").trim(); const provider = String(options.provider || "").trim().toLowerCase();
  if (!accountId || !provider) return { ok: false, error: "provider_unlink_invalid" };
  if (!oauthProviders.has(provider)) return { ok: false, error: "provider_unlink_unsupported" };
  const result = await transaction(async (client) => {
    const account = await lookupAccount(client, accountId); if (!account) return { ok: false, error: "account_not_found" };
    const providers = Array.isArray(account.linkedProviders) ? account.linkedProviders : []; const target = providers.find((item) => item?.id === provider);
    if (!target) return { ok: false, error: "provider_not_linked" };
    const remaining = providers.filter((item) => item?.id !== provider); const remainingOauth = remaining.filter((item) => oauthProviders.has(item?.id));
    const email = account.primaryEmailCanonical || ""; const emailOwner = email ? await client.query("SELECT account_id FROM account_email_identities WHERE email_canonical = $1", [email]) : { rows: [] };
    const emailSurvives = Boolean(email && account.primaryEmailVerified && emailOwner.rows[0]?.account_id === accountId);
    if (!emailSurvives && remainingOauth.length === 0) return { ok: false, error: "provider_unlink_last_login_method" };
    account.linkedProviders = remaining; if (account.primaryProvider === provider) account.primaryProvider = remainingOauth[0]?.id || "email";
    if (account.emailProvider === provider && emailSurvives) account.emailProvider = remaining.find((item) => item?.emailVerified && String(item.email || "").toLowerCase() === email)?.id || "email";
    account.updatedAt = new Date().toISOString(); account.lastProviderUnlinkAt = account.updatedAt;
    await saveAccount(client, account);
    await client.query("DELETE FROM account_provider_identities WHERE provider = $1 AND account_id = $2", [provider, accountId]);
    return { ok: true, provider, unlinkedUsername: target.username || null, remainingLoginMethods: (emailSurvives ? 1 : 0) + remainingOauth.length, account: publicAccount(account) };
  });
  await refreshRuntimeCache(); return result;
}

export async function migrateLegacyAccounts() {
  if (!databaseEnabled()) return { migrated: false, adapter: "runtime", count: 0 };
  const snapshot = legacyAccountStateSnapshotForMigration();
  const result = await transaction(async (client) => {
    const name = "app_accounts_to_postgres_v1"; const marker = await client.query("SELECT record_count FROM runtime_state_migrations WHERE name = $1 FOR UPDATE", [name]);
    if (marker.rows[0]) return { migrated: false, adapter: "postgres", count: Number(marker.rows[0].record_count || 0) };
    for (const account of Object.values(snapshot.accounts || {})) if (account?.id) await saveAccount(client, account);
    for (const [email, accountId] of Object.entries(snapshot.emails || {})) await client.query("INSERT INTO account_email_identities (email_canonical, account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [email, accountId]);
    for (const [key, accountId] of Object.entries(snapshot.identities || {})) {
      const split = key.indexOf(":"); if (split < 1) continue;
      await client.query("INSERT INTO account_provider_identities (provider, provider_user_id, account_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [key.slice(0, split), key.slice(split + 1), accountId]);
    }
    const count = Object.keys(snapshot.accounts || {}).length;
    await client.query("INSERT INTO runtime_state_migrations (name, record_count, metadata_json) VALUES ($1,$2,$3::jsonb)", [name, count, JSON.stringify({ source: "runtime-store.accounts", schemaVersion: 1 })]);
    return { migrated: true, adapter: "postgres", count };
  });
  await refreshRuntimeCache(); return result;
}
export async function refreshDurableAccountCache() { await refreshRuntimeCache(); }
export function accountStorageStatus() { return { adapter: databaseEnabled() ? "postgres" : "runtime" }; }
