import { createHash } from "node:crypto";
import { closePool, query } from "../server/db/pool.js";
import { fetchWalletNftInventory } from "../server/pftl-nfts.js";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1] || fallback;
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  console.log([
    "Usage:",
    "  npm run wallet-nft-inventory -- --wallet <classic_address> --pretty",
    "  npm run wallet-nft-inventory -- --wallet <classic_address> --no-metadata",
    "  npm run wallet-nft-inventory -- --wallet <classic_address> --timeout-ms 3000 --metadata-concurrency 6",
    "  npm run wallet-nft-inventory -- --wallet <classic_address> --account-id <account_id> --import-profile-cache --dry-run",
    "  npm run wallet-nft-inventory -- --wallet <classic_address> --account-id <account_id> --import-profile-cache --execute",
    "",
    "Reads PFTL account_nfts, decodes each URI, fetches IPFS metadata, extracts image CIDs, and optionally caches renderable rows in profile_nfts.",
  ].join("\n"));
}

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function sha256Short(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 24);
}

function titleForNft(nft = {}) {
  return safeText(nft.title, 120) || "PFTL Wallet NFT";
}

function descriptionForNft(nft = {}) {
  return safeText(nft.description, 800) || "NFT discovered from PFTL account_nfts and public IPFS metadata.";
}

function cacheIdForNft({ walletAddress = "", nft = {} } = {}) {
  const key = nft.nftTokenId || nft.metadataCid || nft.metadataUri || nft.uriHex;
  return `nft_chain_${sha256Short(`${walletAddress}:${key}`)}`;
}

async function existingProfileNftId({ accountId = "", walletAddress = "", nft = {} } = {}) {
  const result = await query(
    `SELECT id
       FROM profile_nfts
      WHERE account_id = $1
        AND wallet_address = $2
        AND (
          ($3::text <> '' AND nft_token_id = $3)
          OR ($4::text <> '' AND metadata_cid = $4)
        )
      ORDER BY minted_at DESC NULLS LAST, updated_at DESC NULLS LAST, id ASC
      LIMIT 1`,
    [
      safeText(accountId, 180),
      safeText(walletAddress, 120),
      safeText(nft.nftTokenId, 256),
      safeText(nft.metadataCid, 160),
    ]
  );
  return result.rows[0]?.id || "";
}

async function upsertProfileNftCache({ accountId = "", walletAddress = "", nft = {} } = {}) {
  if (!nft.metadataCid || !nft.imageCid) {
    return { ok: false, skipped: true, reason: "missing_metadata_or_image_cid", tokenId: nft.nftTokenId || "" };
  }
  const id = await existingProfileNftId({ accountId, walletAddress, nft }) || cacheIdForNft({ walletAddress, nft });
  const result = await query(
    `INSERT INTO profile_nfts (
       id, account_id, wallet_address, title, description, status,
       image_cid, image_gateway_url, metadata_cid, metadata_uri, metadata_json,
       prompt_source, nft_token_id, generated_at, minted_at, created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, 'minted',
       $6, $7, $8, $9, $10::jsonb,
       'pftl_chain_inventory', $11, NULL, NULL, now(), now()
     )
     ON CONFLICT (id) DO UPDATE SET
       account_id = EXCLUDED.account_id,
       wallet_address = EXCLUDED.wallet_address,
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       status = 'minted',
       image_cid = EXCLUDED.image_cid,
       image_gateway_url = EXCLUDED.image_gateway_url,
       metadata_cid = EXCLUDED.metadata_cid,
       metadata_uri = EXCLUDED.metadata_uri,
       metadata_json = EXCLUDED.metadata_json,
       prompt_source = EXCLUDED.prompt_source,
       nft_token_id = CASE
         WHEN EXCLUDED.nft_token_id <> '' THEN EXCLUDED.nft_token_id
         ELSE profile_nfts.nft_token_id
       END,
       minted_at = profile_nfts.minted_at,
       updated_at = now()
     RETURNING id`,
    [
      id,
      safeText(accountId, 180),
      safeText(walletAddress, 120),
      titleForNft(nft),
      descriptionForNft(nft),
      safeText(nft.imageCid, 160),
      safeText(nft.imageGatewayUrl, 500),
      safeText(nft.metadataCid, 160),
      safeText(nft.metadataUri, 240),
      JSON.stringify(nft.metadata || {}),
      safeText(nft.nftTokenId, 256),
    ]
  );
  return { ok: true, id: result.rows[0]?.id || id, tokenId: nft.nftTokenId || "", metadataCid: nft.metadataCid };
}

function compactNft(nft = {}) {
  return {
    nftTokenId: nft.nftTokenId,
    title: nft.title,
    description: nft.description,
    metadataUri: nft.metadataUri,
    metadataCid: nft.metadataCid,
    metadataGatewayUrl: nft.metadataGatewayUrl,
    imageUri: nft.imageUri,
    imageCid: nft.imageCid,
    imageGatewayUrl: nft.imageGatewayUrl,
    metadataFetch: nft.metadataFetch,
    taxon: nft.taxon,
    flags: nft.flags,
    issuer: nft.issuer,
  };
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    usage();
    return;
  }

  const walletAddress = safeText(argValue("wallet"), 120);
  const accountId = safeText(argValue("account-id"), 180);
  const importProfileCache = hasFlag("import-profile-cache");
  const execute = hasFlag("execute");
  const dryRun = hasFlag("dry-run") || !execute;
  const fetchMetadata = !hasFlag("no-metadata");
  const pretty = hasFlag("pretty");
  const limit = Number(argValue("limit", "400")) || 400;
  const maxPages = Number(argValue("max-pages", "8")) || 8;
  const timeoutMs = Number(argValue("timeout-ms", ""));
  const metadataConcurrency = Number(argValue("metadata-concurrency", "4")) || 4;

  if (!walletAddress) {
    usage();
    throw new Error("wallet_required");
  }
  if (importProfileCache && !accountId) {
    usage();
    throw new Error("account_id_required_for_profile_cache_import");
  }

  const inventory = await fetchWalletNftInventory({
    walletAddress,
    fetchMetadata,
    limit,
    maxPages,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null,
    metadataConcurrency,
  });

  if (!inventory.ok) {
    console.log(JSON.stringify(inventory, null, pretty ? 2 : 0));
    process.exitCode = inventory.status && inventory.status < 500 ? 1 : 2;
    return;
  }

  let importResult = null;
  if (importProfileCache) {
    const importable = inventory.nfts.filter((nft) => nft.metadataCid && nft.imageCid);
    if (dryRun) {
      importResult = {
        mode: "dry_run",
        importableCount: importable.length,
        skippedCount: inventory.nfts.length - importable.length,
        firstFive: importable.slice(0, 5).map((nft) => ({
          id: cacheIdForNft({ walletAddress, nft }),
          title: titleForNft(nft),
          nftTokenId: nft.nftTokenId,
          metadataCid: nft.metadataCid,
          imageCid: nft.imageCid,
        })),
      };
    } else {
      const rows = [];
      for (const nft of inventory.nfts) {
        rows.push(await upsertProfileNftCache({ accountId, walletAddress, nft }));
      }
      importResult = {
        mode: "execute",
        importedCount: rows.filter((row) => row.ok).length,
        skippedCount: rows.filter((row) => row.skipped).length,
        rows,
      };
      await closePool();
    }
  }

  const output = {
    ...inventory,
    nfts: inventory.nfts.map(compactNft),
    import: importResult,
  };
  console.log(JSON.stringify(output, null, pretty ? 2 : 0));
}

main().catch(async (error) => {
  await closePool().catch(() => null);
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
