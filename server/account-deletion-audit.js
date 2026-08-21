import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query } from "./db/pool.js";

function stableId(value, prefix) {
  const digest = createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function digest(value = "") {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function csvSet(value = "") {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function normalizedWallet(value = "") {
  return String(value || "").trim();
}

function textArray(value = []) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

export function faucetProviderIdentityHash(provider, providerUserId) {
  return stableId(`${String(provider || "").toLowerCase()}:${String(providerUserId || "")}`, "identity");
}

export function accountDeletionEmailHash(email = "") {
  const canonical = String(email || "").trim().toLowerCase();
  return canonical ? stableId(`email:${canonical}`, "identity") : "";
}

export function accountDeletionActorHash(actorSessionId = "") {
  const value = String(actorSessionId || "").trim();
  return value ? `session_${digest(value).slice(0, 24)}` : "";
}

export function accountDeletionAccountHash(accountId = "") {
  const value = String(accountId || "").trim();
  return value ? stableId(`account:${value}`, "identity") : "";
}

export function accountDeletionWalletHash(walletAddress = "") {
  const value = normalizedWallet(walletAddress).toLowerCase();
  return value ? stableId(`wallet:${value}`, "identity") : "";
}

export function accountDeletionFaucetGuardEnabled(env = process.env) {
  const raw = String(env.TASKNODE_DELETION_FAUCET_GUARD_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "disabled", "no"].includes(raw);
}

export function accountDeletionFaucetGuardExemption({
  accountId = "",
  walletAddress = "",
  providerIdentityHashes = [],
  emailHash = "",
  env = process.env,
} = {}) {
  if (!accountDeletionFaucetGuardEnabled(env)) {
    return { exempt: true, reason: "guard_disabled" };
  }

  const accountIds = csvSet(env.TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_ACCOUNT_IDS);
  if (accountId && accountIds.has(accountId)) return { exempt: true, reason: "account_exempt" };

  const wallets = new Set(
    [...csvSet(env.TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_WALLETS)]
      .map((item) => item.toLowerCase())
  );
  if (walletAddress && wallets.has(normalizedWallet(walletAddress).toLowerCase())) {
    return { exempt: true, reason: "wallet_exempt" };
  }

  const identityHashes = csvSet(env.TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_IDENTITY_HASHES);
  for (const identityHash of textArray(providerIdentityHashes)) {
    if (identityHashes.has(identityHash)) return { exempt: true, reason: "identity_exempt" };
  }

  const emailHashes = csvSet(env.TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_EMAIL_HASHES);
  if (emailHash && emailHashes.has(emailHash)) return { exempt: true, reason: "email_exempt" };

  return { exempt: false, reason: null };
}

export function accountDeletionAuditSnapshot(account = null) {
  if (!account) {
    return {
      providerIdentityHashes: [],
      providers: [],
      primaryEmailHash: "",
      profile: {},
    };
  }

  const linkedProviders = Array.isArray(account.linkedProviders) ? account.linkedProviders : [];
  const oauthProviders = linkedProviders
    .filter((provider) => {
      const id = String(provider?.id || "").trim().toLowerCase();
      if (!id || id === "email" || id === "dev" || id === "wallet") return false;
      return provider?.kind === "oauth" && provider?.providerUserId;
    })
    .map((provider) => ({
      provider: String(provider.id || "").trim().toLowerCase(),
      providerUserIdHash: faucetProviderIdentityHash(provider.id, provider.providerUserId),
      username: provider.username || null,
      displayName: provider.displayName || null,
    }));

  return {
    providerIdentityHashes: oauthProviders.map((provider) => provider.providerUserIdHash),
    providers: oauthProviders,
    primaryEmailHash: accountDeletionEmailHash(account.primaryEmailCanonical || ""),
    profile: {
      displayName: account.displayName || null,
      hiveHandle: account.hiveHandle || null,
      publicDisplayName: account.publicDisplayName || null,
      primaryProvider: account.primaryProvider || null,
      createdAt: account.createdAt || null,
      updatedAt: account.updatedAt || null,
    },
  };
}

export function buildAccountDeletionAuditRecord({
  account = null,
  accountId = "",
  archiveId = "",
  walletAddress = "",
  ethereumDepositAddress = "",
  reason = "user_requested_account_delete",
  actorSessionId = "",
  now = new Date().toISOString(),
} = {}) {
  const snapshot = Array.isArray(account?.providerIdentityHashes)
    ? {
        providerIdentityHashes: textArray(account.providerIdentityHashes),
        providers: Array.isArray(account.providers) ? account.providers : [],
        primaryEmailHash: account.primaryEmailHash || "",
        profile: account.profile && typeof account.profile === "object" ? account.profile : {},
      }
    : accountDeletionAuditSnapshot(account);
  return {
    id: `acct_delete_${randomUUID()}`,
    accountId: accountDeletionAccountHash(accountId),
    archiveId: String(archiveId || "").trim(),
    reason: String(reason || "").trim() === "operator_requested_account_delete"
      ? "operator_requested_account_delete"
      : "user_requested_account_delete",
    deletedAt: now,
    walletAddress: accountDeletionWalletHash(walletAddress),
    ethereumDepositAddress: accountDeletionWalletHash(ethereumDepositAddress),
    providerIdentityHashes: snapshot.providerIdentityHashes,
    providers: snapshot.providers.map((provider) => ({
      provider: String(provider?.provider || "").trim().toLowerCase(),
      providerUserIdHash: String(provider?.providerUserIdHash || "").trim(),
    })),
    primaryEmailHash: snapshot.primaryEmailHash,
    actorSessionHash: accountDeletionActorHash(actorSessionId),
    metadata: {
      schemaVersion: 2,
      retainedPurpose: "fraud_prevention_and_financial_record_integrity",
    },
  };
}

export function publicAccountDeletionAudit(row = null, input = {}) {
  if (!row) return null;
  const providerIdentityHashes = textArray(row.provider_identity_hashes || row.providerIdentityHashes);
  const inputHashes = new Set(textArray(input.providerIdentityHashes));
  const wallet = normalizedWallet(input.walletAddress);
  const walletHash = accountDeletionWalletHash(wallet);
  let matchReason = "account_deleted";
  if (wallet && [row.wallet_address, row.ethereum_deposit_address, row.walletAddress, row.ethereumDepositAddress].some((item) => {
    const stored = normalizedWallet(item);
    return stored === walletHash || stored.toLowerCase() === wallet.toLowerCase();
  })) {
    matchReason = "wallet_deleted";
  } else if (providerIdentityHashes.some((hash) => inputHashes.has(hash))) {
    matchReason = "provider_identity_deleted";
  } else if (input.emailHash && input.emailHash === (row.primary_email_hash || row.primaryEmailHash)) {
    matchReason = "email_deleted";
  }
  return {
    id: row.id,
    archiveId: row.archive_id || row.archiveId || "",
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : row.deletedAt || null,
    reason: row.reason || "",
    matchReason,
  };
}

export function findRuntimeBlockingAccountDeletionAudit({ state = {}, accountId = "", walletAddress = "", providerIdentityHashes = [], emailHash = "" } = {}) {
  const exemption = accountDeletionFaucetGuardExemption({ accountId, walletAddress, providerIdentityHashes, emailHash });
  if (exemption.exempt) return null;

  const rows = Array.isArray(state.accountDeletionAudit) ? state.accountDeletionAudit : [];
  const wallet = normalizedWallet(walletAddress).toLowerCase();
  const walletHash = accountDeletionWalletHash(wallet);
  const accountHash = accountDeletionAccountHash(accountId);
  const identitySet = new Set(textArray(providerIdentityHashes));
  return rows
    .filter((row) => {
      if (!row) return false;
      if (accountId && (row.accountId === accountId || row.accountId === accountHash)) return true;
      if (wallet && [row.walletAddress, row.ethereumDepositAddress].some((item) => {
        const stored = normalizedWallet(item);
        return stored === walletHash || stored.toLowerCase() === wallet;
      })) return true;
      if (emailHash && row.primaryEmailHash === emailHash) return true;
      return textArray(row.providerIdentityHashes).some((hash) => identitySet.has(hash));
    })
    .sort((left, right) => (Date.parse(right.deletedAt || "") || 0) - (Date.parse(left.deletedAt || "") || 0))
    .map((row) => publicAccountDeletionAudit(row, { walletAddress, providerIdentityHashes, emailHash }))[0] || null;
}

export async function insertAccountDeletionAuditRecord(record, { client = null } = {}) {
  if (!databaseEnabled()) return { ok: true, skipped: true };
  const runner = client || { query };
  await runner.query(
    `INSERT INTO account_deletion_audit (
       id, account_id, archive_id, reason, deleted_at, wallet_address,
       ethereum_deposit_address, provider_identity_hashes, provider_summaries_json,
       primary_email_hash, actor_session_hash, metadata_json
     ) VALUES (
       $1, $2, $3, $4, $5::timestamptz, $6,
       $7, $8::text[], $9::jsonb,
       $10, $11, $12::jsonb
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      record.id,
      record.accountId,
      record.archiveId,
      record.reason,
      record.deletedAt,
      record.walletAddress,
      record.ethereumDepositAddress,
      record.providerIdentityHashes,
      JSON.stringify(record.providers || []),
      record.primaryEmailHash,
      record.actorSessionHash,
      JSON.stringify(record.metadata || {}),
    ]
  );
  return { ok: true, id: record.id };
}

export async function findBlockingAccountDeletionFaucetAudit({
  accountId = "",
  walletAddress = "",
  providerIdentityHashes = [],
  emailHash = "",
} = {}) {
  if (!databaseEnabled()) return null;

  const hashes = textArray(providerIdentityHashes);
  const exemption = accountDeletionFaucetGuardExemption({ accountId, walletAddress, providerIdentityHashes: hashes, emailHash });
  if (exemption.exempt) return null;

  const filters = [];
  const params = [];
  if (accountId) {
    params.push(accountDeletionAccountHash(accountId));
    filters.push(`account_id = $${params.length}`);
  }
  if (walletAddress) {
    params.push([normalizedWallet(walletAddress), accountDeletionWalletHash(walletAddress)]);
    filters.push(`(wallet_address = ANY($${params.length}::text[]) OR ethereum_deposit_address = ANY($${params.length}::text[]))`);
  }
  if (hashes.length > 0) {
    params.push(hashes);
    filters.push(`provider_identity_hashes && $${params.length}::text[]`);
  }
  if (emailHash) {
    params.push(emailHash);
    filters.push(`primary_email_hash = $${params.length}`);
  }
  if (filters.length === 0) return null;

  const result = await query(
    `SELECT *
       FROM account_deletion_audit
      WHERE ${filters.join(" OR ")}
      ORDER BY deleted_at DESC
      LIMIT 1`,
    params
  );
  return publicAccountDeletionAudit(result.rows[0], { walletAddress, providerIdentityHashes: hashes, emailHash });
}
