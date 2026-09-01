import { createHash, randomUUID } from "node:crypto";
import { accountIdentityProfile, normalizeHiveHandle, providerAliasDefaults } from "../account-identity.js";
import { accountDeletionAuditSnapshot } from "../account-deletion-audit.js";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  findAccountByEmail as findRuntimeByEmail,
  findAccountByHandle as findRuntimeByHandle,
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
    primaryEmailVerified: account.primaryEmailVerified === true,
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
export async function findAccountByHandle(handle = "") {
  if (!databaseEnabled()) return findRuntimeByHandle(handle);
  const normalized = normalizeHiveHandle(handle);
  if (!normalized) return null;
  const result = await query(
    `SELECT account_json FROM app_accounts
      WHERE lower(hive_handle) = $1 AND status <> 'merged'
      LIMIT 1`,
    [normalized]
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
      account = await lookupAccount(client, id) || {
        id, status: "active", displayName: displayNameFromEmail(canonical), primaryEmailOriginal: options.email,
        primaryEmailCanonical: canonical, primaryEmailVerified: true, primaryProvider: "email", assurance: "low",
        profileVisibility: "public", linkedProviders: [],
        createdAt: now, updatedAt: now, emailLastSeenAt: now,
      };
    }
    mergeProvider(account, providerAliasDefaults({
      id: "email", label: "Email", kind: "email_code", status: "verified",
      maskedEmail: options.maskedEmail || null,
    }));
    account.profileVisibility = account.profileVisibility === "private" ? "private" : "public";
    account.primaryEmailOriginal = options.email || account.primaryEmailOriginal;
    account.primaryEmailCanonical = canonical; account.primaryEmailVerified = true;
    account.primaryProvider ||= "email"; account.assurance ||= "low";
    account.updatedAt = now; account.emailLastSeenAt = now;
    if (account.recoverySource === "durable_profile_census") delete account.recoverySource;
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
      const derivedAccount = await lookupAccount(client, derived);
      const isRecoveredAccount = derivedAccount?.recoverySource === "durable_profile_census";
      accountId = derivedAccount && !isRecoveredAccount ? stableId(`${identityKey(provider, userId)}:refound:${now}`, "acct_oauth") : derived;
    }
    let account = await lookupAccount(client, accountId);
    if (!account) account = { id: accountId, status: "active", displayName: options.displayName || options.username || providerLabel(provider), primaryProvider: provider, assurance: "medium", profileVisibility: "public", linkedProviders: [], createdAt: now };
    mergeProvider(account, linkedProvider({ ...options, provider, providerUserId: userId, email: options.emailInfo?.email || "", emailVerified: options.emailInfo?.verified === true }));
    account.status ||= "active"; account.displayName ||= options.displayName || options.username || providerLabel(provider);
    account.primaryProvider ||= provider; account.assurance = account.assurance === "high" ? "high" : "medium"; account.updatedAt = now; account.lastProviderLoginAt = now;
    if (account.recoverySource === "durable_profile_census") delete account.recoverySource;
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
    const passwordCredential = await client.query(
      "SELECT 1 FROM account_password_credentials WHERE account_id = $1 AND disabled_at IS NULL",
      [accountId]
    );
    const passwordSurvives = Boolean(passwordCredential.rows[0]);
    if (!emailSurvives && !passwordSurvives && remainingOauth.length === 0) return { ok: false, error: "provider_unlink_last_login_method" };
    account.linkedProviders = remaining; if (account.primaryProvider === provider) account.primaryProvider = remainingOauth[0]?.id || "email";
    if (account.emailProvider === provider && emailSurvives) account.emailProvider = remaining.find((item) => item?.emailVerified && String(item.email || "").toLowerCase() === email)?.id || "email";
    account.updatedAt = new Date().toISOString(); account.lastProviderUnlinkAt = account.updatedAt;
    await saveAccount(client, account);
    await client.query("DELETE FROM account_provider_identities WHERE provider = $1 AND account_id = $2", [provider, accountId]);
    return { ok: true, provider, unlinkedUsername: target.username || null, remainingLoginMethods: (emailSurvives ? 1 : 0) + (passwordSurvives ? 1 : 0) + remainingOauth.length, account: publicAccount(account) };
  });
  await refreshRuntimeCache(); return result;
}

