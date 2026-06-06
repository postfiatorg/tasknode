import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";

const runtimeNfts = new Map();

const safeAccountId = (value = "") => String(value || "").trim().slice(0, 160);
const safeText = (value = "", max = 2000) => String(value || "").trim().slice(0, max);
const nowIso = () => new Date().toISOString();

function gatewayUrlForCid(cid = "") {
  const normalized = safeText(cid, 120);
  return normalized ? `https://dweb.link/ipfs/${encodeURIComponent(normalized)}` : "";
}

function normalizeRecord(record = {}) {
  const imageCid = safeText(record.image_cid || record.imageCid, 160);
  const metadataCid = safeText(record.metadata_cid || record.metadataCid, 160);
  return {
    id: record.id || "",
    accountId: record.account_id || record.accountId || "",
    walletAddress: record.wallet_address || record.walletAddress || "",
    title: record.title || "Task Node Profile NFT",
    description: record.description || "",
    status: record.status || "generated",
    imageCid,
    imageGatewayUrl: record.image_gateway_url || record.imageGatewayUrl || gatewayUrlForCid(imageCid),
    imageMimeType: record.image_mime_type || record.imageMimeType || "",
    imageSizeBytes: Number(record.image_size_bytes || record.imageSizeBytes || 0),
    imageSha256: record.image_sha256 || record.imageSha256 || "",
    metadataCid,
    metadataUri: record.metadata_uri || record.metadataUri || (metadataCid ? `ipfs://${metadataCid}` : ""),
    metadataJson: record.metadata_json || record.metadataJson || {},
    promptSource: record.prompt_source || record.promptSource || "",
    promptDigest: record.prompt_digest || record.promptDigest || "",
    templateDigest: record.template_digest || record.templateDigest || "",
    model: record.model || "",
    size: record.size || "",
    quality: record.quality || "",
    outputFormat: record.output_format || record.outputFormat || "",
    mintTxJson: record.mint_tx_json || record.mintTxJson || {},
    txHash: record.tx_hash || record.txHash || "",
    nftTokenId: record.nft_token_id || record.nftTokenId || "",
    selected: Boolean(record.selected),
    error: record.error || "",
    generatedAt: record.generated_at || record.generatedAt || null,
    preparedAt: record.prepared_at || record.preparedAt || null,
    mintedAt: record.minted_at || record.mintedAt || null,
    createdAt: record.created_at || record.createdAt || null,
    updatedAt: record.updated_at || record.updatedAt || null,
  };
}

