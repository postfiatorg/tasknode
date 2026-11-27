import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BODY_ENCODING,
  CONTENT_KIND,
  SCHEMA_ID,
  VISIBILITY,
  addressFromPublicKey,
  encodeMessageHeader,
  sha256Bytes,
  sha3_384Bytes,
  signEnvelopeMlDsa65,
  verifyEnvelopeRaw,
} from "./message-protocol.js";
import {
  HASH_ALGORITHM,
  MEDIA_ROLE,
  NFT_MIGRATED_SERIAL_BIT,
  RETIREMENT_MODE,
  buildSignedNftMetadataEnvelope,
  computeL1NftId,
  computeMigratedSerial,
  encodeMigrationClaim,
  encodePinOnlyProvenance,
} from "./nft-protocol.js";
import { DEFAULT_L1_CHAIN_ID, DEFAULT_OFFICIAL_COLLECTION_ID, LEGACY_SOURCE_CHAIN } from "./nft-inventory.js";

// Locked Pillar 4 official Task Node collection policy:
//   - TRANSFERABLE = true (bit 0 = 1)
//   - ISSUER_BURNABLE = false (bit 1 MUST be OFF!)
//   - collection_flags = 0 (BURN_LOCKED = false, TRANSFER_LOCKED = false)
//   - issuer_transfer_fee = 0
export const NFT_FLAG_TRANSFERABLE = 1;
export const NFT_FLAG_ISSUER_BURNABLE = 2;
export const OFFICIAL_NFT_MINT_FLAGS = NFT_FLAG_TRANSFERABLE;
export const OFFICIAL_NFT_COLLECTION_FLAGS = 0;
export const OFFICIAL_NFT_TRANSFER_FEE = 0;

