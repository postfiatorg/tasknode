import { createHash } from "node:crypto";
import {
  decodeIpfsCidRef,
  decodeWireFields,
  encodeIpfsCidRef,
  hashHexDomain,
  pbBool,
  pbBytes,
  pbMapStringString,
  pbMsg,
  pbString,
  pbVarint,
} from "./wire-codec.js";
import {
  BODY_ENCODING,
  CIPHER_SUITE,
  CONTENT_KIND,
  SCHEMA_ID,
  VISIBILITY,
  addressFromPublicKey,
  encodeMessageHeader,
  signEnvelopeMlDsa65,
} from "./message-protocol.js";

export const MAX_NFT_METADATA_URI_BYTES = 256;
export const MAX_NFT_METADATA_HASH_BYTES = 64;
export const NFT_ID_DOMAIN = "postfiat.nft_id.v1";
export const DOMAIN_NFT_MIGRATED_SERIAL = "postfiat.nft.migrated_serial.v1";
export const NFT_MIGRATED_SERIAL_BIT = 1n << 63n;

export const RETIREMENT_MODE = Object.freeze({
  UNSPECIFIED: 0,
  BURN_FIRST: 1,
  PIN_ONLY: 2,
});

export const HASH_ALGORITHM = Object.freeze({
  UNSPECIFIED: 0,
  SHA3_384: 1,
  SHA2_256: 2,
});

export const MEDIA_ROLE = Object.freeze({
  UNSPECIFIED: 0,
  PRIMARY_IMAGE: 1,
  THUMBNAIL: 2,
  ANIMATION: 3,
  AUDIO: 4,
  DOCUMENT: 5,
  ENCRYPTED_PROMPT: 6,
});

export function computeL1NftId({ chainId, issuer, collectionId, serial }) {
  const cid = String(chainId || "").trim();
  const iss = String(issuer || "").trim();
  const col = String(collectionId || "").trim();
  const ser = BigInt(serial);
  if (!cid || !iss || !col || ser <= 0n) {
    throw new Error("nft_id_invalid_inputs");
  }
  const colBytes = Buffer.byteLength(col, "utf8");
  const preimage = `chain_id=${cid}\nissuer=${iss}\ncollection_id_bytes=${colBytes}\ncollection_id=${col}\nserial=${ser.toString()}\n`;
  return hashHexDomain(NFT_ID_DOMAIN, Buffer.from(preimage, "utf8"));
}

export function computeMigratedSerial(sourceChain, nftokenId) {
  const normalizedChain = String(sourceChain || "").trim();
  const normalizedToken = String(nftokenId || "").trim().toUpperCase();
  if (!normalizedChain || !normalizedToken) {
    throw new Error("migrated_serial_invalid_inputs");
  }
  const digest = createHash("sha3-384")
    .update(Buffer.from(DOMAIN_NFT_MIGRATED_SERIAL, "utf8"))
    .update(Buffer.from([0]))
    .update(Buffer.from(normalizedChain, "utf8"))
    .update(Buffer.from([0]))
    .update(Buffer.from(normalizedToken, "utf8"))
    .digest();
  const high64 = digest.readBigUInt64BE(0);
  return NFT_MIGRATED_SERIAL_BIT | (high64 & 0x7fff_ffff_ffff_ffffn);
}

export function encodeContentHash(entry = {}) {
  return Buffer.concat([
    pbString(1, entry.uri || ""),
    pbVarint(2, entry.algorithm || HASH_ALGORITHM.SHA3_384),
    pbBytes(3, entry.digest),
    pbVarint(4, entry.byteLength ?? entry.byte_length ?? 0),
  ]);
}

export function encodeMediaAttachment(media = {}) {
  return Buffer.concat([
    pbString(1, media.uri || ""),
    pbMsg(2, encodeIpfsCidRef(media.cid)),
    pbString(3, media.mimeType || media.mime_type || ""),
    pbVarint(4, media.role ?? MEDIA_ROLE.PRIMARY_IMAGE),
    pbVarint(5, media.width ?? 0),
    pbVarint(6, media.height ?? 0),
    pbVarint(7, media.byteLength ?? media.byte_length ?? 0),
    pbBytes(8, media.sha3_384Digest || media.sha3_384_digest),
    pbBool(9, Boolean(media.encrypted)),
  ]);
}