function accountRecoveryError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function quoteSqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function unexpectedAccountOwnershipRows(client, sourceAccountId) {
  const allowed = new Set([
    "app_accounts.account_id",
    "account_provider_identities.account_id",
    "account_email_identities.account_id",
    "account_linked_wallets.account_id",
    "pftl_sync_wallets.account_id",
    "pftl_pointer_observations.account_id",
    "auth_sessions.account_id",
    "billing_accounts.account_id",
    "billing_ledger_entries.account_id",
    "user_observability_events.account_id",
    "account_merge_events.source_account_id",
    "account_merge_events.target_account_id",
    "account_merge_events.actor_account_id",
  ]);
  const ownershipColumns = await client.query(
    `SELECT columns.table_name, columns.column_name
       FROM information_schema.columns columns
       JOIN information_schema.tables tables
         ON tables.table_schema = columns.table_schema
        AND tables.table_name = columns.table_name
      WHERE columns.table_schema = 'public'
        AND tables.table_type = 'BASE TABLE'
        AND (columns.column_name = 'account_id' OR columns.column_name LIKE '%\\_account\\_id' ESCAPE '\\')
      ORDER BY columns.table_name, columns.column_name`
  );
  const unexpected = [];
  for (const row of ownershipColumns.rows) {
    if (allowed.has(`${row.table_name}.${row.column_name}`)) continue;
    const count = await client.query(
      `SELECT count(*)::integer AS count FROM ${quoteSqlIdentifier(row.table_name)}
        WHERE ${quoteSqlIdentifier(row.column_name)} = $1`,
      [sourceAccountId]
    );
    const rowCount = Number(count.rows[0]?.count || 0);
    if (rowCount > 0) unexpected.push({ table: row.table_name, column: row.column_name, count: rowCount });
  }
  return unexpected;
}