function safeText(value = "", max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeTokenId(value = "") {
  return safeText(value, 256).toUpperCase();
}

export function assertOfficialCollectionPolicy({ flags, collectionFlags, issuerTransferFee } = {}) {
  const f = Number(flags ?? OFFICIAL_NFT_MINT_FLAGS);
  const cf = Number(collectionFlags ?? OFFICIAL_NFT_COLLECTION_FLAGS);
  const fee = Number(issuerTransferFee ?? OFFICIAL_NFT_TRANSFER_FEE);
  if ((f & NFT_FLAG_ISSUER_BURNABLE) !== 0) {
    throw new Error("official_collection_forbids_issuer_burnable");
  }
  if ((f & NFT_FLAG_TRANSFERABLE) === 0) {
    throw new Error("official_collection_requires_transferable");
  }
  if (cf !== 0) {
    throw new Error("official_collection_forbids_lock_flags");
  }
  if (fee !== 0) {
    throw new Error("official_collection_requires_zero_transfer_fee");
  }
  return {
    flags: f,
    collectionFlags: cf,
    issuerTransferFee: fee,
    transferable: true,
    issuerBurnable: false,
  };
}

// Persistent atomic JSON migration ledger + permanent `used_nft_serials` tombstones.
export class FileMigrationLedgerStore {
  constructor(filePath = "") {
    this.filePath = filePath;
    this.state = {
      schema: "postfiat-nft-migration-ledger-v1",
      used_nft_serials: {},
      items: {},
      provenance: {},
      updatedAt: null,
    };
    if (this.filePath && existsSync(this.filePath)) {
      const loaded = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.state = {
        schema: "postfiat-nft-migration-ledger-v1",
        used_nft_serials: loaded.used_nft_serials || {},
        items: loaded.items || {},
        provenance: loaded.provenance || {},
        updatedAt: loaded.updatedAt || null,
      };
    }
  }

  persist() {
    this.state.updatedAt = new Date().toISOString();
    if (!this.filePath) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.filePath);
  }

  isSerialUsed(targetNftId) {
    return Boolean(this.state.used_nft_serials[String(targetNftId || "").toLowerCase()]);
  }

  getUsedSerial(targetNftId) {
    return this.state.used_nft_serials[String(targetNftId || "").toLowerCase()] || null;
  }

  // Tombstone is PERMANENT — never deleted even if the new-chain NFT is later burned.
  recordUsedSerial(targetNftId, info = {}) {
    const key = String(targetNftId || "").toLowerCase();
    if (!this.state.used_nft_serials[key]) {
      this.state.used_nft_serials[key] = {
        targetNftId: key,
        nftokenId: normalizeTokenId(info.nftokenId),
        migratedSerial: String(info.migratedSerial || ""),
        mintedHeight: Number(info.mintedHeight || 0),
        mintTxHash: safeText(info.mintTxHash, 128),
        recordedAt: new Date().toISOString(),
      };
      this.persist();
    }
    return this.state.used_nft_serials[key];
  }

  getItem(nftokenId) {
    const key = normalizeTokenId(nftokenId);
    const rec = this.state.items[key];
    return rec ? { ...rec } : null;
  }

  saveItem(nftokenId, patch = {}) {
    const key = normalizeTokenId(nftokenId);
    this.state.items[key] = {
      ...(this.state.items[key] || {}),
      ...patch,
      nftokenId: key,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return this.getItem(key);
  }

  saveProvenance(nftokenId, record = {}) {
    const key = normalizeTokenId(nftokenId);
    this.state.provenance[key] = {
      ...record,
      nftokenId: key,
      retirementMode: "pin_only",
      status: "recorded",
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return { ...this.state.provenance[key] };
  }

  getProvenance(nftokenId) {
    const key = normalizeTokenId(nftokenId);
    return this.state.provenance[key] ? { ...this.state.provenance[key] } : null;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
}

function validateOldBurnProof({ burnProof, expectedOldOwner, expectedNftokenId, expectedClaimHashHex }) {
  if (!burnProof || burnProof.validated !== true) {
    throw new Error("old_chain_burn_not_validated");
  }
  const burnAccount = safeText(burnProof.account || burnProof.Account, 120);
  if (!burnAccount || burnAccount !== expectedOldOwner) {
    throw new Error("old_chain_burn_account_mismatch");
  }
  const burnedTokenId = normalizeTokenId(burnProof.nftokenId || burnProof.NFTokenID);
  if (!burnedTokenId || burnedTokenId !== expectedNftokenId) {
    throw new Error("old_chain_burn_token_id_mismatch");
  }
  const memoClaimHash = safeText(burnProof.claimHashHex || burnProof.memoClaimHashHex, 128).toLowerCase();
  if (!memoClaimHash || memoClaimHash !== String(expectedClaimHashHex).toLowerCase()) {
    throw new Error("old_chain_burn_claim_hash_memo_mismatch");
  }
  if (!safeText(burnProof.txHash, 128)) {
    throw new Error("old_chain_burn_tx_hash_missing");
  }
  return {
    burnTxHash: safeText(burnProof.txHash, 128),
    burnLedgerIndex: Number(burnProof.ledgerIndex || burnProof.ledger_index || 0),
    account: burnAccount,
    claimHashHex: memoClaimHash,
  };
}

// Burn-First Idempotent Batch Migrator (Pillar 4 Section 2):
// Enforces:
//   - Frozen allowlist + pre-cutoff ledger check
//   - Durable claim signing & IPFS pin BEFORE any irreversible old-chain burn
//   - Old-chain NFTokenBurn with claim_hash in memo + history RPC validation (burn_tx.account == old_owner)
//   - Permanent `used_nft_serials` idempotency guard + on-chain nft_info pre-check (ZERO duplicate mints)
//   - Official Task Node issuer mint: ISSUER_BURNABLE OFF, TRANSFERABLE ON, 0 transfer fee, signed pf.nft.metadata.v1
//   - Partial-failure resume from exact persisted checkpoint without re-burning or re-minting
export function createBurnFirstNftMigrator({
  allowlist,
  allowlistCid = null,
  ledgerStore,
  targetChainId = DEFAULT_L1_CHAIN_ID,
  targetCollectionId = DEFAULT_OFFICIAL_COLLECTION_ID,
  migrationIssuerSigner,
  claimantSigner,
  newOwnerAccount = "",
  pinRawBlock,
  burnOldChainNft,
  findOldChainBurn = null,
  verifyOldChainBurn,
  queryL1NftInfo = null,
  queryL1UsedSerial = null,
  mintL1Nft,
  anchorPinOnlyProvenance = null,
  policyOverrides = {},
} = {}) {
  if (!ledgerStore) throw new Error("migration_ledger_store_required");
  if (!migrationIssuerSigner?.publicKey || !migrationIssuerSigner?.secretKey) {
    throw new Error("migration_issuer_signer_required");
  }
  if (!claimantSigner?.publicKey || !claimantSigner?.secretKey) {
    throw new Error("claimant_signer_required");
  }
  const policy = assertOfficialCollectionPolicy(policyOverrides);
  const migrationIssuerAccount = addressFromPublicKey(migrationIssuerSigner.publicKey);
  const claimantAccount = addressFromPublicKey(claimantSigner.publicKey);
  const resolvedNewOwner = safeText(newOwnerAccount || claimantAccount, 120);
  if (resolvedNewOwner !== claimantAccount) {
    throw new Error("claimant_signer_must_match_new_owner_account");
  }

  const allowlistEntries = new Map();
  const entries = Array.isArray(allowlist?.entries) ? allowlist.entries : Array.isArray(allowlist) ? allowlist : [];
  for (const entry of entries) {
    const tokenId = normalizeTokenId(entry.nftokenId || entry.nftoken_id);
    if (tokenId) allowlistEntries.set(tokenId, entry);
  }
  const cutoffLedgerIndex = Number(allowlist?.cutoffLedgerIndex || 0);

  async function migrateOne(nftInput, { mode = "burn_first", dryRun = false, oldWalletSignatureHex = "" } = {}) {
    const tokenId = normalizeTokenId(nftInput?.nftokenId || nftInput?.nftTokenId || nftInput);
    if (!tokenId) throw new Error("migration_nftoken_id_required");

    // 1. Verify frozen pre-cutoff allowlist membership.
    const allowed = allowlistEntries.get(tokenId);
    if (!allowed) {
      return { ok: false, skipped: false, nftokenId: tokenId, error: "nft_not_in_allowlist" };
    }
    const sourceChain = safeText(allowed.sourceChain || allowlist?.sourceChain || LEGACY_SOURCE_CHAIN, 80);
    if (cutoffLedgerIndex > 0 && (Number(allowed.mintLedgerIndex || 0) <= 0 || Number(allowed.mintLedgerIndex) >= cutoffLedgerIndex)) {
      return { ok: false, skipped: false, nftokenId: tokenId, error: "nft_post_cutoff_rejected" };
    }

    const migratedSerial = computeMigratedSerial(sourceChain, tokenId);
    if ((migratedSerial & NFT_MIGRATED_SERIAL_BIT) === 0n) {
      throw new Error("migrated_serial_high_bit_invariant_failed");
    }
    const targetNftId = computeL1NftId({
      chainId: targetChainId,
      issuer: migrationIssuerAccount,
      collectionId: targetCollectionId,
      serial: migratedSerial,
    });

    // Optional pin-only mode: records provenance strictly as "recorded", never burns or mints live NFT.
    if (mode === "pin_only") {
      const existingProv = ledgerStore.getProvenance(tokenId);
      if (existingProv) {
        return {
          ok: true,
          skipped: true,
          reason: "already_recorded_provenance",
          mode: "pin_only",
          nftokenId: tokenId,
          provenance: existingProv,
        };
      }
      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          mode: "pin_only",
          nftokenId: tokenId,
          targetNftId,
          migratedSerial: migratedSerial.toString(),
        };
      }
      const provBody = encodePinOnlyProvenance({
        schemaVersion: 1,
        targetChainId,
        claimantAccount,
        origin: {
          sourceChain,
          nftokenId: tokenId,
          originalIssuer: allowed.originalIssuer || allowed.oldOwner,
          originalOwner: allowed.oldOwner,
          originalUri: allowed.originalUri || "",
          mintTx: allowed.mintTx || "",
          mintLedgerIndex: Number(allowed.mintLedgerIndex || 0),
          retirementMode: RETIREMENT_MODE.PIN_ONLY,
        },
        oldWalletSignatureHex: safeText(oldWalletSignatureHex, 512),
        recordedAtUnixMs: Date.now(),
      });
      const provHeader = encodeMessageHeader({
        protocolVersion: 1,
        chainId: targetChainId,
        schemaName: "pf.nft.provenance.v1",
        schemaId: SCHEMA_ID.NFT_PROVENANCE_V1,
        kind: CONTENT_KIND.NFT,
        visibility: VISIBILITY.PUBLIC,
        bodyEncoding: BODY_ENCODING.PROTOBUF,
        senderAccount: claimantAccount,
        createdAtUnixMs: Date.now(),
      });
      const signedProv = signEnvelopeMlDsa65({
        version: 1,
        headerBytes: provHeader,
        bodyBytes: provBody,
        publicKey: claimantSigner.publicKey,
        secretKey: claimantSigner.secretKey,
      });
      if (typeof pinRawBlock === "function") {
        await pinRawBlock({ bytes: signedProv.rawEnvelopeBytes, cid: signedProv.cid.multibaseCid, kind: "nft_provenance" });
      }
      const anchored = typeof anchorPinOnlyProvenance === "function"
        ? await anchorPinOnlyProvenance({
            nftokenId: tokenId,
            claimantAccount,
            provenanceCid: signedProv.cid.multibaseCid,
            rawEnvelopeBytes: signedProv.rawEnvelopeBytes,
          })
        : { txHash: "" };
      const saved = ledgerStore.saveProvenance(tokenId, {
        targetChainId,
        claimantAccount,
        oldOwner: allowed.oldOwner,
        provenanceCid: signedProv.cid.multibaseCid,
        provenanceTxHash: safeText(anchored?.txHash, 128),
      });
      return { ok: true, skipped: false, mode: "pin_only", nftokenId: tokenId, provenance: saved };
    }

    // 2. Permanent `used_nft_serials` idempotency guard (local ledger AND on-chain check).
    if (ledgerStore.isSerialUsed(targetNftId)) {
      return {
        ok: true,
        skipped: true,
        reason: "already_migrated_serial_used",
        nftokenId: tokenId,
        targetNftId,
        migratedSerial: migratedSerial.toString(),
        tombstone: ledgerStore.getUsedSerial(targetNftId),
        item: ledgerStore.getItem(tokenId),
      };
    }
    if (typeof queryL1UsedSerial === "function") {
      const chainUsed = await queryL1UsedSerial(targetNftId);
      if (chainUsed) {
        ledgerStore.recordUsedSerial(targetNftId, {
          nftokenId: tokenId,
          migratedSerial: migratedSerial.toString(),
          mintedHeight: Number(chainUsed.mintedHeight || 0),
          mintTxHash: chainUsed.mintTxHash || "",
        });
        return {
          ok: true,
          skipped: true,
          reason: "already_migrated_onchain_tombstone",
          nftokenId: tokenId,
          targetNftId,
          migratedSerial: migratedSerial.toString(),
        };
      }
    }
    if (typeof queryL1NftInfo === "function") {
      const existingOnChain = await queryL1NftInfo(targetNftId).catch(() => null);
      if (existingOnChain) {
        // Even if the NFT was later burned on postfiatl1v2, record tombstone and NEVER re-mint!
        ledgerStore.recordUsedSerial(targetNftId, {
          nftokenId: tokenId,
          migratedSerial: migratedSerial.toString(),
          mintedHeight: Number(existingOnChain.mintedHeight || 0),
        });
        ledgerStore.saveItem(tokenId, {
          status: "minted",
          targetNftId,
          migratedSerial: migratedSerial.toString(),
          migrationIssuerAccount,
          targetCollectionId,
          newOwnerAccount: resolvedNewOwner,
          metadataUri: existingOnChain.metadata_uri || existingOnChain.metadataUri || "",
          metadataHash: existingOnChain.metadata_hash || existingOnChain.metadataHash || "",
        });
        return {
          ok: true,
          skipped: true,
          reason: existingOnChain.burned ? "nft_serial_already_used_after_burn" : "already_minted_onchain",
          nftokenId: tokenId,
          targetNftId,
          migratedSerial: migratedSerial.toString(),
        };
      }
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        mode: "burn_first",
        nftokenId: tokenId,
        oldOwner: allowed.oldOwner,
        newOwnerAccount: resolvedNewOwner,
        migrationIssuerAccount,
        targetCollectionId,
        migratedSerial: migratedSerial.toString(),
        targetNftId,
        policy,
      };
    }

    // Load any existing checkpoint for partial-failure resume!
    let item = ledgerStore.getItem(tokenId) || {
      nftokenId: tokenId,
      sourceChain,
      oldOwner: allowed.oldOwner,
      newOwnerAccount: resolvedNewOwner,
      targetChainId,
      targetCollectionId,
      migrationIssuerAccount,
      migratedSerial: migratedSerial.toString(),
      targetNftId,
      status: "allowlist_verified",
    };

    // 3. Step A: Sign & durably pin `pf.nft.claim.v1` BEFORE any irreversible old-chain burn.
    if (!item.claimCid || !item.claimHashHex) {
      const claimBody = encodeMigrationClaim({
        schemaVersion: 1,
        targetChainId,
        sourceChain,
        nftokenId: tokenId,
        oldOwner: allowed.oldOwner,
        newOwnerAccount: resolvedNewOwner,
        targetCollectionId,
        migrationIssuerAccount,
        migratedSerial,
        retirementMode: RETIREMENT_MODE.BURN_FIRST,
        cutoffLedgerIndex,
        claimedAtUnixMs: Date.now(),
        allowlistCid: allowlistCid || null,
      });
      const claimHeader = encodeMessageHeader({
        protocolVersion: 1,
        chainId: targetChainId,
        schemaName: "pf.nft.claim.v1",
        schemaId: SCHEMA_ID.NFT_CLAIM_V1,
        kind: CONTENT_KIND.NFT,
        visibility: VISIBILITY.PUBLIC,
        bodyEncoding: BODY_ENCODING.PROTOBUF,
        senderAccount: claimantAccount,
        createdAtUnixMs: Date.now(),
      });
      const signedClaim = signEnvelopeMlDsa65({
        version: 1,
        headerBytes: claimHeader,
        bodyBytes: claimBody,
        publicKey: claimantSigner.publicKey,
        secretKey: claimantSigner.secretKey,
      });
      const claimHashHex = sha256Bytes(signedClaim.rawEnvelopeBytes).toString("hex");
      if (typeof pinRawBlock === "function") {
        await pinRawBlock({ bytes: signedClaim.rawEnvelopeBytes, cid: signedClaim.cid.multibaseCid, kind: "nft_claim" });
      }
      item = ledgerStore.saveItem(tokenId, {
        ...item,
        status: "claim_signed_and_pinned",
        claimCid: signedClaim.cid.multibaseCid,
        claimCidBinHex: signedClaim.cid.cidBinHex,
        claimByteLength: signedClaim.cid.byteLength,
        claimHashHex,
      });
    }

    // 4. Step B: Burn old-chain NFT FIRST with claim_hash in memo, then validate burn via history RPC.
    // A stop at any point resumes without loss: a durable burn_intent precedes the burner, an
    // old-chain look-up for this burn precedes every burn call, and a saved burn hash is never re-burned.
    if (!item.burnTxHash || item.burnValidated !== true) {
      if (typeof findOldChainBurn !== "function") throw new Error("old_chain_burn_lookup_required");
      const burnQuery = {
        nftokenId: tokenId,
        oldOwner: allowed.oldOwner,
        expectedOldOwner: allowed.oldOwner,
        claimHashHex: item.claimHashHex,
        expectedClaimHashHex: item.claimHashHex,
      };
      const lookUp = async (txHash) => {
        const verified = txHash && typeof verifyOldChainBurn === "function"
          ? await verifyOldChainBurn({ ...burnQuery, txHash })
          : null;
        return verified || findOldChainBurn(burnQuery);
      };
      let rawBurn = null;
      if (item.burnTxHash || item.status === "burn_submitted") {
        // The burner already answered for this item: look up only, never burn again.
        rawBurn = await lookUp(item.burnTxHash);
      } else {
        rawBurn = await findOldChainBurn(burnQuery);
        if (!rawBurn) {
          if (typeof burnOldChainNft !== "function") throw new Error("old_chain_burn_fn_required");
          item = ledgerStore.saveItem(tokenId, {
            ...item,
            status: "burn_intent",
            burnIntentAt: new Date().toISOString(),
          });
          const burnSubmitted = await burnOldChainNft({
            nftokenId: tokenId,
            oldOwner: allowed.oldOwner,
            claimHashHex: item.claimHashHex,
            claimCid: item.claimCid,
          });
          item = ledgerStore.saveItem(tokenId, {
            ...item,
            status: "burn_submitted",
            burnTxHash: safeText(burnSubmitted?.txHash, 128),
          });
          rawBurn = await lookUp(item.burnTxHash);
        }
      }
      const verifiedBurn = validateOldBurnProof({
        burnProof: rawBurn,
        expectedOldOwner: allowed.oldOwner,
        expectedNftokenId: tokenId,
        expectedClaimHashHex: item.claimHashHex,
      });
      item = ledgerStore.saveItem(tokenId, {
        ...item,
        status: "old_burned",
        burnTxHash: verifiedBurn.burnTxHash,
        burnLedgerIndex: verifiedBurn.burnLedgerIndex,
        burnValidated: true,
      });
    }

    // 5. Step C: Build, sign & pin canonical `pf.nft.metadata.v1` envelope (One-Hash Rule).
    if (!item.metadataUri || !item.metadataHash) {
      const imageUri = allowed.imageCid ? `ipfs://${allowed.imageCid}` : allowed.originalUri || "";
      const imageDigest = sha3_384Bytes(Buffer.from(imageUri, "utf8"));
      const metadataBody = {
        schemaVersion: 1,
        name: allowed.title || `Post Fiat Profile NFT ${tokenId.slice(0, 8)}`,
        description: allowed.description || "Migrated post-quantum Post Fiat NFT.",
        image: imageUri,
        media: imageUri
          ? [{
              uri: imageUri,
              mimeType: "image/png",
              role: MEDIA_ROLE.PRIMARY_IMAGE,
              sha3_384Digest: imageDigest,
            }]
          : [],
        attributes: Array.isArray(allowed.attributes) ? allowed.attributes : [],
        collection: {
          collectionId: targetCollectionId,
          issuerAccount: migrationIssuerAccount,
          name: "Post Fiat Profile NFTs",
        },
        contentHashes: imageUri
          ? [{ uri: imageUri, algorithm: HASH_ALGORITHM.SHA3_384, digest: imageDigest }]
          : [],
        origin: {
          sourceChain,
          nftokenId: tokenId,
          originalIssuer: allowed.originalIssuer || allowed.oldOwner,
          originalOwner: allowed.oldOwner,
          originalUri: allowed.originalUri || "",
          mintTx: allowed.mintTx || "",
          mintLedgerIndex: Number(allowed.mintLedgerIndex || 0),
          retirementMode: RETIREMENT_MODE.BURN_FIRST,
          burnTx: item.burnTxHash,
          burnLedgerIndex: Number(item.burnLedgerIndex || 0),
          claimCid: {
            cidBin: Buffer.from(item.claimCidBinHex, "hex"),
            byteLength: Number(item.claimByteLength || 0),
            multibaseCid: item.claimCid,
          },
          claimHash: Buffer.from(item.claimHashHex, "hex"),
          migratedSerial,
        },
      };
      const signedMeta = buildSignedNftMetadataEnvelope({
        metadata: metadataBody,
        chainId: targetChainId,
        issuerAccount: migrationIssuerAccount,
        issuerPublicKey: migrationIssuerSigner.publicKey,
        issuerSecretKey: migrationIssuerSigner.secretKey,
      });

      // Self-verify One-Hash Rule & issuer signature before pinning/minting!
      const check = verifyEnvelopeRaw(signedMeta.rawEnvelopeBytes, {
        expectedMetadataHashSha3_384: signedMeta.metadataHash,
        expectedSenderAccount: migrationIssuerAccount,
      });
      if (!check.ok) throw new Error(`metadata_envelope_self_check_failed:${check.reason}`);

      if (typeof pinRawBlock === "function") {
        await pinRawBlock({ bytes: signedMeta.rawEnvelopeBytes, cid: signedMeta.cid.multibaseCid, kind: "nft_metadata" });
      }
      item = ledgerStore.saveItem(tokenId, {
        ...item,
        status: "metadata_signed_and_pinned",
        metadataCid: signedMeta.cid.multibaseCid,
        metadataUri: signedMeta.metadataUri,
        metadataHash: signedMeta.metadataHash,
      });
    }

    // 6. Step D: Mint new-chain postfiatl1v2 NFT with official Task Node policy & record permanent tombstone.
    if (typeof mintL1Nft !== "function") throw new Error("l1_nft_mint_fn_required");
    const mintTxPayload = {
      operation: "nft_mint",
      chain_id: targetChainId,
      nft_id: targetNftId,
      issuer: migrationIssuerAccount,
      collection_id: targetCollectionId,
      serial: migratedSerial.toString(),
      owner: resolvedNewOwner,
      metadata_uri: item.metadataUri,
      metadata_hash: item.metadataHash,
      flags: policy.flags,
      collection_flags: policy.collectionFlags,
      issuer_transfer_fee: policy.issuerTransferFee,
      transferable: true,
      issuer_burnable: false,
    };
    const minted = await mintL1Nft(mintTxPayload);
    const mintTxHash = safeText(minted?.txHash || minted?.tx_hash, 128);
    const mintedHeight = Number(minted?.blockHeight || minted?.block_height || 0);

    ledgerStore.recordUsedSerial(targetNftId, {
      nftokenId: tokenId,
      migratedSerial: migratedSerial.toString(),
      mintedHeight,
      mintTxHash,
    });
    item = ledgerStore.saveItem(tokenId, {
      ...item,
      status: "minted",
      mintTxHash,
      mintedHeight,
      mintedAt: new Date().toISOString(),
      flags: policy.flags,
      collectionFlags: policy.collectionFlags,
      issuerTransferFee: policy.issuerTransferFee,
      transferable: true,
      issuerBurnable: false,
    });

    return {
      ok: true,
      skipped: false,
      mode: "burn_first",
      nftokenId: tokenId,
      targetNftId,
      migratedSerial: migratedSerial.toString(),
      item,
    };
  }

  async function migrateBatch(nftList = null, options = {}) {
    const targets = Array.isArray(nftList) && nftList.length
      ? nftList
      : [...allowlistEntries.values()];
    const results = [];
    let migratedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let recordedCount = 0;

    for (const entry of targets) {
      const tokenId = normalizeTokenId(entry?.nftokenId || entry?.nftTokenId || entry);
      try {
        const res = await migrateOne(entry, options);
        results.push(res);
        if (!res.ok) failedCount += 1;
        else if (res.skipped) skippedCount += 1;
        else if (res.mode === "pin_only") recordedCount += 1;
        else migratedCount += 1;
      } catch (error) {
        failedCount += 1;
        results.push({
          ok: false,
          skipped: false,
          nftokenId: tokenId,
          error: error?.message || "migration_failed",
        });
        if (options.stopOnError) break;
      }
    }

    return {
      ok: failedCount === 0,
      dryRun: Boolean(options.dryRun),
      mode: options.mode || "burn_first",
      summary: {
        total: targets.length,
        migratedCount,
        skippedCount,
        recordedCount,
        failedCount,
      },
      results,
    };
  }

  return {
    migrationIssuerAccount,
    claimantAccount,
    policy,
    migrateOne,
    migrateBatch,
  };
}