export function encodeNftAttribute(attr = {}) {
  return Buffer.concat([
    pbString(1, attr.traitType || attr.trait_type || ""),
    pbString(2, String(attr.value ?? "")),
    pbString(3, attr.displayType || attr.display_type || ""),
  ]);
}

export function encodeCollectionRef(col = null) {
  if (!col) return Buffer.alloc(0);
  return Buffer.concat([
    pbString(1, col.collectionId || col.collection_id || ""),
    pbString(2, col.issuerAccount || col.issuer_account || ""),
    pbString(3, col.name || ""),
    pbString(4, col.description || ""),
    pbString(5, col.externalUrl || col.external_url || ""),
  ]);
}

export function encodeOriginProvenance(origin = null) {
  if (!origin) return Buffer.alloc(0);
  return Buffer.concat([
    pbString(1, origin.sourceChain || origin.source_chain || ""),
    pbString(2, origin.nftokenId || origin.nftoken_id || ""),
    pbString(3, origin.originalIssuer || origin.original_issuer || ""),
    pbString(4, origin.originalOwner || origin.original_owner || ""),
    pbString(5, origin.originalUri || origin.original_uri || ""),
    pbString(6, origin.mintTx || origin.mint_tx || ""),
    pbVarint(7, origin.mintLedgerIndex ?? origin.mint_ledger_index ?? 0),
    pbVarint(8, origin.retirementMode ?? origin.retirement_mode ?? 0),
    pbString(9, origin.burnTx || origin.burn_tx || ""),
    pbVarint(10, origin.burnLedgerIndex ?? origin.burn_ledger_index ?? 0),
    pbMsg(11, encodeIpfsCidRef(origin.claimCid || origin.claim_cid)),
    pbBytes(12, origin.claimHash || origin.claim_hash),
    pbMsg(13, encodeIpfsCidRef(origin.burnProofBundleCid || origin.burn_proof_bundle_cid)),
    pbVarint(14, origin.migratedSerial ?? origin.migrated_serial ?? 0),
  ]);
}

export function encodeNftMetadata(meta = {}) {
  return Buffer.concat([
    pbVarint(1, meta.schemaVersion ?? meta.schema_version ?? 1),
    pbString(2, meta.name || ""),
    pbString(3, meta.description || ""),
    pbString(4, meta.image || ""),
    pbMsg(5, encodeIpfsCidRef(meta.imageCid || meta.image_cid)),
    ...(meta.media || []).map((item) => pbMsg(6, encodeMediaAttachment(item))),
    ...(meta.attributes || []).map((item) => pbMsg(7, encodeNftAttribute(item))),
    pbMsg(8, encodeCollectionRef(meta.collection)),
    ...(meta.contentHashes || meta.content_hashes || []).map((item) => pbMsg(9, encodeContentHash(item))),
    pbBytes(10, meta.promptDigest || meta.prompt_digest),
    pbString(11, meta.license || ""),
    pbString(12, meta.externalUrl || meta.external_url || ""),
    pbMsg(13, encodeOriginProvenance(meta.origin)),
    pbMapStringString(14, meta.extensions || {}),
  ]);
}

export function decodeOriginProvenance(buf) {
  const out = {
    sourceChain: "",
    nftokenId: "",
    originalIssuer: "",
    originalOwner: "",
    originalUri: "",
    mintTx: "",
    mintLedgerIndex: 0,
    retirementMode: 0,
    burnTx: "",
    burnLedgerIndex: 0,
    claimCid: null,
    claimHash: Buffer.alloc(0),
    burnProofBundleCid: null,
    migratedSerial: 0n,
  };
  for (const { fieldNum, value } of decodeWireFields(buf)) {
    if (fieldNum === 1) out.sourceChain = value.toString("utf8");
    else if (fieldNum === 2) out.nftokenId = value.toString("utf8");
    else if (fieldNum === 3) out.originalIssuer = value.toString("utf8");
    else if (fieldNum === 4) out.originalOwner = value.toString("utf8");
    else if (fieldNum === 5) out.originalUri = value.toString("utf8");
    else if (fieldNum === 6) out.mintTx = value.toString("utf8");
    else if (fieldNum === 7) out.mintLedgerIndex = Number(value);
    else if (fieldNum === 8) out.retirementMode = Number(value);
    else if (fieldNum === 9) out.burnTx = value.toString("utf8");
    else if (fieldNum === 10) out.burnLedgerIndex = Number(value);
    else if (fieldNum === 11) out.claimCid = decodeIpfsCidRef(value);
    else if (fieldNum === 12) out.claimHash = Buffer.from(value);
    else if (fieldNum === 13) out.burnProofBundleCid = decodeIpfsCidRef(value);
    else if (fieldNum === 14) out.migratedSerial = value;
  }
  out.claimHashHex = out.claimHash.toString("hex");
  return out;
}

