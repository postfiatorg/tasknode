import { decode as decodeNip19 } from "nostr-tools/nip19";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { listDiscoverableAccountWalletIdentities } from "./account-profiles.js";
import {
  auditCollaborationEvent,
  consumeCollaborationProof,
  docsIdentityForAccount,
  requireTaskHistoryGrant,
  resolveCollaborationIdentity,
} from "./collaboration.js";
import { getPublicProfileHeroNft } from "./profile-nfts.js";
import { nonFixtureProfileNftSql } from "./task-projection-integrity.js";

export const DEFAULT_NOSTR_RELAYS = Object.freeze([
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.damus.io",
]);

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function ensureDatabase() {
  if (databaseEnabled()) return;
  const error = new Error("collaboration_database_not_configured");
  error.code = "collaboration_database_not_configured";
  error.status = 503;
  throw error;
}

export function taskNodeNostrDomain(value = process.env.TASKNODE_NOSTR_NIP05_DOMAIN || "tasknode.postfiat.org") {
  const domain = safeText(value, 255).toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return /^[a-z0-9.-]+(?::[0-9]{2,5})?$/.test(domain) ? domain : "tasknode.postfiat.org";
}

export function taskNodeNostrName(handle = "") {
  const normalized = safeText(handle, 80).replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(normalized) ? normalized : "";
}

export function taskNodeNostrAddress(handle = "", domain) {
  const name = taskNodeNostrName(handle);
  return name ? `${name}@${taskNodeNostrDomain(domain)}` : "";
}

export function normalizeNostrRelays(relays = []) {
  return Array.from(new Set(safeArray(relays)
    .map((relay) => safeText(relay, 500).replace(/\/+$/, ""))
    .filter((relay) => /^wss:\/\/[a-z0-9.-]+(?::[0-9]{2,5})?(?:\/[^\s]*)?$/i.test(relay))))
    .slice(0, 5);
}

async function canonicalNostrIdentityForAccount(accountId = "") {
  const identity = await docsIdentityForAccount(accountId);
  const name = taskNodeNostrName(identity.hiveHandle);
  if (!name) return null;
  return { ...identity, nostrName: name, nip05: taskNodeNostrAddress(name) };
}

function publicProfileAvatar(nft = null) {
  if (!nft?.imageCid && !nft?.imageGatewayUrl) return null;
  return {
    imageCid: safeText(nft.imageCid, 180),
    imageGatewayUrl: safeText(nft.imageGatewayUrl, 500),
  };
}

export async function bindNostrIdentity({
  accountId = "",
  nostrPubkeyHex = "",
  npub = "",
  preferredRelays = [],
  visibility = "teammates",
  proof = {},
} = {}) {
  ensureDatabase();
  const pubkey = safeText(nostrPubkeyHex, 64).toLowerCase();
  const normalizedNpub = safeText(npub, 120).toLowerCase();
  const normalizedRelays = normalizeNostrRelays(preferredRelays);
  const taskNodeIdentity = await canonicalNostrIdentityForAccount(accountId);
  if (!taskNodeIdentity) return { ok: false, status: 409, error: "nostr_tasknode_handle_required" };
  if (!taskNodeIdentity.discoverable) {
    return { ok: false, status: 409, error: "nostr_discoverable_profile_required" };
  }
  let decodedNpub = null;
  try {
    const decoded = decodeNip19(normalizedNpub);
    if (decoded.type === "npub" && typeof decoded.data === "string") decodedNpub = decoded.data.toLowerCase();
  } catch {
    // Validation below rejects undecodable npubs with the same public error.
  }
  if (!/^[0-9a-f]{64}$/.test(pubkey) || decodedNpub !== pubkey) {
    return { ok: false, status: 400, error: "nostr_identity_invalid" };
  }
  const normalizedVisibility = ["private", "teammates", "public"].includes(visibility) ? visibility : "teammates";
  const payload = {
    nostrPubkeyHex: pubkey,
    npub: normalizedNpub,
    nip05: taskNodeIdentity.nip05,
    preferredRelays: normalizedRelays,
    visibility: normalizedVisibility,
  };
  return transaction(async (client) => {
    const verified = await consumeCollaborationProof({
      client,
      accountId,
      action: "nostr_bind",
      resourceId: pubkey,
      payload,
      proof,
    });
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60_000);
    const walletProof = {
      payload,
      signature: verified.signature,
      publicKey: verified.publicKey,
      walletAddress: verified.walletAddress,
      signatureHash: verified.signatureHash,
    };
    await client.query(
      `INSERT INTO account_nostr_identities (
         account_id, nostr_pubkey_hex, npub, nip05, nip05_verified_at, preferred_relays,
         source_wallet_address, wallet_proof, expires_at, visibility
       ) VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, $7::jsonb, $8, $9)
       ON CONFLICT (account_id) DO UPDATE SET
         nostr_pubkey_hex = EXCLUDED.nostr_pubkey_hex,
         npub = EXCLUDED.npub,
         nip05 = EXCLUDED.nip05,
         nip05_verified_at = now(),
         preferred_relays = EXCLUDED.preferred_relays,
         source_wallet_address = EXCLUDED.source_wallet_address,
         wallet_proof = EXCLUDED.wallet_proof,
         sequence = account_nostr_identities.sequence + 1,
         expires_at = EXCLUDED.expires_at,
         visibility = EXCLUDED.visibility,
         status = 'active', revoked_at = NULL, updated_at = now()`,
      [accountId, pubkey, normalizedNpub, taskNodeIdentity.nip05, JSON.stringify(normalizedRelays), verified.walletAddress, JSON.stringify(walletProof), expiresAt, normalizedVisibility]
    );
    await auditCollaborationEvent({
      accountId,
      eventType: "nostr.identity_bound",
      resourceType: "nostr_identity",
      resourceId: pubkey,
      metadata: { nip05: taskNodeIdentity.nip05, relayCount: normalizedRelays.length },
      client,
    });
    return { ok: true, status: "active", expiresAt: expiresAt.toISOString(), nip05: taskNodeIdentity.nip05 };
  });
}