function runtimeList({ accountId = "", walletAddress = "", hasWalletFilter = false, includeWalletless = true } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedWalletAddress = safeText(walletAddress, 120);
  return [...runtimeNfts.values()]
    .filter((record) => {
      if (record.accountId !== normalizedAccountId) return false;
      if (!hasWalletFilter) return true;
      if (record.walletAddress === normalizedWalletAddress) return true;
      return includeWalletless && !record.walletAddress;
    })
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export async function createGeneratedProfileNft({
  accountId = "",
  walletAddress = "",
  title = "Task Node Profile NFT",
  description = "",
  imageCid = "",
  imageGatewayUrl = "",
  imageMimeType = "",
  imageSizeBytes = 0,
  imageSha256 = "",
  promptSource = "",
  promptDigest = "",
  templateDigest = "",
  model = "",
  size = "",
  quality = "",
  outputFormat = "",
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) {
    const error = new Error("profile_nft_account_required");
    error.status = 401;
    throw error;
  }

  const id = `nft_${randomUUID()}`;
  const generatedAt = nowIso();
  const record = normalizeRecord({
    id,
    accountId: normalizedAccountId,
    walletAddress: safeText(walletAddress, 120),
    title: safeText(title, 120) || "Task Node Profile NFT",
    description: safeText(description, 800),
    status: "generated",
    imageCid: safeText(imageCid, 160),
    imageGatewayUrl: safeText(imageGatewayUrl, 500) || gatewayUrlForCid(imageCid),
    imageMimeType: safeText(imageMimeType, 120),
    imageSizeBytes: Math.max(0, Number(imageSizeBytes || 0)),
    imageSha256: safeText(imageSha256, 128),
    promptSource: safeText(promptSource, 80),
    promptDigest: safeText(promptDigest, 128),
    templateDigest: safeText(templateDigest, 128),
    model: safeText(model, 80),
    size: safeText(size, 40),
    quality: safeText(quality, 40),
    outputFormat: safeText(outputFormat, 40),
    generatedAt,
    createdAt: generatedAt,
    updatedAt: generatedAt,
  });

  if (!databaseEnabled()) {
    runtimeNfts.set(id, record);
    return record;
  }

  const result = await query(
    `INSERT INTO profile_nfts (
       id, account_id, wallet_address, title, description, status,
       image_cid, image_gateway_url, image_mime_type, image_size_bytes, image_sha256,
       prompt_source, prompt_digest, template_digest, model, size, quality, output_format,
       generated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, 'generated',
       $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17,
       now()
     )
     RETURNING *`,
    [
      record.id,
      record.accountId,
      record.walletAddress,
      record.title,
      record.description,
      record.imageCid,
      record.imageGatewayUrl,
      record.imageMimeType,
      record.imageSizeBytes,
      record.imageSha256,
      record.promptSource,
      record.promptDigest,
      record.templateDigest,
      record.model,
      record.size,
      record.quality,
      record.outputFormat,
    ]
  );
  return normalizeRecord(result.rows[0]);
}

export async function listProfileNfts(options = {}) {
  options = options && typeof options === "object" ? options : {};
  const { accountId = "", limit = 12, includeWalletless = true } = options;
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return [];
  const hasWalletFilter = Object.hasOwn(options, "walletAddress");
  const walletAddress = safeText(options.walletAddress, 120);
  const boundedLimit = Math.min(Math.max(Number(limit || 12), 1), 40);

  if (!databaseEnabled()) {
    return runtimeList({
      accountId: normalizedAccountId,
      walletAddress,
      hasWalletFilter,
      includeWalletless,
    }).slice(0, boundedLimit);
  }

  const result = hasWalletFilter
    ? await query(
        `SELECT *
           FROM profile_nfts
          WHERE account_id = $1
            AND (
              wallet_address = $3
              OR ($4::boolean = true AND wallet_address = '')
            )
          ORDER BY updated_at DESC
          LIMIT $2`,
        [normalizedAccountId, boundedLimit, walletAddress, includeWalletless === true]
      )
    : await query(
        `SELECT *
           FROM profile_nfts
          WHERE account_id = $1
          ORDER BY updated_at DESC
          LIMIT $2`,
        [normalizedAccountId, boundedLimit]
      );
  return result.rows.map(normalizeRecord);
}

export async function getProfileNft({ accountId = "", nftId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedNftId = safeText(nftId, 120);
  if (!normalizedAccountId || !normalizedNftId) return null;

  if (!databaseEnabled()) {
    const record = runtimeNfts.get(normalizedNftId);
    return record?.accountId === normalizedAccountId ? record : null;
  }

  const result = await query(
    `SELECT *
       FROM profile_nfts
      WHERE account_id = $1
        AND id = $2`,
    [normalizedAccountId, normalizedNftId]
  );
  return result.rows[0] ? normalizeRecord(result.rows[0]) : null;
}

export async function markProfileNftMintPrepared({
  accountId = "",
  nftId = "",
  metadataCid = "",
  metadataUri = "",
  metadataJson = {},
  mintTxJson = {},
  walletAddress = "",
} = {}) {
  const record = await getProfileNft({ accountId, nftId });
  if (!record) return null;
  const normalizedWalletAddress = safeText(walletAddress, 120);
  const preparedAt = nowIso();

  if (!databaseEnabled()) {
    const next = normalizeRecord({
      ...record,
      walletAddress: record.walletAddress || normalizedWalletAddress,
      status: "prepared",
      metadataCid,
      metadataUri,
      metadataJson,
      mintTxJson,
      preparedAt,
      updatedAt: preparedAt,
    });
    runtimeNfts.set(record.id, next);
    return next;
  }

  const result = await query(
    `UPDATE profile_nfts
        SET status = 'prepared',
            wallet_address = CASE
              WHEN wallet_address = '' AND $7::text <> '' THEN $7
              ELSE wallet_address
            END,
            metadata_cid = $3,
            metadata_uri = $4,
            metadata_json = $5::jsonb,
            mint_tx_json = $6::jsonb,
            prepared_at = now(),
            updated_at = now(),
            error = ''
      WHERE account_id = $1
        AND id = $2
      RETURNING *`,
    [
      safeAccountId(accountId),
      safeText(nftId, 120),
      safeText(metadataCid, 160),
      safeText(metadataUri, 240),
      JSON.stringify(metadataJson || {}),
      JSON.stringify(mintTxJson || {}),
      normalizedWalletAddress,
    ]
  );
  return result.rows[0] ? normalizeRecord(result.rows[0]) : null;
}

export async function markProfileNftMinted({
  accountId = "",
  nftId = "",
  txHash = "",
  nftTokenId = "",
} = {}) {
  const record = await getProfileNft({ accountId, nftId });
  if (!record) return null;
  const mintedAt = nowIso();

  if (!databaseEnabled()) {
    const next = normalizeRecord({
      ...record,
      status: "minted",
      txHash,
      nftTokenId,
      mintedAt,
      updatedAt: mintedAt,
    });
    runtimeNfts.set(record.id, next);
    return next;
  }

  const result = await query(
    `UPDATE profile_nfts
        SET status = 'minted',
            tx_hash = $3,
            nft_token_id = $4,
            minted_at = now(),
            updated_at = now(),
            error = ''
      WHERE account_id = $1
        AND id = $2
      RETURNING *`,
    [safeAccountId(accountId), safeText(nftId, 120), safeText(txHash, 128), safeText(nftTokenId, 256)]
  );
  return result.rows[0] ? normalizeRecord(result.rows[0]) : null;
}

export async function markProfileNftFailed({ accountId = "", nftId = "", error = "" } = {}) {
  const record = await getProfileNft({ accountId, nftId });
  if (!record) return null;
  const updatedAt = nowIso();

  if (!databaseEnabled()) {
    const next = normalizeRecord({
      ...record,
      status: "failed",
      error: safeText(error, 500),
      updatedAt,
    });
    runtimeNfts.set(record.id, next);
    return next;
  }

  const result = await query(
    `UPDATE profile_nfts
        SET status = 'failed',
            error = $3,
            updated_at = now()
      WHERE account_id = $1
        AND id = $2
      RETURNING *`,
    [safeAccountId(accountId), safeText(nftId, 120), safeText(error, 500)]
  );
  return result.rows[0] ? normalizeRecord(result.rows[0]) : null;
}
