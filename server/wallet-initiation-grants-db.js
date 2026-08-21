import { databaseEnabled, query } from "./db/pool.js";
import { findBlockingAccountDeletionFaucetAudit } from "./account-deletion-audit.js";

const BLOCKING_STATUSES = ["processing", "completed", "unknown"];

function publicGrantFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    accountId: row.account_id,
    walletAddress: row.wallet_address,
    amountPft: Number(row.amount_pft || 0),
    amountDrops: row.amount_drops || "",
    source: row.source || "wallet_create",
    txHash: row.tx_hash || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    error: row.error_message || null,
  };
}

export async function findBlockingWalletInitiationGrant({ accountId = "", walletAddress = "" } = {}) {
  if (!databaseEnabled()) return null;

  const filters = [];
  const params = [BLOCKING_STATUSES];
  if (accountId) {
    params.push(accountId);
    filters.push(`account_id = $${params.length}`);
  }
  if (walletAddress) {
    params.push(walletAddress);
    filters.push(`wallet_address = $${params.length}`);
  }
  if (filters.length === 0) return null;

  const result = await query(
    `SELECT *
       FROM wallet_initiation_grants
      WHERE status = ANY($1::text[])
        AND (${filters.join(" OR ")})
      ORDER BY updated_at DESC
      LIMIT 1`,
    params
  );
  return publicGrantFromRow(result.rows[0]);
}

export async function mergeWalletInitiationGrantStatus(status, { accountId = "", walletAddress = "" } = {}) {
  if (!status || !databaseEnabled() || status.eligible === false) return status;

  const providerIdentityHashes = Array.isArray(status.identities)
    ? status.identities.map((identity) => identity?.providerUserIdHash).filter(Boolean)
    : [];
  const deletionAudit = await findBlockingAccountDeletionFaucetAudit({
    accountId,
    walletAddress,
    providerIdentityHashes,
    emailHash: status.emailHash || "",
  });
  if (deletionAudit) {
    return {
      ...status,
      eligible: false,
      reason: "deleted_account_faucet_guard",
      message: "This sign-in identity previously deleted a Task Node account and is not eligible for another wallet initiation gift.",
      deletionAudit,
    };
  }

  const blocking = await findBlockingWalletInitiationGrant({ accountId, walletAddress });
  if (!blocking) return status;

  const message = blocking.status === "completed"
    ? "This account already received its wallet initiation gift."
    : "This account already has a wallet initiation gift in progress.";
  return {
    ...status,
    eligible: false,
    reason: blocking.accountId === accountId ? "account_registered" : "wallet_registered",
    message,
    grant: blocking,
  };
}

export async function reserveWalletInitiationGrantRecord(grant) {
  if (!databaseEnabled()) return { ok: true, skipped: true };

  try {
    await query(
      `INSERT INTO wallet_initiation_grants (
         id, account_id, wallet_address, source, amount_pft, amount_drops, status, trigger_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7::jsonb, $8::timestamptz, $9::timestamptz)`,
      [
        grant.id,
        grant.accountId,
        grant.walletAddress,
        grant.source || "wallet_create",
        grant.amountPft,
        grant.amountDrops,
        grant.trigger ? JSON.stringify(grant.trigger) : null,
        grant.createdAt,
        grant.updatedAt,
      ]
    );
    return { ok: true };
  } catch (error) {
    if (error?.code !== "23505") throw error;
    const blocking = await findBlockingWalletInitiationGrant({
      accountId: grant.accountId,
      walletAddress: grant.walletAddress,
    });
    return {
      ok: false,
      error: blocking?.accountId === grant.accountId ? "account_registered" : "wallet_registered",
      grant: blocking,
    };
  }
}

export async function updateWalletInitiationGrantRecord({
  grantId = "",
  status = "",
  txHash = "",
  faucetAddress = "",
  error = "",
} = {}) {
  if (!databaseEnabled() || !grantId) return { ok: true, skipped: true };

  await query(
    `UPDATE wallet_initiation_grants
        SET status = $2,
            tx_hash = COALESCE(NULLIF($3, ''), tx_hash),
            faucet_address = COALESCE(NULLIF($4, ''), faucet_address),
            error_message = COALESCE(NULLIF($5, ''), error_message),
            updated_at = now()
      WHERE id = $1`,
    [grantId, status, txHash || "", faucetAddress || "", error || ""]
  );
  return { ok: true };
}