export async function recoverSplitProviderAccount(options = {}) {
  if (!databaseEnabled()) throw accountRecoveryError("account_recovery_database_required");
  const sourceAccountId = String(options.sourceAccountId || "").trim();
  const targetAccountId = String(options.targetAccountId || "").trim();
  const provider = String(options.provider || "").trim().toLowerCase();
  const providerUserId = String(options.providerUserId || "").trim();
  const expectedWalletAddress = String(options.expectedWalletAddress || "").trim();
  const actorAccountId = String(options.actorAccountId || "").trim();
  const actorOperator = String(options.actorOperator || "").trim();
  const reason = String(options.reason || "").trim();
  const dryRun = options.dryRun === true;
  const expectedTargetTaskCount = Number.isInteger(options.expectedTargetTaskCount)
    ? options.expectedTargetTaskCount
    : null;
  const expectedTargetVerifiedBadgeCount = Number.isInteger(options.expectedTargetVerifiedBadgeCount)
    ? options.expectedTargetVerifiedBadgeCount
    : null;

  if (!sourceAccountId || !targetAccountId || sourceAccountId === targetAccountId) {
    throw accountRecoveryError("account_recovery_ids_invalid");
  }
  if (!provider || !providerUserId) throw accountRecoveryError("account_recovery_provider_identity_required");
  if (!expectedWalletAddress) throw accountRecoveryError("account_recovery_wallet_required");
  if (!actorOperator) throw accountRecoveryError("account_recovery_operator_required");
  if (!reason) throw accountRecoveryError("account_recovery_reason_required");
  if (stableId(identityKey(provider, providerUserId), "acct_oauth") !== targetAccountId) {
    throw accountRecoveryError("account_recovery_target_identity_mismatch");
  }

  const result = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`account-recovery:${sourceAccountId}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`account-recovery:${targetAccountId}`]);

    const priorMerge = await client.query(
      `SELECT id, created_at FROM account_merge_events
        WHERE source_account_id = $1 AND target_account_id = $2
        LIMIT 1`,
      [sourceAccountId, targetAccountId]
    );
    if (priorMerge.rows[0]) {
      return {
        ok: true,
        dryRun: false,
        alreadyMerged: true,
        mergeEventId: priorMerge.rows[0].id,
        mergedAt: priorMerge.rows[0].created_at,
        sourceAccountId,
        targetAccountId,
      };
    }

    const source = await lookupAccount(client, sourceAccountId);
    const target = await lookupAccount(client, targetAccountId);
    if (!source) throw accountRecoveryError("account_recovery_source_not_found");
    if (!target) throw accountRecoveryError("account_recovery_target_not_found");
    if (source.status !== "active") throw accountRecoveryError("account_recovery_source_not_active", source.status || "unknown");
    if (target.status !== "active") throw accountRecoveryError("account_recovery_target_not_active", target.status || "unknown");
    if (target.recoverySource !== "durable_profile_census") {
      throw accountRecoveryError("account_recovery_target_not_recovered");
    }

    const providerIdentities = await client.query(
      `SELECT provider, provider_user_id, identity_json
         FROM account_provider_identities
        WHERE account_id = $1
        ORDER BY provider, provider_user_id
        FOR UPDATE`,
      [sourceAccountId]
    );
    if (
      providerIdentities.rows.length !== 1
      || providerIdentities.rows[0].provider !== provider
      || providerIdentities.rows[0].provider_user_id !== providerUserId
    ) {
      throw accountRecoveryError("account_recovery_source_identity_mismatch");
    }
    const targetProviderIdentity = await client.query(
      `SELECT account_id FROM account_provider_identities
        WHERE provider = $1 AND provider_user_id = $2
        FOR UPDATE`,
      [provider, providerUserId]
    );
    if (targetProviderIdentity.rows[0]?.account_id !== sourceAccountId) {
      throw accountRecoveryError("account_recovery_identity_owner_changed");
    }

    const emailIdentities = await client.query(
      "SELECT email_canonical FROM account_email_identities WHERE account_id = $1 FOR UPDATE",
      [sourceAccountId]
    );
    const sourceWallets = await client.query(
      "SELECT wallet_address, status FROM account_linked_wallets WHERE account_id = $1 FOR UPDATE",
      [sourceAccountId]
    );
    const targetWallets = await client.query(
      "SELECT wallet_address, status FROM account_linked_wallets WHERE account_id = $1 FOR UPDATE",
      [targetAccountId]
    );
    if (
      sourceWallets.rows.length !== 1
      || sourceWallets.rows[0].wallet_address !== expectedWalletAddress
      || sourceWallets.rows[0].status !== "linked"
    ) {
      throw accountRecoveryError("account_recovery_source_wallet_mismatch");
    }
    if (targetWallets.rows.length !== 0) {
      throw accountRecoveryError("account_recovery_target_wallet_conflict");
    }

    const syncWallets = await client.query(
      "SELECT wallet_address FROM pftl_sync_wallets WHERE account_id = $1 FOR UPDATE",
      [sourceAccountId]
    );
    if (
      syncWallets.rows.length !== 1
      || syncWallets.rows[0].wallet_address !== expectedWalletAddress
    ) {
      throw accountRecoveryError("account_recovery_sync_wallet_mismatch");
    }
    const pointerWalletMismatch = await client.query(
      `SELECT count(*)::integer AS count FROM pftl_pointer_observations
        WHERE account_id = $1 AND wallet_address <> $2`,
      [sourceAccountId, expectedWalletAddress]
    );
    if (Number(pointerWalletMismatch.rows[0]?.count || 0) > 0) {
      throw accountRecoveryError("account_recovery_pointer_wallet_mismatch");
    }

    const sourceBilling = await client.query(
      `SELECT status, current_spend_usd, current_credit_usd, ledger_entry_count
         FROM billing_accounts WHERE account_id = $1 FOR UPDATE`,
      [sourceAccountId]
    );
    const sourceLedger = await client.query(
      `SELECT kind, amount_usd, source FROM billing_ledger_entries
        WHERE account_id = $1 ORDER BY created_at FOR UPDATE`,
      [sourceAccountId]
    );
    if (
      sourceBilling.rows.length !== 1
      || sourceBilling.rows[0].status !== "active"
      || Number(sourceBilling.rows[0].current_spend_usd) !== 0
      || Number(sourceBilling.rows[0].current_credit_usd) !== 5
      || Number(sourceBilling.rows[0].ledger_entry_count) !== 1
      || sourceLedger.rows.length !== 1
      || sourceLedger.rows[0].kind !== "account_credit"
      || Number(sourceLedger.rows[0].amount_usd) !== 5
      || sourceLedger.rows[0].source !== "initial_provider_credit"
    ) {
      throw accountRecoveryError("account_recovery_source_billing_not_pristine");
    }

    const unexpectedOwnership = await unexpectedAccountOwnershipRows(client, sourceAccountId);
    if (unexpectedOwnership.length > 0) {
      throw accountRecoveryError("account_recovery_source_has_durable_activity", JSON.stringify(unexpectedOwnership));
    }

    const targetCounts = await client.query(
      `SELECT
         (SELECT count(*)::integer FROM task_projections WHERE account_id = $1) AS task_count,
         (SELECT count(*)::integer FROM account_network_badges WHERE account_id = $1 AND status = 'verified') AS verified_badge_count,
         (SELECT count(*)::integer FROM task_projections
           WHERE account_id = $1 AND subject_wallet <> '' AND subject_wallet <> $2) AS mismatched_task_wallet_count`,
      [targetAccountId, expectedWalletAddress]
    );
    const targetTaskCount = Number(targetCounts.rows[0]?.task_count || 0);
    const targetVerifiedBadgeCount = Number(targetCounts.rows[0]?.verified_badge_count || 0);
    if (Number(targetCounts.rows[0]?.mismatched_task_wallet_count || 0) > 0) {
      throw accountRecoveryError("account_recovery_target_task_wallet_mismatch");
    }
    if (expectedTargetTaskCount !== null && targetTaskCount !== expectedTargetTaskCount) {
      throw accountRecoveryError("account_recovery_target_task_count_changed", String(targetTaskCount));
    }
    if (
      expectedTargetVerifiedBadgeCount !== null
      && targetVerifiedBadgeCount !== expectedTargetVerifiedBadgeCount
    ) {
      throw accountRecoveryError("account_recovery_target_badge_count_changed", String(targetVerifiedBadgeCount));
    }

    const preview = {
      ok: true,
      dryRun,
      alreadyMerged: false,
      sourceAccountId,
      targetAccountId,
      provider,
      walletAddress: expectedWalletAddress,
      targetTaskCount,
      targetVerifiedBadgeCount,
      emailIdentityCount: emailIdentities.rows.length,
      pointerObservationCount: Number((
        await client.query(
          "SELECT count(*)::integer AS count FROM pftl_pointer_observations WHERE account_id = $1",
          [sourceAccountId]
        )
      ).rows[0]?.count || 0),
      activeSessionCount: Number((
        await client.query(
          `SELECT count(*)::integer AS count FROM auth_sessions
            WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
          [sourceAccountId]
        )
      ).rows[0]?.count || 0),
    };
    if (dryRun) return preview;

    const now = new Date().toISOString();
    const sourceHandle = String(source.hiveHandle || "").trim();
    const archivedSource = {
      ...source,
      status: "merged",
      displayName: "Merged account",
      hiveHandle: "",
      publicDisplayName: "",
      profileDiscoverable: false,
      linkedProviders: [],
      primaryProvider: "merged",
      mergedIntoAccountId: targetAccountId,
      mergedAt: now,
      mergeReason: reason,
      updatedAt: now,
    };
    for (const key of [
      "primaryEmailOriginal",
      "primaryEmailCanonical",
      "primaryEmailVerified",
      "emailProvider",
      "emailLastSeenAt",
      "lastProviderLoginAt",
      "lastProviderLinkAt",
    ]) delete archivedSource[key];
    await client.query(
      `UPDATE app_accounts
          SET account_json = $2::jsonb, hive_handle = NULL, status = 'merged', updated_at = $3
        WHERE account_id = $1`,
      [sourceAccountId, JSON.stringify(archivedSource), now]
    );

    for (const incoming of Array.isArray(source.linkedProviders) ? source.linkedProviders : []) {
      mergeProvider(target, incoming);
    }
    if (!target.hiveHandle && sourceHandle) target.hiveHandle = sourceHandle;
    target.primaryProvider = source.primaryProvider || target.primaryProvider || provider;
    target.assurance = target.assurance === "high" || source.assurance === "high" ? "high" : "medium";
    for (const key of [
      "primaryEmailOriginal",
      "primaryEmailCanonical",
      "primaryEmailVerified",
      "emailProvider",
      "emailLastSeenAt",
      "lastProviderLoginAt",
    ]) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== "") target[key] = source[key];
    }
    target.status = "active";
    target.updatedAt = now;
    target.recoveredFromSplitAccountId = sourceAccountId;
    target.recoveredFromSplitAt = now;
    delete target.recoverySource;
    await saveAccount(client, target);

    const providerMove = await client.query(
      "UPDATE account_provider_identities SET account_id = $2, updated_at = now() WHERE account_id = $1",
      [sourceAccountId, targetAccountId]
    );
    const emailMove = await client.query(
      "UPDATE account_email_identities SET account_id = $2, updated_at = now() WHERE account_id = $1",
      [sourceAccountId, targetAccountId]
    );
    const walletMove = await client.query(
      "UPDATE account_linked_wallets SET account_id = $2, updated_at = now() WHERE account_id = $1",
      [sourceAccountId, targetAccountId]
    );
    const syncWalletMove = await client.query(
      "UPDATE pftl_sync_wallets SET account_id = $2, updated_at = now() WHERE account_id = $1",
      [sourceAccountId, targetAccountId]
    );
    const pointerMove = await client.query(
      "UPDATE pftl_pointer_observations SET account_id = $2, updated_at = now() WHERE account_id = $1",
      [sourceAccountId, targetAccountId]
    );
    const sessionPayload = publicAccount(target);
    const sessionMove = await client.query(
      `UPDATE auth_sessions
          SET account_id = $2,
              primary_provider = $3,
              assurance = $4,
              session_json = session_json || $5::jsonb
        WHERE account_id = $1`,
      [sourceAccountId, targetAccountId, target.primaryProvider || provider, target.assurance || "medium", JSON.stringify({
        accountId: targetAccountId,
        displayName: sessionPayload.displayName,
        hiveHandle: sessionPayload.hiveHandle,
        publicDisplayName: sessionPayload.publicDisplayName,
        profileVisibility: sessionPayload.profileVisibility,
        primaryProvider: sessionPayload.primaryProvider,
        linkedProviders: sessionPayload.linkedProviders,
      })]
    );
    await client.query(
      "UPDATE billing_accounts SET status = 'merged', updated_at = now() WHERE account_id = $1",
      [sourceAccountId]
    );

    const mergeEventId = `merge_${randomUUID()}`;
    const metadata = {
      provider,
      walletAddress: expectedWalletAddress,
      targetTaskCount,
      targetVerifiedBadgeCount,
      moved: {
        providerIdentities: providerMove.rowCount,
        emailIdentities: emailMove.rowCount,
        linkedWallets: walletMove.rowCount,
        syncWallets: syncWalletMove.rowCount,
        pointerObservations: pointerMove.rowCount,
        sessions: sessionMove.rowCount,
      },
      duplicateSignupCreditRetainedOnArchivedSourceUsd: 5,
    };
    await client.query(
      `INSERT INTO account_merge_events (
         id, source_account_id, target_account_id, actor_account_id, actor_operator,
         reason, status, metadata_json, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'completed',$7::jsonb,$8)`,
      [
        mergeEventId,
        sourceAccountId,
        targetAccountId,
        actorAccountId,
        actorOperator,
        reason,
        JSON.stringify(metadata),
        now,
      ]
    );
    for (const [eventType, accountId, publicHandle] of [
      ["user.account.merged", sourceAccountId, ""],
      ["user.account.recovered", targetAccountId, target.hiveHandle || ""],
    ]) {
      await client.query(
        `INSERT INTO user_observability_events (
           id, occurred_at, received_at, event_type, account_id, public_handle,
           wallet_address, provider, source_surface, result_status, reason_code,
           metadata_json, privacy_class
         ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'operator_account_recovery','success',
                   'split_provider_account_repaired',$8::jsonb,'security')`,
        [
          `uobs_${randomUUID()}`,
          now,
          eventType,
          accountId,
          publicHandle,
          expectedWalletAddress,
          provider,
          JSON.stringify({ mergeEventId, sourceAccountId, targetAccountId, actorOperator }),
        ]
      );
    }
    return { ...preview, dryRun: false, mergeEventId, moved: metadata.moved };
  });
  if (!dryRun && !result.alreadyMerged) await refreshRuntimeCache();
  return result;
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