export async function getNostrIdentity({ accountId = "", viewerAccountId = "" } = {}) {
  ensureDatabase();
  const result = await query(
    `SELECT account_id, nostr_pubkey_hex, npub, nip05, preferred_relays,
            source_wallet_address, sequence, expires_at, visibility, status, updated_at
     FROM account_nostr_identities WHERE account_id = $1`,
    [accountId]
  );
  const row = result.rows[0];
  if (!row || row.status !== "active" || Date.parse(row.expires_at) <= Date.now()) return null;
  if (accountId !== viewerAccountId && row.visibility === "private") return null;
  if (accountId !== viewerAccountId && row.visibility === "teammates") {
    const relationship = await requireTaskHistoryGrant({ subjectAccountId: accountId, viewerAccountId });
    const reverse = await requireTaskHistoryGrant({ subjectAccountId: viewerAccountId, viewerAccountId: accountId });
    if (!relationship.ok && !reverse.ok) return null;
  }
  return {
    accountId: row.account_id,
    nostrPubkeyHex: row.nostr_pubkey_hex,
    npub: row.npub,
    nip05: row.nip05 || "",
    preferredRelays: safeArray(row.preferred_relays),
    sourceWalletAddress: row.source_wallet_address,
    sequence: Number(row.sequence || 1),
    expiresAt: toIso(row.expires_at),
    visibility: row.visibility,
    updatedAt: toIso(row.updated_at),
  };
}

export async function getNostrMessagingBootstrap({ accountId = "" } = {}) {
  ensureDatabase();
  const identity = await canonicalNostrIdentityForAccount(accountId);
  const heroNft = identity ? publicProfileAvatar(await getPublicProfileHeroNft({ accountId })) : null;
  return {
    ok: true,
    identity: identity ? { ...identity, heroNft } : null,
    binding: await getNostrIdentity({ accountId, viewerAccountId: accountId }),
    defaultRelays: DEFAULT_NOSTR_RELAYS,
    canActivate: Boolean(identity?.nostrName && identity.discoverable && identity.walletAddress),
  };
}

export async function resolveNostrMessagingIdentity({ viewerAccountId = "", input = "" } = {}) {
  ensureDatabase();
  const rawInput = safeText(input, 255);
  const suffix = `@${taskNodeNostrDomain()}`;
  const handleInput = rawInput.toLowerCase().endsWith(suffix)
    ? rawInput.slice(0, -suffix.length)
    : rawInput;
  const resolved = await resolveCollaborationIdentity({ viewerAccountId, input: handleInput });
  if (!resolved.ok) return resolved;
  const nostr = await getNostrIdentity({ accountId: resolved.identity.accountId, viewerAccountId });
  if (!nostr || nostr.visibility !== "public") {
    return { ok: false, status: 404, error: "nostr_recipient_not_active" };
  }
  const heroNft = publicProfileAvatar(await getPublicProfileHeroNft({ accountId: resolved.identity.accountId }));
  return { ok: true, identity: { ...resolved.identity, heroNft }, nostr };
}

