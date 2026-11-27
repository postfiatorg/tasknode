import { fetchWalletNftInventory } from "../pftl-nfts.js";
import {
  BODY_ENCODING,
  CONTENT_KIND,
  VISIBILITY,
  addressFromPublicKey,
  computeRawCidV1,
  encodeMessageHeader,
  signEnvelopeMlDsa65,
} from "./message-protocol.js";
import { computeL1NftId, computeMigratedSerial } from "./nft-protocol.js";

export const LEGACY_SOURCE_CHAIN = "postfiat-legacy-xrpl";
export const DEFAULT_L1_CHAIN_ID = "postfiat-wan-devnet-2";
export const DEFAULT_OFFICIAL_COLLECTION_ID = "TASKNODE-PROFILE-V1";

function safeText(value = "", max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeTokenId(value = "") {
  return safeText(value, 256).toUpperCase();
}

function normalizePositiveInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function canonicalJsonBytes(value) {
  if (Array.isArray(value)) {
    return Buffer.from(`[${value.map((item) => canonicalJsonBytes(item).toString("utf8")).join(",")}]`, "utf8");
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const body = keys
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonBytes(value[k]).toString("utf8")}`)
      .join(",");
    return Buffer.from(`{${body}}`, "utf8");
  }
  return Buffer.from(JSON.stringify(value), "utf8");
}

function indexRecordsByTokenAndCid(records = []) {
  const byTokenId = new Map();
  const byMetadataCid = new Map();
  const byImageCid = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const tokenId = normalizeTokenId(record.nftTokenId || record.nft_token_id || record.nftoken_id || record.tokenId);
    const metaCid = safeText(record.metadataCid || record.metadata_cid, 160);
    const imgCid = safeText(record.imageCid || record.image_cid, 160);
    if (tokenId && !byTokenId.has(tokenId)) byTokenId.set(tokenId, record);
    if (metaCid && !byMetadataCid.has(metaCid)) byMetadataCid.set(metaCid, record);
    if (imgCid && !byImageCid.has(imgCid)) byImageCid.set(imgCid, record);
  }
  return { byTokenId, byMetadataCid, byImageCid };
}

function matchRecord(nft, index) {
  const tokenId = normalizeTokenId(nft.nftTokenId || nft.tokenId);
  if (tokenId && index.byTokenId.has(tokenId)) return { record: index.byTokenId.get(tokenId), matchedBy: "nftoken_id" };
  if (nft.metadataCid && index.byMetadataCid.has(nft.metadataCid)) {
    return { record: index.byMetadataCid.get(nft.metadataCid), matchedBy: "metadata_cid" };
  }
  if (nft.imageCid && index.byImageCid.has(nft.imageCid)) {
    return { record: index.byImageCid.get(nft.imageCid), matchedBy: "image_cid" };
  }
  return { record: null, matchedBy: "" };
}

export function evaluateNftMigrationEligibility({
  nft,
  tasknodeMatch = null,
  pftasksMatch = null,
  founderApprovedTokenIds = new Set(),
  cutoffLedgerIndex = 0,
  requireSourceRecord = true,
} = {}) {
  const tokenId = normalizeTokenId(nft?.nftTokenId || nft?.tokenId);
  const mintLedgerIndex = normalizePositiveInt(
    nft?.mintLedgerIndex ?? nft?.mint_ledger_index ?? tasknodeMatch?.mintLedgerIndex ?? pftasksMatch?.mintLedgerIndex,
    0
  );
  const reasons = [];

  if (!tokenId) reasons.push("missing_nftoken_id");
  const isFounderApproved = founderApprovedTokenIds.has(tokenId);
  const hasVerifiedRecord = Boolean(tasknodeMatch || pftasksMatch || isFounderApproved);
  if (requireSourceRecord && !hasVerifiedRecord) {
    reasons.push("not_in_tasknode_pftasks_or_founder_approved");
  }
  if (cutoffLedgerIndex > 0) {
    if (mintLedgerIndex <= 0) {
      reasons.push("missing_mint_ledger_index_for_cutoff");
    } else if (mintLedgerIndex >= cutoffLedgerIndex) {
      reasons.push("minted_at_or_after_cutoff_ledger");
    }
  }
  const imageCid = safeText(nft?.imageCid || tasknodeMatch?.imageCid || pftasksMatch?.imageCid, 160);
  if (!imageCid) reasons.push("missing_image_cid");

  return {
    eligible: reasons.length === 0,
    reasons,
    mintLedgerIndex,
    provenanceSource: tasknodeMatch
      ? "tasknode"
      : pftasksMatch
        ? "pftasks"
        : isFounderApproved
          ? "founder_approved"
          : "unmatched",
  };
}

// Read-only Founder NFT Inventory Scanner (Pillar 4 Section 2 Step 1):
// Scans one or more old Post Fiat chain wallets, joins Task Node + PFTasks records,
// applies the pre-cutoff eligibility policy, and derives deterministic bit-63 serials.
export async function scanFounderNftInventory({
  wallets = [],
  sourceChain = LEGACY_SOURCE_CHAIN,
  targetChainId = DEFAULT_L1_CHAIN_ID,
  targetCollectionId = DEFAULT_OFFICIAL_COLLECTION_ID,
  migrationIssuerAccount = "",
  cutoffLedgerIndex = 0,
  tasknodeRecords = [],
  pftasksRecords = [],
  founderApprovedTokenIds = [],
  requireSourceRecord = true,
  fetchMetadata = true,
  fetchWalletInventory = fetchWalletNftInventory,
  env = process.env,
} = {}) {
  const normalizedWallets = [...new Set(
    (Array.isArray(wallets) ? wallets : [wallets])
      .map((w) => safeText(w, 120))
      .filter(Boolean)
  )];
  if (!normalizedWallets.length) {
    throw new Error("nft_inventory_wallets_required");
  }

  const tasknodeIndex = indexRecordsByTokenAndCid(tasknodeRecords);
  const pftasksIndex = indexRecordsByTokenAndCid(pftasksRecords);
  const approvedSet = new Set(
    (Array.isArray(founderApprovedTokenIds) ? founderApprovedTokenIds : []).map(normalizeTokenId).filter(Boolean)
  );

  const walletReports = [];
  const items = [];
  const seenTokens = new Set();

  for (const walletAddress of normalizedWallets) {
    const res = await fetchWalletInventory({ walletAddress, fetchMetadata, env });
    walletReports.push({
      walletAddress,
      ok: Boolean(res?.ok),
      accountExists: Boolean(res?.accountExists),
      count: Array.isArray(res?.nfts) ? res.nfts.length : 0,
      error: res?.ok ? "" : safeText(res?.error || "inventory_fetch_failed", 120),
    });
    if (!res?.ok) continue;

    for (const nft of res.nfts || []) {
      const tokenId = normalizeTokenId(nft.nftTokenId || nft.tokenId);
      if (!tokenId || seenTokens.has(tokenId)) continue;
      seenTokens.add(tokenId);

      const tn = matchRecord(nft, tasknodeIndex);
      const pf = matchRecord(nft, pftasksIndex);
      const eligibility = evaluateNftMigrationEligibility({
        nft,
        tasknodeMatch: tn.record,
        pftasksMatch: pf.record,
        founderApprovedTokenIds: approvedSet,
        cutoffLedgerIndex: normalizePositiveInt(cutoffLedgerIndex, 0),
        requireSourceRecord,
      });

      const migratedSerial = computeMigratedSerial(sourceChain, tokenId);
      const targetNftId = migrationIssuerAccount
        ? computeL1NftId({
            chainId: targetChainId,
            issuer: migrationIssuerAccount,
            collectionId: targetCollectionId,
            serial: migratedSerial,
          })
        : "";

      const imageCid = safeText(nft.imageCid || tn.record?.imageCid || pf.record?.imageCid, 160);
      const metadataCid = safeText(nft.metadataCid || tn.record?.metadataCid || pf.record?.metadataCid, 160);
      const title = safeText(nft.title || tn.record?.title || pf.record?.title || `Post Fiat NFT ${tokenId.slice(0, 8)}`, 160);
      const description = safeText(nft.description || tn.record?.description || pf.record?.description, 1000);

      items.push({
        sourceChain,
        nftokenId: tokenId,
        oldOwner: walletAddress,
        originalIssuer: safeText(nft.issuer || tn.record?.issuer || walletAddress, 120),
        originalUri: safeText(nft.metadataUri || tn.record?.metadataUri, 1000),
        mintTx: safeText(nft.mintTx || nft.mint_tx || tn.record?.txHash || pf.record?.txHash, 128),
        mintLedgerIndex: eligibility.mintLedgerIndex,
        title,
        description,
        imageCid,
        imageUri: imageCid ? `ipfs://${imageCid}` : "",
        metadataCid,
        attributes: Array.isArray(nft.metadata?.attributes) ? nft.metadata.attributes : [],
        taxon: Number(nft.taxon || 0),
        legacyFlags: Number(nft.flags || 0),
        tasknodeRecordId: safeText(tn.record?.id, 160),
        pftasksRecordId: safeText(pf.record?.id, 160),
        matchedBy: tn.matchedBy || pf.matchedBy || (approvedSet.has(tokenId) ? "founder_approved" : ""),
        provenanceSource: eligibility.provenanceSource,
        eligible: eligibility.eligible,
        ineligibilityReasons: eligibility.reasons,
        migratedSerial: migratedSerial.toString(),
        targetChainId,
        targetCollectionId,
        migrationIssuerAccount: safeText(migrationIssuerAccount, 120),
        targetNftId,
      });
    }
  }

  items.sort((a, b) => a.nftokenId.localeCompare(b.nftokenId));
  const eligibleItems = items.filter((item) => item.eligible);
  const ineligibleItems = items.filter((item) => !item.eligible);

  return {
    schema: "postfiat-nft-inventory-report-v1",
    generatedAt: new Date().toISOString(),
    sourceChain,
    targetChainId,
    targetCollectionId,
    migrationIssuerAccount: safeText(migrationIssuerAccount, 120),
    cutoffLedgerIndex: normalizePositiveInt(cutoffLedgerIndex, 0),
    wallets: walletReports,
    summary: {
      walletCount: normalizedWallets.length,
      totalScanned: items.length,
      eligibleCount: eligibleItems.length,
      ineligibleCount: ineligibleItems.length,
    },
    items,
  };
}