export function decodeNftMetadata(buf) {
  const out = {
    schemaVersion: 0,
    name: "",
    description: "",
    image: "",
    imageCid: null,
    media: [],
    attributes: [],
    collection: null,
    contentHashes: [],
    promptDigest: Buffer.alloc(0),
    license: "",
    externalUrl: "",
    origin: null,
    extensions: {},
  };
  for (const { fieldNum, value } of decodeWireFields(buf)) {
    if (fieldNum === 1) out.schemaVersion = Number(value);
    else if (fieldNum === 2) out.name = value.toString("utf8");
    else if (fieldNum === 3) out.description = value.toString("utf8");
    else if (fieldNum === 4) out.image = value.toString("utf8");
    else if (fieldNum === 5) out.imageCid = decodeIpfsCidRef(value);
    else if (fieldNum === 7) {
      const attr = { traitType: "", value: "", displayType: "" };
      for (const f of decodeWireFields(value)) {
        if (f.fieldNum === 1) attr.traitType = f.value.toString("utf8");
        else if (f.fieldNum === 2) attr.value = f.value.toString("utf8");
        else if (f.fieldNum === 3) attr.displayType = f.value.toString("utf8");
      }
      out.attributes.push(attr);
    } else if (fieldNum === 8) {
      const col = { collectionId: "", issuerAccount: "", name: "", description: "", externalUrl: "" };
      for (const f of decodeWireFields(value)) {
        if (f.fieldNum === 1) col.collectionId = f.value.toString("utf8");
        else if (f.fieldNum === 2) col.issuerAccount = f.value.toString("utf8");
        else if (f.fieldNum === 3) col.name = f.value.toString("utf8");
        else if (f.fieldNum === 4) col.description = f.value.toString("utf8");
        else if (f.fieldNum === 5) col.externalUrl = f.value.toString("utf8");
      }
      out.collection = col;
    } else if (fieldNum === 10) out.promptDigest = Buffer.from(value);
    else if (fieldNum === 11) out.license = value.toString("utf8");
    else if (fieldNum === 12) out.externalUrl = value.toString("utf8");
    else if (fieldNum === 13) out.origin = decodeOriginProvenance(value);
    else if (fieldNum === 14) {
      let k = "";
      let v = "";
      for (const f of decodeWireFields(value)) {
        if (f.fieldNum === 1) k = f.value.toString("utf8");
        else if (f.fieldNum === 2) v = f.value.toString("utf8");
      }
      if (k) out.extensions[k] = v;
    }
  }
  return out;
}

export function encodeMigrationClaim(claim = {}) {
  return Buffer.concat([
    pbVarint(1, claim.schemaVersion ?? claim.schema_version ?? 1),
    pbString(2, claim.targetChainId || claim.target_chain_id || ""),
    pbString(3, claim.sourceChain || claim.source_chain || ""),
    pbString(4, claim.nftokenId || claim.nftoken_id || ""),
    pbString(5, claim.oldOwner || claim.old_owner || ""),
    pbString(6, claim.newOwnerAccount || claim.new_owner_account || ""),
    pbString(7, claim.targetCollectionId || claim.target_collection_id || ""),
    pbString(8, claim.migrationIssuerAccount || claim.migration_issuer_account || ""),
    pbVarint(9, claim.migratedSerial ?? claim.migrated_serial ?? 0),
    pbVarint(10, claim.retirementMode ?? claim.retirement_mode ?? RETIREMENT_MODE.BURN_FIRST),
    pbVarint(11, claim.cutoffLedgerIndex ?? claim.cutoff_ledger_index ?? 0),
    pbVarint(12, claim.claimedAtUnixMs ?? claim.claimed_at_unix_ms ?? 0),
    pbMsg(13, encodeIpfsCidRef(claim.allowlistCid || claim.allowlist_cid)),
  ]);
}