export function buildNostrWellKnownDirectory({ discoverable = [], rows = [] } = {}) {
  const byAccount = new Map(safeArray(discoverable).map((identity) => [identity.accountId, identity]));
  const names = {};
  const relays = {};
  const profiles = {};
  safeArray(rows).forEach((row) => {
    const publicIdentity = byAccount.get(row.account_id) || {};
    const handle = taskNodeNostrName(publicIdentity.hiveHandle);
    if (!handle || !/^[0-9a-f]{64}$/.test(row.nostr_pubkey_hex)) return;
    names[handle] = row.nostr_pubkey_hex;
    relays[row.nostr_pubkey_hex] = normalizeNostrRelays(row.preferred_relays);
    profiles[row.nostr_pubkey_hex] = {
      displayName: safeText(publicIdentity.publicDisplayName || publicIdentity.displayName || `@${handle}`, 120),
      hiveHandle: handle,
      heroNft: publicProfileAvatar({
        imageCid: row.hero_nft_image_cid,
        imageGatewayUrl: row.hero_nft_image_gateway_url,
      }),
    };
  });
  return { names, relays, profiles };
}

export async function getNostrWellKnownDirectory({ name = "" } = {}) {
  ensureDatabase();
  const rawName = safeText(name, 80);
  const requestedName = taskNodeNostrName(rawName);
  if (rawName && !requestedName) return { names: {}, relays: {}, profiles: {} };
  const discoverable = (await listDiscoverableAccountWalletIdentities())
    .filter((identity) => taskNodeNostrName(identity.hiveHandle))
    .filter((identity) => !requestedName || taskNodeNostrName(identity.hiveHandle) === requestedName);
  if (!discoverable.length) return { names: {}, relays: {}, profiles: {} };
  const byAccount = new Map(discoverable.map((identity) => [identity.accountId, identity]));
  const result = await query(
    `SELECT nostr_identity.account_id, nostr_identity.nostr_pubkey_hex, nostr_identity.preferred_relays,
            COALESCE(hero_nft.image_cid, '') AS hero_nft_image_cid,
            COALESCE(hero_nft.image_gateway_url, '') AS hero_nft_image_gateway_url
       FROM account_nostr_identities nostr_identity
       LEFT JOIN LATERAL (
         SELECT nft.image_cid, nft.image_gateway_url
           FROM profile_nfts nft
          WHERE nft.account_id = nostr_identity.account_id
            AND lower(nft.status) IN ('minted', 'prepared', 'generated')
            AND ${nonFixtureProfileNftSql("nft")}
            AND (
              COALESCE(nft.image_gateway_url, '') <> ''
              OR COALESCE(nft.image_cid, '') <> ''
            )
          ORDER BY nft.selected DESC,
                   nft.created_at DESC NULLS LAST,
                   nft.updated_at DESC NULLS LAST,
                   nft.id DESC
          LIMIT 1
       ) hero_nft ON true
      WHERE nostr_identity.account_id = ANY($1::text[])
        AND nostr_identity.status = 'active'
        AND nostr_identity.visibility = 'public'
        AND nostr_identity.expires_at > now()`,
    [[...byAccount.keys()]]
  );
  return buildNostrWellKnownDirectory({ discoverable, rows: result.rows });
}

export async function revokeNostrIdentity({ accountId = "", proof = {} } = {}) {
  ensureDatabase();
  const payload = { accountId };
  return transaction(async (client) => {
    await consumeCollaborationProof({ client, accountId, action: "nostr_revoke", resourceId: accountId, payload, proof });
    const result = await client.query(
      `UPDATE account_nostr_identities
       SET status = 'revoked', revoked_at = now(), updated_at = now()
       WHERE account_id = $1 AND status = 'active'
       RETURNING account_id`,
      [accountId]
    );
    if (!result.rows.length) return { ok: false, status: 404, error: "nostr_identity_not_found" };
    await auditCollaborationEvent({
      accountId,
      eventType: "nostr.identity_revoked",
      resourceType: "nostr_identity",
      resourceId: accountId,
      client,
    });
    return { ok: true, status: "revoked" };
  });
}
