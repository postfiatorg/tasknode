import { databaseEnabled, query } from "../db/pool.js";
import { DEFAULT_IDENTITY_NAMESPACE, normalizeCanonicalHandle } from "./constants.js";

function mapReservationRow(row) {
  if (!row) return null;
  return {
    namespace: row.namespace,
    handle: row.handle,
    accountId: row.account_id,
    l1Account: row.l1_account || "",
    nostrPubkeyHex: row.nostr_pubkey_hex,
    derivationVersion: Number(row.derivation_version || 1),
    commitmentHash: row.commitment_hash,
    saltHex: row.salt_hex,
    reservedCategory: row.reserved_category || "user",
    status: row.status || "reserved",
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at || ""),
  };
}

function mapCustomClaimRow(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    identifier: row.identifier,
    domain: row.domain,
    localPart: row.local_part,
    nostrPubkeyHex: row.nostr_pubkey_hex,
    verificationMethod: row.verification_method,
    status: row.status,
    verifiedAt: row.verified_at instanceof Date ? row.verified_at.toISOString() : String(row.verified_at || ""),
    metadata: row.metadata_json || {},
  };
}

function mapOnChainRow(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    account: row.l1_account,
    nostr_pubkey: row.nostr_pubkey_hex,
    derivation_version: Number(row.derivation_version || 1),
    key_index: Number(row.key_index || 0),
    identity_kind: row.identity_kind || "human",
    registered_namespace: row.registered_namespace || "",
    handle: row.handle || "",
    status: row.status || "active",
    compromised: Boolean(row.compromised),
    sequence: Number(row.sequence || 1),
    relays: Array.isArray(row.relays_json) ? row.relays_json : [],
    links: Array.isArray(row.links_json) ? row.links_json : [],
    avatar_nft_id: row.avatar_nft_id || null,
    message_key: row.message_key || null,
    pq_receive_address: row.pq_receive_address || null,
    synced_height: Number(row.synced_height || 0),
    revoked_at_height: row.revoked_at_height != null ? Number(row.revoked_at_height) : null,
  };
}

export function createMemoryIdentityStore() {
  const reservations = new Map();
  const customClaims = new Map();
  const onChain = new Map();
  const holdbacks = new Map();
  const compromisedPubkeys = new Set();

  const key = (ns, handle) => `${String(ns || DEFAULT_IDENTITY_NAMESPACE).toLowerCase()}\0${normalizeCanonicalHandle(handle)}`;
  const isActiveReservation = (record) => {
    if (!record) return false;
    if (!record.expiresAt) return true;
    const expiryMs = Date.parse(record.expiresAt);
    return Number.isNaN(expiryMs) || expiryMs > Date.now();
  };

  return {
    async getReservation({ namespace = DEFAULT_IDENTITY_NAMESPACE, handle }) {
      const record = reservations.get(key(namespace, handle)) || null;
      return isActiveReservation(record) ? record : null;
    },
    async listReservationsForAccount(accountId) {
      return [...reservations.values()].filter((r) => r.accountId === accountId && isActiveReservation(r));
    },
    async saveReservation(record) {
      const normalized = { ...record, handle: normalizeCanonicalHandle(record.handle) };
      reservations.set(key(normalized.namespace, normalized.handle), normalized);
      return normalized;
    },
    async saveCustomNip05Claim(claim) {
      const record = { ...claim, verifiedAt: new Date().toISOString() };
      customClaims.set(`${claim.accountId}\0${claim.identifier}`, record);
      return record;
    },
    async listCustomNip05Claims(accountId) {
      return [...customClaims.values()].filter((c) => c.accountId === accountId);
    },
    async upsertOnChainIdentity(record) {
      const copy = { ...record };
      onChain.set(copy.account, copy);
      if (copy.compromised && copy.nostr_pubkey) compromisedPubkeys.add(copy.nostr_pubkey.toLowerCase());
      return copy;
    },
    async getOnChainIdentityForAccount(accountId) {
      return [...onChain.values()].find((r) => r.accountId === accountId) || null;
    },
    async listOnChainIdentities({ namespace = DEFAULT_IDENTITY_NAMESPACE, handle = "" } = {}) {
      const canonical = handle ? normalizeCanonicalHandle(handle) : "";
      return [...onChain.values()].filter((row) => {
        if (row.registered_namespace.toLowerCase() !== namespace.toLowerCase()) return false;
        if (canonical && normalizeCanonicalHandle(row.handle) !== canonical) return false;
        return true;
      });
    },
    async markCompromisedNostrPubkey(pubkeyHex) {
      compromisedPubkeys.add(String(pubkeyHex || "").trim().toLowerCase());
    },
    async isCompromisedNostrPubkey(pubkeyHex) {
      return compromisedPubkeys.has(String(pubkeyHex || "").trim().toLowerCase());
    },
    async setHandleHoldbackUntil({ namespace = DEFAULT_IDENTITY_NAMESPACE, handle, untilHeight }) {
      holdbacks.set(key(namespace, handle), Number(untilHeight));
    },
    async getHandleHoldbackUntil({ namespace = DEFAULT_IDENTITY_NAMESPACE, handle }) {
      return holdbacks.get(key(namespace, handle)) || 0;
    },
  };
}

