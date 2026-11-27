export const CHAIN_LEGACY = "postfiat-legacy-xrpl";
export const CHAIN_L1V2 = "postfiatl1v2";

export const MIGRATION_STATUS = Object.freeze({
  NOT_MIGRATED: "not_migrated",
  MIGRATED: "migrated",
  MIGRATING: "migrating",
  RECORDED: "recorded",
  NATIVE_L1: "native_l1",
  STUDIO: "studio",
});

const MIGRATED_SERIAL_MIN = 1n << 63n;

function safeText(value = "", max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeTokenId(value = "") {
  return safeText(value, 256).toUpperCase();
}

export function isMigratedSerial(serial) {
  if (serial === undefined || serial === null || serial === "") return false;
  try {
    return BigInt(serial) >= MIGRATED_SERIAL_MIN;
  } catch {
    return false;
  }
}

export function shortIssuer(issuer = "") {
  const value = safeText(issuer, 120);
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

// Per Pillar 4: always display issuer + collection together, never collection name alone.
export function formatIssuerCollection(nft = {}) {
  const issuer = safeText(nft.issuer || nft.collection?.issuerAccount || nft.collection?.issuer_account, 120);
  const collectionId = safeText(nft.collectionId || nft.collection_id || nft.collection?.collectionId || nft.collection?.collection_id, 120);
  if (!issuer && !collectionId) return "";
  if (issuer && collectionId) return `${collectionId} · ${shortIssuer(issuer)}`;
  return issuer ? shortIssuer(issuer) : "";
}

export function nftChainKind(nft = {}) {
  const explicit = safeText(nft.chain, 80).toLowerCase();
  if (explicit === CHAIN_L1V2 || explicit === "l1v2") return CHAIN_L1V2;
  if (explicit === CHAIN_LEGACY || explicit === "legacy") return CHAIN_LEGACY;
  if (nft.l1NftId || nft.nftId || (nft.serial !== undefined && nft.serial !== null && nft.serial !== "")) {
    return CHAIN_L1V2;
  }
  const status = safeText(nft.status, 40).toLowerCase();
  if (status === "minted" || nft.nftTokenId) return CHAIN_LEGACY;
  return "studio";
}

export function nftMigrationStatus(nft = {}) {
  const explicit = safeText(nft.migrationStatus || nft.migration_status, 40).toLowerCase();
  const retirementMode = safeText(
    nft.retirementMode || nft.retirement_mode || nft.origin?.retirementMode || nft.origin?.retirement_mode,
    40
  ).toLowerCase();
  // Pin-only records strictly render as Recorded Provenance, never as migrated live NFTs.
  if (explicit === MIGRATION_STATUS.RECORDED || retirementMode === "pin_only") {
    return MIGRATION_STATUS.RECORDED;
  }
  if (explicit === MIGRATION_STATUS.MIGRATED) return MIGRATION_STATUS.MIGRATED;
  if (explicit === MIGRATION_STATUS.MIGRATING) return MIGRATION_STATUS.MIGRATING;
  if (explicit === MIGRATION_STATUS.NATIVE_L1) return MIGRATION_STATUS.NATIVE_L1;
  if (explicit === MIGRATION_STATUS.NOT_MIGRATED) return MIGRATION_STATUS.NOT_MIGRATED;
  if (explicit === MIGRATION_STATUS.STUDIO) return MIGRATION_STATUS.STUDIO;

  const chain = nftChainKind(nft);
  if (chain === CHAIN_L1V2) {
    if (nft.origin?.nftokenId || nft.origin?.nftoken_id || nft.legacyTokenId || isMigratedSerial(nft.serial)) {
      return MIGRATION_STATUS.MIGRATED;
    }
    return MIGRATION_STATUS.NATIVE_L1;
  }
  if (chain === CHAIN_LEGACY) return MIGRATION_STATUS.NOT_MIGRATED;
  return MIGRATION_STATUS.STUDIO;
}

export function nftMigrationBadge(nft = {}) {
  const status = nftMigrationStatus(nft);
  if (status === MIGRATION_STATUS.MIGRATED) {
    return {
      status,
      label: "Migrated",
      tone: "migrated",
      chain: CHAIN_L1V2,
      chainLabel: "postfiatl1v2",
      canMigrate: false,
      isMigratedLiveNft: true,
    };
  }
  if (status === MIGRATION_STATUS.NATIVE_L1) {
    return {
      status,
      label: "postfiatl1v2",
      tone: "l1",
      chain: CHAIN_L1V2,
      chainLabel: "postfiatl1v2",
      canMigrate: false,
      isMigratedLiveNft: false,
    };
  }
  if (status === MIGRATION_STATUS.RECORDED) {
    return {
      status,
      label: "Recorded",
      tone: "recorded",
      chain: CHAIN_LEGACY,
      chainLabel: "Recorded provenance",
      canMigrate: false,
      isMigratedLiveNft: false,
    };
  }
  if (status === MIGRATION_STATUS.MIGRATING) {
    return {
      status,
      label: "Migrating",
      tone: "legacy",
      chain: CHAIN_LEGACY,
      chainLabel: "Legacy chain",
      canMigrate: false,
      isMigratedLiveNft: false,
    };
  }
  if (status === MIGRATION_STATUS.NOT_MIGRATED) {
    // No badge and no action until a migration is actually open for this NFT.
    const available = nft.migrationAvailable === true;
    return {
      status,
      label: available ? "Not migrated" : "",
      tone: "legacy",
      chain: CHAIN_LEGACY,
      chainLabel: "Legacy chain",
      canMigrate: available,
      isMigratedLiveNft: false,
    };
  }
  return {
    status: MIGRATION_STATUS.STUDIO,
    label: "",
    tone: "studio",
    chain: "studio",
    chainLabel: "",
    canMigrate: false,
    isMigratedLiveNft: false,
  };
}

function gatewayUrlForCid(cid = "") {
  const clean = safeText(cid, 160).replace(/^ipfs:\/\//i, "").replace(/^\/ipfs\//i, "");
  return clean ? `https://dweb.link/ipfs/${encodeURIComponent(clean)}` : "";
}

function normalizeL1Record(raw = {}, legacyMatch = null) {
  const nftId = safeText(raw.nftId || raw.nft_id || raw.l1NftId || raw.id, 160);
  const origin = raw.origin && typeof raw.origin === "object" ? raw.origin : null;
  const legacyTokenId = normalizeTokenId(
    raw.legacyTokenId || origin?.nftokenId || origin?.nftoken_id || legacyMatch?.nftTokenId
  );
  const serial = raw.serial !== undefined && raw.serial !== null ? String(raw.serial) : "";
  const migrated = Boolean(legacyTokenId || isMigratedSerial(serial));
  const imageCid = safeText(raw.imageCid || raw.image_cid || legacyMatch?.imageCid, 160);
  const metadataUri = safeText(raw.metadataUri || raw.metadata_uri, 300);
  const metadataHash = safeText(raw.metadataHash || raw.metadata_hash, 128);
  return {
    ...(legacyMatch ? {
      title: legacyMatch.title,
      description: legacyMatch.description,
      imageGatewayUrl: legacyMatch.imageGatewayUrl,
      metadataJson: legacyMatch.metadataJson,
      selected: legacyMatch.selected,
      createdAt: legacyMatch.createdAt,
      generatedAt: legacyMatch.generatedAt,
    } : {}),
    ...raw,
    id: safeText(raw.id, 180) || (nftId ? `l1_nft_${nftId.slice(0, 24)}` : legacyMatch?.id || ""),
    nftId,
    l1NftId: nftId,
    nftTokenId: legacyTokenId || safeText(raw.nftTokenId, 256),
    legacyTokenId,
    chain: CHAIN_L1V2,
    status: raw.burned ? "burned" : "minted",
    migrationStatus: migrated ? MIGRATION_STATUS.MIGRATED : MIGRATION_STATUS.NATIVE_L1,
    issuer: safeText(raw.issuer, 120),
    collectionId: safeText(raw.collectionId || raw.collection_id, 120),
    serial,
    owner: safeText(raw.owner, 120),
    imageCid,
    imageGatewayUrl: safeText(raw.imageGatewayUrl || raw.image_gateway_url || legacyMatch?.imageGatewayUrl, 500)
      || gatewayUrlForCid(imageCid),
    metadataUri,
    metadataHash,
    transferable: raw.transferable !== undefined ? Boolean(raw.transferable) : (Number(raw.flags || 1) & 1) !== 0,
    issuerBurnable: raw.issuerBurnable !== undefined
      ? Boolean(raw.issuerBurnable)
      : raw.issuer_burnable !== undefined
        ? Boolean(raw.issuer_burnable)
        : (Number(raw.flags || 0) & 2) !== 0,
    issuerTransferFee: Number(raw.issuerTransferFee ?? raw.issuer_transfer_fee ?? 0),
    origin,
    issuerCollectionLabel: formatIssuerCollection(raw),
  };
}

export function mergeDualChainNftList({
  legacyNfts = [],
  l1Nfts = [],
  migrationRecords = [],
  provenanceRecords = [],
} = {}) {
  const legacyList = Array.isArray(legacyNfts) ? legacyNfts : [];
  const l1List = Array.isArray(l1Nfts) ? l1Nfts : [];
  const migrationsByTokenId = new Map();
  for (const record of Array.isArray(migrationRecords) ? migrationRecords : []) {
    const tokenId = normalizeTokenId(record.nftokenId || record.nftoken_id || record.nftTokenId);
    if (!tokenId) continue;
    const status = safeText(record.status, 40).toLowerCase();
    const mode = safeText(record.retirementMode || record.retirement_mode, 40).toLowerCase();
    if (mode === "pin_only" || status === "recorded") continue;
    if (status === "minted" || record.targetNftId || record.target_nft_id) {
      migrationsByTokenId.set(tokenId, record);
    }
  }
  // Migrated only when both steps are final: a validated old-chain burn and a mint at a final height.
  const migrationIsFinal = (record) =>
    safeText(record.status, 40).toLowerCase() === "minted" &&
    (record.burnValidated === true || record.burn_validated === true) &&
    Number(record.mintedHeight ?? record.minted_height ?? 0) > 0;

  const provenanceByTokenId = new Map();
  for (const record of Array.isArray(provenanceRecords) ? provenanceRecords : []) {
    const tokenId = normalizeTokenId(record.nftokenId || record.nftoken_id || record.nftTokenId);
    if (tokenId) provenanceByTokenId.set(tokenId, record);
  }
  for (const record of Array.isArray(migrationRecords) ? migrationRecords : []) {
    const tokenId = normalizeTokenId(record.nftokenId || record.nftoken_id || record.nftTokenId);
    const mode = safeText(record.retirementMode || record.retirement_mode, 40).toLowerCase();
    if (tokenId && (mode === "pin_only" || safeText(record.status, 40).toLowerCase() === "recorded")) {
      provenanceByTokenId.set(tokenId, record);
    }
  }

  const legacyByTokenId = new Map();
  for (const item of legacyList) {
    const tokenId = normalizeTokenId(item.nftTokenId || item.nftoken_id || item.tokenId);
    if (tokenId) legacyByTokenId.set(tokenId, item);
  }

  const merged = [];
  const consumedLegacyTokens = new Set();
  const seenL1Ids = new Set();

  for (const l1Raw of l1List) {
    if (l1Raw?.burned) continue;
    const originTokenId = normalizeTokenId(
      l1Raw.legacyTokenId || l1Raw.origin?.nftokenId || l1Raw.origin?.nftoken_id
    );
    const legacyMatch = originTokenId ? legacyByTokenId.get(originTokenId) || null : null;
    const normalized = normalizeL1Record(l1Raw, legacyMatch);
    if (normalized.nftId && seenL1Ids.has(normalized.nftId)) continue;
    if (normalized.nftId) seenL1Ids.add(normalized.nftId);
    if (originTokenId) consumedLegacyTokens.add(originTokenId);
    merged.push(normalized);
  }

  for (const legacyRaw of legacyList) {
    const tokenId = normalizeTokenId(legacyRaw.nftTokenId || legacyRaw.nftoken_id || legacyRaw.tokenId);
    if (tokenId && consumedLegacyTokens.has(tokenId)) continue;

    if (tokenId && migrationsByTokenId.has(tokenId) && !migrationIsFinal(migrationsByTokenId.get(tokenId))) {
      merged.push({
        ...legacyRaw,
        nftTokenId: tokenId,
        chain: CHAIN_LEGACY,
        migrationStatus: MIGRATION_STATUS.MIGRATING,
      });
      continue;
    }

    if (tokenId && migrationsByTokenId.has(tokenId)) {
      const mig = migrationsByTokenId.get(tokenId);
      const targetNftId = safeText(mig.targetNftId || mig.target_nft_id, 160);
      if (targetNftId && seenL1Ids.has(targetNftId)) continue;
      if (targetNftId) seenL1Ids.add(targetNftId);
      merged.push(normalizeL1Record({
        id: legacyRaw.id,
        nftId: targetNftId,
        issuer: mig.migrationIssuerAccount || mig.migration_issuer_account || mig.issuer || "",
        collectionId: mig.targetCollectionId || mig.target_collection_id || mig.collectionId || "",
        serial: mig.migratedSerial || mig.migrated_serial || "",
        owner: mig.newOwnerAccount || mig.new_owner_account || "",
        metadataUri: mig.metadataUri || mig.metadata_uri || "",
        metadataHash: mig.metadataHash || mig.metadata_hash || "",
        flags: 1,
        issuerTransferFee: 0,
        mintedAt: mig.mintedAt || mig.minted_at || legacyRaw.mintedAt,
        txHash: mig.mintTxHash || mig.mint_tx_hash || legacyRaw.txHash,
        origin: {
          sourceChain: CHAIN_LEGACY,
          nftokenId: tokenId,
          retirementMode: "burn_first",
          burnTx: mig.burnTxHash || mig.burn_tx_hash || "",
          claimCid: mig.claimCid || mig.claim_cid || "",
          migratedSerial: String(mig.migratedSerial || mig.migrated_serial || ""),
        },
      }, legacyRaw));
      continue;
    }

    if (tokenId && provenanceByTokenId.has(tokenId)) {
      const prov = provenanceByTokenId.get(tokenId);
      merged.push({
        ...legacyRaw,
        nftTokenId: tokenId,
        chain: CHAIN_LEGACY,
        migrationStatus: MIGRATION_STATUS.RECORDED,
        retirementMode: "pin_only",
        provenanceCid: safeText(prov.provenanceCid || prov.provenance_cid, 160),
        provenanceTxHash: safeText(prov.provenanceTxHash || prov.provenance_tx_hash, 160),
      });
      continue;
    }

    const status = nftMigrationStatus(legacyRaw);
    merged.push({
      ...legacyRaw,
      chain: nftChainKind(legacyRaw),
      migrationStatus: status,
      ...(formatIssuerCollection(legacyRaw) ? { issuerCollectionLabel: formatIssuerCollection(legacyRaw) } : {}),
    });
  }

  return merged;
}

export function filterDualChainNfts(nfts = [], filter = "all") {
  const list = Array.isArray(nfts) ? nfts : [];
  if (!filter || filter === "all") return list;
  return list.filter((nft) => {
    const status = nftMigrationStatus(nft);
    if (filter === "l1v2") return status === MIGRATION_STATUS.MIGRATED || status === MIGRATION_STATUS.NATIVE_L1;
    if (filter === "legacy") {
      return status === MIGRATION_STATUS.NOT_MIGRATED || status === MIGRATION_STATUS.MIGRATING || status === MIGRATION_STATUS.RECORDED;
    }
    return status === filter;
  });
}

export function dualChainNftCounts(nfts = []) {
  const counts = {
    total: 0,
    l1v2: 0,
    migrated: 0,
    nativeL1: 0,
    legacy: 0,
    notMigrated: 0,
    recorded: 0,
    studio: 0,
    hasDualChain: false,
  };
  for (const nft of Array.isArray(nfts) ? nfts : []) {
    counts.total += 1;
    const status = nftMigrationStatus(nft);
    if (status === MIGRATION_STATUS.MIGRATED) {
      counts.migrated += 1;
      counts.l1v2 += 1;
    } else if (status === MIGRATION_STATUS.NATIVE_L1) {
      counts.nativeL1 += 1;
      counts.l1v2 += 1;
    } else if (status === MIGRATION_STATUS.NOT_MIGRATED || status === MIGRATION_STATUS.MIGRATING) {
      counts.notMigrated += 1;
      counts.legacy += 1;
    } else if (status === MIGRATION_STATUS.RECORDED) {
      counts.recorded += 1;
      counts.legacy += 1;
    } else {
      counts.studio += 1;
    }
  }
  counts.hasDualChain = counts.l1v2 > 0 || counts.legacy > 0;
  return counts;
}