// Freezes an eligibility allowlist from a founder-reviewed inventory report.
// Optionally wraps & signs it in a PUBLIC Pillar 2 ML-DSA-65 envelope for offline verification.
export function freezeEligibilityAllowlist({
  inventoryReport,
  founderSigner = null,
  createdAtUnixMs = Date.now(),
} = {}) {
  const eligibleEntries = (inventoryReport?.items || [])
    .filter((item) => item.eligible)
    .map((item) => ({
      nftokenId: item.nftokenId,
      oldOwner: item.oldOwner,
      originalIssuer: item.originalIssuer,
      originalUri: item.originalUri,
      mintTx: item.mintTx,
      mintLedgerIndex: item.mintLedgerIndex,
      imageCid: item.imageCid,
      metadataCid: item.metadataCid,
      title: item.title,
      description: item.description,
      attributes: item.attributes || [],
      migratedSerial: String(item.migratedSerial),
      targetNftId: item.targetNftId,
      provenanceSource: item.provenanceSource,
    }))
    .sort((a, b) => a.nftokenId.localeCompare(b.nftokenId));

  const allowlist = {
    schema: "pf.nft.allowlist.v1",
    version: 1,
    sourceChain: inventoryReport.sourceChain || LEGACY_SOURCE_CHAIN,
    targetChainId: inventoryReport.targetChainId || DEFAULT_L1_CHAIN_ID,
    targetCollectionId: inventoryReport.targetCollectionId || DEFAULT_OFFICIAL_COLLECTION_ID,
    migrationIssuerAccount: inventoryReport.migrationIssuerAccount || "",
    cutoffLedgerIndex: Number(inventoryReport.cutoffLedgerIndex || 0),
    frozenAtUnixMs: createdAtUnixMs,
    entryCount: eligibleEntries.length,
    entries: eligibleEntries,
  };

  const canonicalBytes = canonicalJsonBytes(allowlist);
  const rawCid = computeRawCidV1(canonicalBytes);

  let signedEnvelope = null;
  if (founderSigner?.publicKey && founderSigner?.secretKey) {
    const founderAccount = addressFromPublicKey(founderSigner.publicKey);
    const headerBytes = encodeMessageHeader({
      protocolVersion: 1,
      chainId: allowlist.targetChainId,
      schemaName: "pf.nft.allowlist.v1",
      schemaId: 1,
      kind: CONTENT_KIND.NFT,
      visibility: VISIBILITY.PUBLIC,
      bodyEncoding: BODY_ENCODING.CANONICAL_JSON,
      senderAccount: founderAccount,
      createdAtUnixMs,
    });
    const envSigned = signEnvelopeMlDsa65({
      version: 1,
      headerBytes,
      bodyBytes: canonicalBytes,
      publicKey: founderSigner.publicKey,
      secretKey: founderSigner.secretKey,
    });
    signedEnvelope = {
      founderAccount,
      cid: envSigned.cid.multibaseCid,
      cidBinHex: envSigned.cid.cidBinHex,
      byteLength: envSigned.cid.byteLength,
      metadataHashSha3_384: envSigned.metadataHashSha3_384,
      rawEnvelopeHex: envSigned.rawEnvelopeBytes.toString("hex"),
    };
  }

  return {
    allowlist,
    allowlistCid: {
      cidBinHex: signedEnvelope ? signedEnvelope.cidBinHex : rawCid.cidBinHex,
      byteLength: signedEnvelope ? signedEnvelope.byteLength : rawCid.byteLength,
      multibaseCid: signedEnvelope ? signedEnvelope.cid : rawCid.multibaseCid,
    },
    signedEnvelope,
  };
}