export function createPostgresIdentityStore() {
  const memoryFallback = createMemoryIdentityStore();

  return {
    async getReservation({ namespace = DEFAULT_IDENTITY_NAMESPACE, handle }) {
      if (!databaseEnabled()) return memoryFallback.getReservation({ namespace, handle });
      const canonical = normalizeCanonicalHandle(handle);
      const res = await query(
        `SELECT * FROM identity_handle_reservations
         WHERE namespace = $1 AND handle = $2 AND expires_at > now()`,
        [namespace, canonical],
      );
      return mapReservationRow(res.rows[0]);
    },
    async listReservationsForAccount(accountId) {
      if (!databaseEnabled()) return memoryFallback.listReservationsForAccount(accountId);
      const res = await query(
        `SELECT * FROM identity_handle_reservations
         WHERE account_id = $1 AND expires_at > now()
         ORDER BY updated_at DESC`,
        [accountId],
      );
      return res.rows.map(mapReservationRow);
    },
    async saveReservation(record) {
      if (!databaseEnabled()) return memoryFallback.saveReservation(record);
      const canonical = normalizeCanonicalHandle(record.handle);
      const res = await query(
        `INSERT INTO identity_handle_reservations (
           namespace, handle, account_id, l1_account, nostr_pubkey_hex,
           derivation_version, commitment_hash, salt_hex, reserved_category, status, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (namespace, handle) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           l1_account = EXCLUDED.l1_account,
           nostr_pubkey_hex = EXCLUDED.nostr_pubkey_hex,
           derivation_version = EXCLUDED.derivation_version,
           commitment_hash = EXCLUDED.commitment_hash,
           salt_hex = EXCLUDED.salt_hex,
           reserved_category = EXCLUDED.reserved_category,
           status = EXCLUDED.status,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
         RETURNING *`,
        [
          record.namespace || DEFAULT_IDENTITY_NAMESPACE,
          canonical,
          record.accountId,
          record.l1Account || "",
          record.nostrPubkeyHex,
          record.derivationVersion || 1,
          record.commitmentHash,
          record.saltHex,
          record.reservedCategory || "user",
          record.status || "reserved",
          record.expiresAt,
        ],
      );
      return mapReservationRow(res.rows[0]);
    },
    async saveCustomNip05Claim(claim) {
      if (!databaseEnabled()) return memoryFallback.saveCustomNip05Claim(claim);
      const res = await query(
        `INSERT INTO identity_custom_nip05_claims (
           account_id, identifier, domain, local_part, nostr_pubkey_hex,
           verification_method, status, metadata_json, verified_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), now())
         ON CONFLICT (account_id, identifier) DO UPDATE SET
           nostr_pubkey_hex = EXCLUDED.nostr_pubkey_hex,
           verification_method = EXCLUDED.verification_method,
           status = EXCLUDED.status,
           metadata_json = EXCLUDED.metadata_json,
           verified_at = now(),
           updated_at = now()
         RETURNING *`,
        [
          claim.accountId,
          claim.identifier,
          claim.domain,
          claim.localPart,
          claim.nostrPubkeyHex,
          claim.verificationMethod || "well_known_https",
          claim.status || "verified",
          JSON.stringify(claim.metadata || {}),
        ],
      );
      return mapCustomClaimRow(res.rows[0]);
    },
    async listCustomNip05Claims(accountId) {
      if (!databaseEnabled()) return memoryFallback.listCustomNip05Claims(accountId);
      const res = await query(
        `SELECT * FROM identity_custom_nip05_claims
         WHERE account_id = $1 AND status = 'verified'
         ORDER BY verified_at DESC`,
        [accountId],
      );
      return res.rows.map(mapCustomClaimRow);
    },
    async upsertOnChainIdentity(record) {
      if (!databaseEnabled()) return memoryFallback.upsertOnChainIdentity(record);
      const res = await query(
        `INSERT INTO identity_onchain_cache (
           account_id, l1_account, nostr_pubkey_hex, derivation_version, key_index,
           identity_kind, registered_namespace, handle, status, compromised,
           sequence, relays_json, links_json, avatar_nft_id, message_key,
           pq_receive_address, synced_height, revoked_at_height, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,now())
         ON CONFLICT (l1_account) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           nostr_pubkey_hex = EXCLUDED.nostr_pubkey_hex,
           derivation_version = EXCLUDED.derivation_version,
           key_index = EXCLUDED.key_index,
           identity_kind = EXCLUDED.identity_kind,
           registered_namespace = EXCLUDED.registered_namespace,
           handle = EXCLUDED.handle,
           status = EXCLUDED.status,
           compromised = EXCLUDED.compromised,
           sequence = EXCLUDED.sequence,
           relays_json = EXCLUDED.relays_json,
           links_json = EXCLUDED.links_json,
           avatar_nft_id = EXCLUDED.avatar_nft_id,
           message_key = EXCLUDED.message_key,
           pq_receive_address = EXCLUDED.pq_receive_address,
           synced_height = EXCLUDED.synced_height,
           revoked_at_height = EXCLUDED.revoked_at_height,
           updated_at = now()
         RETURNING *`,
        [
          record.accountId || "",
          record.account,
          record.nostr_pubkey,
          record.derivation_version || 1,
          record.key_index || 0,
          record.identity_kind || "human",
          record.registered_namespace || "",
          record.handle || "",
          record.status || "active",
          Boolean(record.compromised),
          record.sequence || 1,
          JSON.stringify(record.relays || []),
          JSON.stringify(record.links || []),
          record.avatar_nft_id || "",
          record.message_key || "",
          record.pq_receive_address || "",
          record.synced_height || 0,
          record.revoked_at_height ?? null,
        ],
      );
      return mapOnChainRow(res.rows[0]);
    },
    async getOnChainIdentityForAccount(accountId) {
      if (!databaseEnabled()) return memoryFallback.getOnChainIdentityForAccount(accountId);
      const res = await query(
        `SELECT * FROM identity_onchain_cache WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [accountId],
      );
      return mapOnChainRow(res.rows[0]);
    },
    async listOnChainIdentities({ namespace = DEFAULT_IDENTITY_NAMESPACE, handle = "" } = {}) {
      if (!databaseEnabled()) return memoryFallback.listOnChainIdentities({ namespace, handle });
      const canonical = handle ? normalizeCanonicalHandle(handle) : "";
      const res = canonical
        ? await query(
          `SELECT * FROM identity_onchain_cache WHERE lower(registered_namespace) = lower($1) AND lower(handle) = $2`,
          [namespace, canonical],
        )
        : await query(
          `SELECT * FROM identity_onchain_cache WHERE lower(registered_namespace) = lower($1)`,
          [namespace],
        );
      return res.rows.map(mapOnChainRow);
    },
    async isCompromisedNostrPubkey(pubkeyHex) {
      if (!databaseEnabled()) return memoryFallback.isCompromisedNostrPubkey(pubkeyHex);
      const res = await query(
        `SELECT 1 FROM identity_onchain_cache WHERE nostr_pubkey_hex = $1 AND compromised = true LIMIT 1`,
        [String(pubkeyHex || "").trim().toLowerCase()],
      );
      return res.rowCount > 0;
    },
    async getHandleHoldbackUntil({ namespace = DEFAULT_IDENTITY_NAMESPACE, handle }) {
      return memoryFallback.getHandleHoldbackUntil({ namespace, handle });
    },
    async setHandleHoldbackUntil({ namespace = DEFAULT_IDENTITY_NAMESPACE, handle, untilHeight }) {
      return memoryFallback.setHandleHoldbackUntil({ namespace, handle, untilHeight });
    },
  };
}
