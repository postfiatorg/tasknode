import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { nonFixtureProfileNftSql } from "./task-projection-integrity.js";

const runtimeNfts = new Map();
const publicHeroStatusRank = new Map([
  ["minted", 0],
  ["prepared", 1],
  ["generated", 2],
]);

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

function publicHeroStatus(value = "") {
  const status = String(value || "").toLowerCase();
  return publicHeroStatusRank.has(status) ? status : "";
}

function hasPublicHeroImage(record = {}) {
  const normalized = normalizeRecord(record);
  return Boolean(normalized.imageCid || normalized.imageGatewayUrl);
}

function isFixtureProfileNft(record = {}) {
  const normalized = normalizeRecord(record);
  return Boolean(
    normalized.metadataJson?.directoryPolishFixture === true ||
      safeText(normalized.id, 160).startsWith("directory_polish_") ||
      safeText(normalized.model, 120) === "directory-polish"
  );
}

function comparePublicHeroNfts() {
  return (left, right) => {
    if (Boolean(left.selected) !== Boolean(right.selected)) return left.selected ? -1 : 1;
    const leftCreated = String(left.createdAt || left.generatedAt || left.mintedAt || "");
    const rightCreated = String(right.createdAt || right.generatedAt || right.mintedAt || "");
    if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated);
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
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
    .sort((a, b) => {
      const left = String(a.createdAt || a.generatedAt || a.mintedAt || "");
      const right = String(b.createdAt || b.generatedAt || b.mintedAt || "");
      if (left !== right) return right.localeCompare(left);
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
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

export async function createGeneratingProfileNft({
  accountId = "",
  walletAddress = "",
  title = "Task Node Profile NFT",
  description = "",
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
  const createdAt = nowIso();
  const record = normalizeRecord({
    id,
    accountId: normalizedAccountId,
    walletAddress: safeText(walletAddress, 120),
    title: safeText(title, 120) || "Task Node Profile NFT",
    description: safeText(description, 800),
    status: "generating",
    promptSource: safeText(promptSource, 80),
    promptDigest: safeText(promptDigest, 128),
    templateDigest: safeText(templateDigest, 128),
    model: safeText(model, 80),
    size: safeText(size, 40),
    quality: safeText(quality, 40),
    outputFormat: safeText(outputFormat, 40),
    createdAt,
    updatedAt: createdAt,
  });

  if (!databaseEnabled()) {
    runtimeNfts.set(id, record);
    return record;
  }

  const result = await query(
    `INSERT INTO profile_nfts (
       id, account_id, wallet_address, title, description, status,
       prompt_source, prompt_digest, template_digest, model, size, quality, output_format
     )
     VALUES (
       $1, $2, $3, $4, $5, 'generating',
       $6, $7, $8, $9, $10, $11, $12
     )
     RETURNING *`,
    [
      record.id,
      record.accountId,
      record.walletAddress,
      record.title,
      record.description,
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

export async function markProfileNftGenerated({
  accountId = "",
  nftId = "",
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
  const record = await getProfileNft({ accountId, nftId });
  if (!record) return null;
  const generatedAt = nowIso();
  const normalizedImageCid = safeText(imageCid, 160);

  if (!databaseEnabled()) {
    const next = normalizeRecord({
      ...record,
      status: "generated",
      imageCid: normalizedImageCid,
      imageGatewayUrl: safeText(imageGatewayUrl, 500) || gatewayUrlForCid(normalizedImageCid),
      imageMimeType: safeText(imageMimeType, 120),
      imageSizeBytes: Math.max(0, Number(imageSizeBytes || 0)),
      imageSha256: safeText(imageSha256, 128),
      promptSource: safeText(promptSource, 80) || record.promptSource,
      promptDigest: safeText(promptDigest, 128) || record.promptDigest,
      templateDigest: safeText(templateDigest, 128) || record.templateDigest,
      model: safeText(model, 80) || record.model,
      size: safeText(size, 40) || record.size,
      quality: safeText(quality, 40) || record.quality,
      outputFormat: safeText(outputFormat, 40) || record.outputFormat,
      error: "",
      generatedAt,
      updatedAt: generatedAt,
    });
    runtimeNfts.set(record.id, next);
    return next;
  }

  const result = await query(
    `UPDATE profile_nfts
        SET status = 'generated',
            image_cid = $3,
            image_gateway_url = $4,
            image_mime_type = $5,
            image_size_bytes = $6,
            image_sha256 = $7,
            prompt_source = COALESCE(NULLIF($8, ''), prompt_source),
            prompt_digest = COALESCE(NULLIF($9, ''), prompt_digest),
            template_digest = COALESCE(NULLIF($10, ''), template_digest),
            model = COALESCE(NULLIF($11, ''), model),
            size = COALESCE(NULLIF($12, ''), size),
            quality = COALESCE(NULLIF($13, ''), quality),
            output_format = COALESCE(NULLIF($14, ''), output_format),
            generated_at = now(),
            updated_at = now(),
            error = ''
      WHERE account_id = $1
        AND id = $2
      RETURNING *`,
    [
      safeAccountId(accountId),
      safeText(nftId, 120),
      normalizedImageCid,
      safeText(imageGatewayUrl, 500) || gatewayUrlForCid(normalizedImageCid),
      safeText(imageMimeType, 120),
      Math.max(0, Number(imageSizeBytes || 0)),
      safeText(imageSha256, 128),
      safeText(promptSource, 80),
      safeText(promptDigest, 128),
      safeText(templateDigest, 128),
      safeText(model, 80),
      safeText(size, 40),
      safeText(quality, 40),
      safeText(outputFormat, 40),
    ]
  );
  return result.rows[0] ? normalizeRecord(result.rows[0]) : null;
}

export async function listProfileNfts(options = {}) {
  options = options && typeof options === "object" ? options : {};
  const { accountId = "", limit = 12, includeWalletless = true, publicOnly = false } = options;
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return [];
  const hasWalletFilter = Object.hasOwn(options, "walletAddress");
  const walletAddress = safeText(options.walletAddress, 120);
  const boundedLimit = Math.min(Math.max(Number(limit || 12), 1), 240);
  const publicFilter = publicOnly === true
    ? `AND lower(status) IN ('minted', 'prepared', 'generated')
       AND (
         COALESCE(image_gateway_url, '') <> ''
         OR COALESCE(image_cid, '') <> ''
       )`
    : "";

  if (!databaseEnabled()) {
    return runtimeList({
      accountId: normalizedAccountId,
      walletAddress,
      hasWalletFilter,
      includeWalletless,
    })
      .filter((record) => !publicOnly || (publicHeroStatus(record.status) && hasPublicHeroImage(record) && !isFixtureProfileNft(record)))
      .slice(0, boundedLimit);
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
            ${publicFilter}
            AND ${nonFixtureProfileNftSql("profile_nfts")}
          ORDER BY created_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
          LIMIT $2`,
        [normalizedAccountId, boundedLimit, walletAddress, includeWalletless === true]
      )
    : await query(
        `SELECT *
           FROM profile_nfts
          WHERE account_id = $1
            ${publicFilter}
            AND ${nonFixtureProfileNftSql("profile_nfts")}
          ORDER BY created_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
          LIMIT $2`,
        [normalizedAccountId, boundedLimit]
      );
  return result.rows.map(normalizeRecord);
}

export async function countProfileNfts(options = {}) {
  options = options && typeof options === "object" ? options : {};
  const { accountId = "", includeWalletless = true, publicOnly = false } = options;
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return 0;
  const hasWalletFilter = Object.hasOwn(options, "walletAddress");
  const walletAddress = safeText(options.walletAddress, 120);

  if (!databaseEnabled()) {
    return runtimeList({
      accountId: normalizedAccountId,
      walletAddress,
      hasWalletFilter,
      includeWalletless,
    }).filter((record) => !publicOnly || (publicHeroStatus(record.status) && hasPublicHeroImage(record) && !isFixtureProfileNft(record))).length;
  }

  const publicFilter = publicOnly === true
    ? `AND lower(status) IN ('minted', 'prepared', 'generated')
       AND (
         COALESCE(image_gateway_url, '') <> ''
         OR COALESCE(image_cid, '') <> ''
       )`
    : "";
  const result = hasWalletFilter
    ? await query(
        `SELECT COUNT(*)::integer AS total
           FROM profile_nfts
          WHERE account_id = $1
            AND (
              wallet_address = $2
              OR ($3::boolean = true AND wallet_address = '')
            )
            ${publicFilter}
            AND ${nonFixtureProfileNftSql("profile_nfts")}`,
        [normalizedAccountId, walletAddress, includeWalletless === true]
      )
    : await query(
        `SELECT COUNT(*)::integer AS total
           FROM profile_nfts
          WHERE account_id = $1
            ${publicFilter}
            AND ${nonFixtureProfileNftSql("profile_nfts")}`,
        [normalizedAccountId]
      );
  return Number(result.rows[0]?.total || 0);
}

export async function getPublicProfileHeroNft({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return null;

  if (!databaseEnabled()) {
    const hero = runtimeList({ accountId: normalizedAccountId })
      .filter((record) => publicHeroStatus(record.status) && hasPublicHeroImage(record) && !isFixtureProfileNft(record))
      .sort(comparePublicHeroNfts())[0];
    return hero || null;
  }

  const result = await query(
    `SELECT nft.*
      FROM profile_nfts nft
      WHERE nft.account_id = $1
        AND lower(nft.status) IN ('minted', 'prepared', 'generated')
        AND ${nonFixtureProfileNftSql("nft")}
        AND (
          COALESCE(nft.image_gateway_url, '') <> ''
          OR COALESCE(nft.image_cid, '') <> ''
        )
      ORDER BY
        nft.selected DESC,
        nft.created_at DESC NULLS LAST,
        nft.updated_at DESC NULLS LAST,
        nft.id DESC
      LIMIT 1`,
    [normalizedAccountId]
  );
  return result.rows[0] ? normalizeRecord(result.rows[0]) : null;
}

export async function setSelectedProfileNft({ accountId = "", nftId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedNftId = safeText(nftId, 120);
  if (!normalizedAccountId || !normalizedNftId) return null;

  if (!databaseEnabled()) {
    const record = runtimeNfts.get(normalizedNftId);
    if (!record || record.accountId !== normalizedAccountId) return null;
    const updatedAt = nowIso();
    for (const [id, nft] of runtimeNfts.entries()) {
      if (nft.accountId !== normalizedAccountId) continue;
      runtimeNfts.set(id, normalizeRecord({
        ...nft,
        selected: id === normalizedNftId,
        updatedAt,
      }));
    }
    return runtimeNfts.get(normalizedNftId) || null;
  }

  return transaction(async (client) => {
    const owned = await client.query(
      `SELECT *
         FROM profile_nfts
        WHERE account_id = $1
          AND id = $2
        FOR UPDATE`,
      [normalizedAccountId, normalizedNftId]
    );
    if (!owned.rows[0]) return null;

    await client.query(
      `UPDATE profile_nfts
          SET selected = false,
              updated_at = now()
        WHERE account_id = $1
          AND id <> $2
          AND selected = true`,
      [normalizedAccountId, normalizedNftId]
    );

    const selected = await client.query(
      `UPDATE profile_nfts
          SET selected = true,
              updated_at = now()
        WHERE account_id = $1
          AND id = $2
        RETURNING *`,
      [normalizedAccountId, normalizedNftId]
    );
    return selected.rows[0] ? normalizeRecord(selected.rows[0]) : null;
  });
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

const generationInterruptedError =
  "Generation was interrupted: the server restarted while this image was generating. Retry generation.";

function defaultGenerationStaleMinutes(env = process.env) {
  const configured = Number(env.TASKNODE_PROFILE_NFT_GENERATION_STALE_MINUTES || 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 10;
}

function minimumGenerationStaleMinutes(env = process.env) {
  // A legitimate generation request can stay in flight for the full OpenAI image
  // timeout plus IPFS pin time, so the sweep threshold is floored above that
  // worst case to guarantee a live request is never marked failed.
  const imageTimeoutMs = Math.max(30_000, Number(env.PROFILE_NFT_IMAGE_TIMEOUT_MS || 300_000));
  return Math.ceil(imageTimeoutMs / 60_000) + 2;
}

export async function failStaleGeneratingProfileNfts({ accountId = "", staleMinutes = 0, limit = 25 } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const requestedMinutes = Number(staleMinutes || 0) > 0 ? Number(staleMinutes) : defaultGenerationStaleMinutes();
  const effectiveMinutes = Math.max(requestedMinutes, minimumGenerationStaleMinutes());
  const boundedLimit = Math.min(Math.max(Number(limit || 25), 1), 100);

  if (!databaseEnabled()) {
    const cutoffMs = Date.now() - effectiveMinutes * 60_000;
    const swept = [];
    for (const record of runtimeNfts.values()) {
      if (swept.length >= boundedLimit) break;
      if (record.status !== "generating") continue;
      if (normalizedAccountId && record.accountId !== normalizedAccountId) continue;
      const updatedAtMs = Date.parse(record.updatedAt || "");
      if (!Number.isFinite(updatedAtMs) || updatedAtMs >= cutoffMs) continue;
      const next = normalizeRecord({
        ...record,
        status: "failed",
        error: generationInterruptedError,
        updatedAt: nowIso(),
      });
      runtimeNfts.set(record.id, next);
      swept.push(next);
    }
    return swept;
  }

  const result = await query(
    `UPDATE profile_nfts
        SET status = 'failed',
            error = $1,
            updated_at = now()
      WHERE id IN (
        SELECT id
          FROM profile_nfts
         WHERE status = 'generating'
           AND ($2::text = '' OR account_id = $2)
           AND updated_at < now() - ($3::text || ' minutes')::interval
         ORDER BY updated_at ASC
         LIMIT $4
      )
      RETURNING *`,
    [generationInterruptedError, normalizedAccountId, String(effectiveMinutes), boundedLimit]
  );
  return result.rows.map(normalizeRecord);
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
