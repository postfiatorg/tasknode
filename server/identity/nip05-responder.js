import {
  DEFAULT_IDENTITY_NAMESPACE,
  FIRST_PARTY_NOSTR_RELAY,
  IDENTITY_NOSTR_PUBKEY_HEX_LEN,
  isLowerHexOfLength,
  normalizeCanonicalHandle,
  normalizeIdentityRelays,
} from "./constants.js";

function badgesForOnChainIdentity(identity) {
  if (!identity || identity.status !== "active") return [];
  const badges = ["Minted"];
  if (identity.identity_kind === "agent") badges.push("Agent");
  for (const link of Array.isArray(identity.links) ? identity.links : []) {
    if (link?.status !== "active" || link?.consensus_verified !== true) continue;
    if (link.kind === "validator_node" && link.target) {
      badges.push(`Validator · ${link.target}`);
    } else if (link.kind === "old_chain_account") {
      badges.push("Old chain");
    } else if (link.kind === "agent_controller") {
      badges.push("Controller verified");
    }
  }
  return Array.from(new Set(badges));
}

// Merges legacy Postgres v1 directory with chain-backed Pillar 6 identity records.
// - On-chain active identities take precedence over Postgres v1 entries for the same handle.
// - Existing unminted users keep their exact v1 npub intact without disruption.
// - Revoked or compromised identities are immediately stripped (zero stale badges).
export function mergeChainBackedNostrDirectory({
  legacyDirectory = { names: {}, relays: {}, profiles: {} },
  onChainIdentities = [],
  compromisedPubkeys = [],
  requestedName = "",
  namespace = DEFAULT_IDENTITY_NAMESPACE,
} = {}) {
  const filterName = requestedName ? normalizeCanonicalHandle(requestedName) : "";
  if (requestedName && !filterName) {
    return { names: {}, relays: {}, profiles: {} };
  }

  const compromisedSet = new Set(
    (Array.isArray(compromisedPubkeys) ? compromisedPubkeys : [])
      .map((pk) => String(pk || "").trim().toLowerCase())
      .filter((pk) => isLowerHexOfLength(pk, IDENTITY_NOSTR_PUBKEY_HEX_LEN)),
  );
  const revokedHandles = new Set();
  const revokedPubkeys = new Set();

  for (const record of Array.isArray(onChainIdentities) ? onChainIdentities : []) {
    if (!record) continue;
    const pk = String(record.nostr_pubkey || record.nostrPubkeyHex || "").trim().toLowerCase();
    const handle = normalizeCanonicalHandle(record.handle || "");
    const recordNs = String(record.registered_namespace || record.namespace || namespace).toLowerCase();
    if (record.compromised === true && isLowerHexOfLength(pk, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) {
      compromisedSet.add(pk);
    }
    if (record.status === "revoked") {
      if (isLowerHexOfLength(pk, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) revokedPubkeys.add(pk);
      if (handle && recordNs === namespace.toLowerCase()) revokedHandles.add(handle);
    }
  }

  const names = {};
  const relays = {};
  const profiles = {};

  // 1. Seed legacy v1 directory, preserving existing unminted v1 npubs intact
  //    unless the handle or pubkey has been revoked/compromised on chain.
  const legacyNames = legacyDirectory?.names || {};
  const legacyRelays = legacyDirectory?.relays || {};
  const legacyProfiles = legacyDirectory?.profiles || {};
  for (const [rawHandle, rawPubkey] of Object.entries(legacyNames)) {
    const handle = normalizeCanonicalHandle(rawHandle);
    const pubkey = String(rawPubkey || "").trim().toLowerCase();
    if (!handle || !isLowerHexOfLength(pubkey, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) continue;
    if (filterName && handle !== filterName) continue;
    if (revokedHandles.has(handle) || revokedPubkeys.has(pubkey) || compromisedSet.has(pubkey)) {
      continue;
    }
    names[handle] = pubkey;
    relays[pubkey] = normalizeIdentityRelays(legacyRelays[pubkey] || []);
    const legacyProfile = legacyProfiles[pubkey] || {};
    profiles[pubkey] = {
      ...legacyProfile,
      hiveHandle: handle,
      onChainVerified: false,
      derivationVersion: 1,
      badges: Array.isArray(legacyProfile.badges) ? legacyProfile.badges : [],
    };
  }

  // 2. Overlay authoritative active on-chain identities.
  for (const record of Array.isArray(onChainIdentities) ? onChainIdentities : []) {
    if (!record || record.status !== "active") continue;
    const recordNs = String(record.registered_namespace || record.namespace || "").toLowerCase();
    if (recordNs !== namespace.toLowerCase()) continue;
    const handle = normalizeCanonicalHandle(record.handle || "");
    const pubkey = String(record.nostr_pubkey || record.nostrPubkeyHex || "").trim().toLowerCase();
    if (!handle || !isLowerHexOfLength(pubkey, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) continue;
    if (filterName && handle !== filterName) continue;
    if (compromisedSet.has(pubkey) || revokedPubkeys.has(pubkey)) continue;

    // If this handle previously pointed to an older legacy pubkey, clear the stale pubkey mapping.
    const previousPubkey = names[handle];
    if (previousPubkey && previousPubkey !== pubkey) {
      delete relays[previousPubkey];
      delete profiles[previousPubkey];
    }

    const recordRelays = normalizeIdentityRelays(record.relays || []);
    names[handle] = pubkey;
    relays[pubkey] = recordRelays.length ? recordRelays : [FIRST_PARTY_NOSTR_RELAY];
    const existingProfile = profiles[pubkey] || legacyProfiles[pubkey] || {};
    profiles[pubkey] = {
      ...existingProfile,
      accountId: existingProfile.accountId || record.accountId || "",
      displayName: existingProfile.displayName || `@${handle}`,
      hiveHandle: handle,
      l1Account: record.account || record.l1Account || "",
      onChainVerified: true,
      derivationVersion: Number(record.derivation_version || record.derivationVersion || 1),
      identityKind: record.identity_kind || record.identityKind || "human",
      avatarNftId: record.avatar_nft_id || record.avatarNftId || null,
      badges: badgesForOnChainIdentity(record),
    };
  }

  return { names, relays, profiles };
}

export async function resolveChainBackedWellKnownDirectory({
  name = "",
  namespace = DEFAULT_IDENTITY_NAMESPACE,
  getLegacyDirectory = async () => ({ names: {}, relays: {}, profiles: {} }),
  getOnChainIdentities = async () => [],
  lookupHandleOnChain = null,
} = {}) {
  const requestedName = String(name || "").trim();
  const canonicalName = requestedName ? normalizeCanonicalHandle(requestedName) : "";
  if (requestedName && !canonicalName) {
    return { names: {}, relays: {}, profiles: {} };
  }

  const [legacyDirectory, cachedOnChain] = await Promise.all([
    getLegacyDirectory({ name: canonicalName }).catch(() => ({ names: {}, relays: {}, profiles: {} })),
    getOnChainIdentities({ namespace, handle: canonicalName }).catch(() => []),
  ]);

  const onChainList = Array.isArray(cachedOnChain) ? [...cachedOnChain] : [];
  const compromisedPubkeys = [];

  if (canonicalName && typeof lookupHandleOnChain === "function") {
    try {
      const live = await lookupHandleOnChain({ namespace, handle: canonicalName });
      if (live?.compromised_nostr_pubkey && live?.identity?.nostr_pubkey) {
        compromisedPubkeys.push(live.identity.nostr_pubkey);
      }
      if (live?.found && live.identity) {
        onChainList.push(live.identity);
      }
    } catch {
      // Fallback safely to cached chain state + legacy directory when RPC is unreachable.
    }
  }

  return mergeChainBackedNostrDirectory({
    legacyDirectory,
    onChainIdentities: onChainList,
    compromisedPubkeys,
    requestedName: canonicalName,
    namespace,
  });
}
