import { createHash } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  delinkWalletFromAccount as delinkRuntimeWallet,
  getLinkedWallet as getRuntimeWallet,
  legacyAccountWalletSnapshotForMigration,
  linkWalletToAccount as linkRuntimeWallet,
} from "../runtime-store.js";

const unlinkedWallet = Object.freeze({
  status: "not_linked",
  address: null,
  publicKey: null,
  tasknodeEncryptionPubkey: "",
  custody: "local_seed_required",
});

function signatureHash(signature = "") {
  return `sig_${createHash("sha256").update(String(signature || "")).digest("hex").slice(0, 24)}`;
}

function walletFromRow(row = null) {
  if (!row) return { ...unlinkedWallet };
  const proof = row.proof_json && typeof row.proof_json === "object" ? row.proof_json : {};
  return {
    accountId: row.account_id,
    status: row.status || "linked",
    address: row.wallet_address,
    publicKey: row.public_key || "",
    tasknodeEncryptionPubkey: row.encryption_public_key || "",
    custody: row.custody || "local_seed_required",
    proofPurpose: row.proof_purpose || proof.purpose || null,
    walletCreatedInAccount: row.wallet_created_in_account === true,
    proof,
    linkedAt: row.linked_at ? new Date(row.linked_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const selectColumns = `account_id, wallet_address, status, public_key, encryption_public_key,
  custody, proof_purpose, wallet_created_in_account, proof_json, linked_at, updated_at`;

export async function getLinkedWallet({ accountId = "" } = {}) {
  if (!databaseEnabled()) return getRuntimeWallet({ accountId });
  if (!accountId) return { ...unlinkedWallet };
  const result = await query(
    `SELECT ${selectColumns} FROM account_linked_wallets
      WHERE account_id = $1 AND status = 'linked' LIMIT 1`,
    [String(accountId)]
  );
  return walletFromRow(result.rows[0]);
}

export async function findLinkedWalletOwner({ address = "" } = {}) {
  if (!databaseEnabled()) return null;
  const result = await query(
    `SELECT ${selectColumns} FROM account_linked_wallets
      WHERE wallet_address = $1 AND status = 'linked'
      ORDER BY updated_at DESC LIMIT 1`,
    [String(address || "").trim()]
  );
  const wallet = walletFromRow(result.rows[0]);
  return wallet.address ? { accountId: wallet.accountId, wallet } : null;
}

export async function linkWalletToAccount(options = {}) {
  if (!databaseEnabled()) return linkRuntimeWallet(options);
  const accountId = String(options.accountId || "").trim();
  const address = String(options.address || "").trim();
  if (!accountId) return { ok: false, status: 401, error: "wallet_login_required" };
  if (!address) return { ok: false, status: 400, error: "wallet_address_required" };
  const result = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wallet:${address}`]);
    const owner = await client.query(
      `SELECT ${selectColumns} FROM account_linked_wallets
        WHERE wallet_address = $1 AND account_id <> $2 AND status = 'linked'
        LIMIT 1 FOR UPDATE`,
      [address, accountId]
    );
    if (owner.rows[0]) {
      return {
        conflict: true,
        ownerAccountId: owner.rows[0].account_id,
      };
    }
    const prior = await client.query(
      `SELECT ${selectColumns} FROM account_linked_wallets WHERE account_id = $1 FOR UPDATE`,
      [accountId]
    );
    const previous = walletFromRow(prior.rows[0]);
    const linkedAt = previous.address ? previous.linkedAt : new Date().toISOString();
    const proofPurpose = String(options.proofPurpose || "wallet_link");
    const proof = { challengeId: String(options.challengeId || ""), purpose: proofPurpose, signatureHash: signatureHash(options.signature) };
    const saved = await client.query(
      `INSERT INTO account_linked_wallets (
         account_id, wallet_address, status, public_key, encryption_public_key,
         custody, proof_purpose, wallet_created_in_account, proof_json, linked_at, updated_at
       ) VALUES ($1, $2, 'linked', $3, $4, 'local_seed_required', $5, $6, $7::jsonb, $8, now())
       ON CONFLICT (account_id) DO UPDATE SET
         wallet_address = EXCLUDED.wallet_address, status = 'linked', public_key = EXCLUDED.public_key,
         encryption_public_key = EXCLUDED.encryption_public_key, custody = EXCLUDED.custody,
         proof_purpose = EXCLUDED.proof_purpose,
         wallet_created_in_account = account_linked_wallets.wallet_created_in_account OR EXCLUDED.wallet_created_in_account,
         proof_json = EXCLUDED.proof_json, linked_at = COALESCE(account_linked_wallets.linked_at, EXCLUDED.linked_at),
         updated_at = now()
       RETURNING ${selectColumns}`,
      [
        accountId, address, String(options.publicKey || "").trim(), String(options.tasknodeEncryptionPubkey || "").trim(),
        proofPurpose, proofPurpose === "wallet_create", JSON.stringify(proof), linkedAt,
      ]
    );
    return { wallet: walletFromRow(saved.rows[0]) };
  });
  if (result.conflict) {
    return { ok: false, status: 409, error: "wallet_owned_by_other_account" };
  }
  try { linkRuntimeWallet({ ...options, databaseMirror: false }); } catch { /* Postgres remains authoritative. */ }
  return { ok: true, wallet: result.wallet, reclaimedWalletCount: 0 };
}

export async function delinkWalletFromAccount(options = {}) {
  if (!databaseEnabled()) return delinkRuntimeWallet(options);
  const accountId = String(options.accountId || "").trim();
  if (!accountId) return { ok: false, status: 401, error: "wallet_login_required" };
  const result = await transaction(async (client) => {
    const deleted = await client.query(
      `DELETE FROM account_linked_wallets WHERE account_id = $1 AND status = 'linked'
       RETURNING ${selectColumns}`,
      [accountId]
    );
    return deleted.rows[0] || null;
  });
  if (!result) return { ok: false, status: 409, error: "wallet_not_linked" };
  try { delinkRuntimeWallet({ ...options, databaseMirror: false }); } catch { /* Postgres remains authoritative. */ }
  return { ok: true, wallet: { ...walletFromRow(result), status: "delinked", delinkedAt: new Date().toISOString() } };
}

export function accountWalletStorageStatus() {
  return { adapter: databaseEnabled() ? "postgres" : "runtime" };
}

export async function migrateLegacyAccountWallets() {
  if (!databaseEnabled()) return { migrated: false, adapter: "runtime", count: 0 };
  const snapshot = legacyAccountWalletSnapshotForMigration();
  return transaction(async (client) => {
    const name = "account_wallets_to_postgres_v1";
    const existing = await client.query("SELECT name, record_count FROM runtime_state_migrations WHERE name = $1 FOR UPDATE", [name]);
    if (existing.rows[0]) return { migrated: false, adapter: "postgres", count: Number(existing.rows[0].record_count || 0) };
    let count = 0;
    for (const [accountId, wallet] of Object.entries(snapshot)) {
      if (!wallet?.address || wallet.status === "delinked") continue;
      const proof = wallet.proof && typeof wallet.proof === "object" ? wallet.proof : {};
      await client.query(
        `INSERT INTO account_linked_wallets (
           account_id, wallet_address, status, public_key, encryption_public_key, custody,
           proof_purpose, wallet_created_in_account, proof_json, linked_at, updated_at
         ) VALUES ($1, $2, 'linked', $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         ON CONFLICT (account_id) DO UPDATE SET
           public_key = CASE WHEN account_linked_wallets.public_key = '' THEN EXCLUDED.public_key ELSE account_linked_wallets.public_key END,
           encryption_public_key = CASE WHEN account_linked_wallets.encryption_public_key = '' THEN EXCLUDED.encryption_public_key ELSE account_linked_wallets.encryption_public_key END,
           custody = CASE WHEN account_linked_wallets.custody = '' THEN EXCLUDED.custody ELSE account_linked_wallets.custody END,
           proof_purpose = CASE WHEN account_linked_wallets.proof_purpose = '' THEN EXCLUDED.proof_purpose ELSE account_linked_wallets.proof_purpose END,
           wallet_created_in_account = account_linked_wallets.wallet_created_in_account OR EXCLUDED.wallet_created_in_account,
           proof_json = CASE WHEN account_linked_wallets.proof_json = '{}'::jsonb THEN EXCLUDED.proof_json ELSE account_linked_wallets.proof_json END`,
        [
          accountId, wallet.address, wallet.publicKey || "", wallet.tasknodeEncryptionPubkey || "",
          wallet.custody || "local_seed_required", proof.purpose || "", wallet.walletCreatedInAccount === true || proof.purpose === "wallet_create",
          JSON.stringify(proof), wallet.linkedAt || null, wallet.updatedAt || wallet.linkedAt || new Date().toISOString(),
        ]
      );
      count += 1;
    }
    await client.query(
      "INSERT INTO runtime_state_migrations (name, record_count, metadata_json) VALUES ($1, $2, $3::jsonb)",
      [name, count, JSON.stringify({ source: "runtime-store.accountWallets", schemaVersion: 1 })]
    );
    return { migrated: true, adapter: "postgres", count };
  });
}