export function decodeMigrationClaim(buf) {
  const out = {
    schemaVersion: 0,
    targetChainId: "",
    sourceChain: "",
    nftokenId: "",
    oldOwner: "",
    newOwnerAccount: "",
    targetCollectionId: "",
    migrationIssuerAccount: "",
    migratedSerial: 0n,
    retirementMode: 0,
    cutoffLedgerIndex: 0,
    claimedAtUnixMs: 0,
    allowlistCid: null,
  };
  for (const { fieldNum, value } of decodeWireFields(buf)) {
    if (fieldNum === 1) out.schemaVersion = Number(value);
    else if (fieldNum === 2) out.targetChainId = value.toString("utf8");
    else if (fieldNum === 3) out.sourceChain = value.toString("utf8");
    else if (fieldNum === 4) out.nftokenId = value.toString("utf8");
    else if (fieldNum === 5) out.oldOwner = value.toString("utf8");
    else if (fieldNum === 6) out.newOwnerAccount = value.toString("utf8");
    else if (fieldNum === 7) out.targetCollectionId = value.toString("utf8");
    else if (fieldNum === 8) out.migrationIssuerAccount = value.toString("utf8");
    else if (fieldNum === 9) out.migratedSerial = value;
    else if (fieldNum === 10) out.retirementMode = Number(value);
    else if (fieldNum === 11) out.cutoffLedgerIndex = Number(value);
    else if (fieldNum === 12) out.claimedAtUnixMs = Number(value);
    else if (fieldNum === 13) out.allowlistCid = decodeIpfsCidRef(value);
  }
  return out;
}

export function encodePinOnlyProvenance(prov = {}) {
  return Buffer.concat([
    pbVarint(1, prov.schemaVersion ?? prov.schema_version ?? 1),
    pbString(2, prov.targetChainId || prov.target_chain_id || ""),
    pbString(3, prov.claimantAccount || prov.claimant_account || ""),
    pbMsg(4, encodeOriginProvenance(prov.origin)),
    pbString(5, prov.oldWalletSignatureHex || prov.old_wallet_signature_hex || ""),
    pbVarint(6, prov.recordedAtUnixMs ?? prov.recorded_at_unix_ms ?? 0),
  ]);
}

export function buildSignedNftMetadataEnvelope({
  metadata,
  chainId,
  issuerAccount,
  issuerPublicKey,
  issuerSecretKey,
  createdAtUnixMs = Date.now(),
} = {}) {
  const derived = addressFromPublicKey(issuerPublicKey);
  if (issuerAccount && derived !== issuerAccount) {
    throw new Error("nft_metadata_issuer_pubkey_mismatch");
  }
  const bodyBytes = encodeNftMetadata(metadata);
  const headerBytes = encodeMessageHeader({
    protocolVersion: 1,
    chainId,
    schemaName: "pf.nft.metadata.v1",
    schemaId: SCHEMA_ID.NFT_METADATA_V1,
    kind: CONTENT_KIND.NFT,
    visibility: VISIBILITY.PUBLIC,
    bodyEncoding: BODY_ENCODING.PROTOBUF,
    cipherSuite: CIPHER_SUITE.NONE,
    senderAccount: derived,
    createdAtUnixMs,
  });
  const signed = signEnvelopeMlDsa65({
    version: 1,
    headerBytes,
    encryptionHeaderBytes: Buffer.alloc(0),
    bodyBytes,
    publicKey: issuerPublicKey,
    secretKey: issuerSecretKey,
  });
  const metadataUri = `ipfs://${signed.cid.multibaseCid}`;
  if (Buffer.byteLength(metadataUri, "utf8") > MAX_NFT_METADATA_URI_BYTES) {
    throw new Error("nft_metadata_uri_too_long");
  }
  return {
    ...signed,
    metadataUri,
    metadataHash: signed.metadataHashSha3_384,
    issuerAccount: derived,
  };
}
