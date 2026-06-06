import { readFileSync } from "node:fs";
import { closePool, query } from "../server/db/pool.js";

const defaultGatewayBase = "https://dweb.link/ipfs/";

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
    "  node scripts/import-pftasks-profile-nfts.mjs --account-id <account_id> --wallet <classic_address> --source-json <path> --dry-run",
    "  node scripts/import-pftasks-profile-nfts.mjs --account-id <account_id> --wallet <classic_address> --source-json <path> --execute",
    "  old_pftasks_json | node scripts/import-pftasks-profile-nfts.mjs --account-id <account_id> --wallet <classic_address> --stdin --execute",
    "",
    "Imports old PFTasks nft_mints rows into Task Node Official profile_nfts as cache records.",
    "Rows are idempotent by old PFTasks mint id. Only minted rows for the requested wallet are imported.",
  ].join("\n"));
}

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function normalizeCid(value = "") {
  return safeText(value, 240)
    .replace(/^ipfs:\/\//i, "")
    .replace(/^\/ipfs\//i, "")
    .split(/[?#]/)[0];
}

function gatewayUrlForCid(cid = "", gatewayBase = defaultGatewayBase) {
  const normalized = normalizeCid(cid);
  const base = safeText(gatewayBase, 500) || defaultGatewayBase;
  return normalized ? `${base.replace(/\/+$/, "")}/${encodeURIComponent(normalized)}` : "";
}

function stableImportId(oldMintId = "") {
  return `nft_pftasks_${safeText(oldMintId, 120).replace(/[^a-zA-Z0-9_-]+/g, "_")}`.slice(0, 160);
}

export function normalizePftasksNftRow(row = {}, { accountId = "", walletAddress = "", gatewayBase = defaultGatewayBase } = {}) {
  const oldMintId = safeText(row.id, 120);
  const ownerWallet = safeText(row.owner_wallet_address || row.ownerWalletAddress || row.wallet_address || row.walletAddress, 120);
  const requestedWallet = safeText(walletAddress, 120);
  const status = safeText(row.status, 40).toLowerCase();
  const imageCid = normalizeCid(row.image_cid || row.imageCid);
  const metadataCid = normalizeCid(row.metadata_cid || row.metadataCid);
  if (!oldMintId || !safeText(accountId, 180) || !requestedWallet) return null;
  if (ownerWallet !== requestedWallet) return null;
  if (status !== "minted") return null;
  if (!imageCid || !metadataCid) return null;

  const title =
    safeText(row.display_name || row.displayName, 120) ||
    safeText(row.nft_name || row.nftName, 120) ||
    "Imported PFTasks Profile NFT";
  const description =
    safeText(row.nft_description || row.nftDescription, 800) ||
    "Imported profile NFT minted in the old PFTasks app.";
  const thumbnailCid = normalizeCid(row.thumbnail_cid || row.thumbnailCid);
  const metadataJson = {
    schema: "erc721",
    name: title,
    description,
    image: `ipfs://${imageCid}`,
    source: "pftasks_import",
    legacyMintId: oldMintId,
    thumbnailCid,
  };

  return {
    id: stableImportId(oldMintId),
    accountId: safeText(accountId, 180),
    walletAddress: requestedWallet,
    title,
    description,
    status: "minted",
    imageCid,
    imageGatewayUrl: gatewayUrlForCid(imageCid, gatewayBase),
    metadataCid,
    metadataUri: `ipfs://${metadataCid}`,
    metadataJson,
    promptSource: "pftasks_import",
    txHash: safeText(row.tx_hash || row.txHash, 128),
    nftTokenId: safeText(row.nft_token_id || row.nftTokenId, 256),
    selected: row.is_pinned === true || row.isPinned === true,
    generatedAt: safeText(row.created_at || row.createdAt, 80) || null,
    mintedAt: safeText(row.minted_at || row.mintedAt, 80) || null,
    source: {
      oldMintId,
      thumbnailCid,
      oldUserId: safeText(row.user_id || row.userId, 120),
    },
  };
}

async function upsertImportedProfileNft(nft) {
  const result = await query(
    `INSERT INTO profile_nfts (
       id, account_id, wallet_address, title, description, status,
       image_cid, image_gateway_url, metadata_cid, metadata_uri, metadata_json,
       prompt_source, tx_hash, nft_token_id, selected,
       generated_at, minted_at, created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, 'minted',
       $6, $7, $8, $9, $10::jsonb,
       $11, $12, $13, $14,
       $15::timestamptz, $16::timestamptz, COALESCE($15::timestamptz, $16::timestamptz, now()), COALESCE($16::timestamptz, $15::timestamptz, now())
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
       tx_hash = EXCLUDED.tx_hash,
       nft_token_id = EXCLUDED.nft_token_id,
       selected = EXCLUDED.selected,
       generated_at = COALESCE(profile_nfts.generated_at, EXCLUDED.generated_at),
       minted_at = EXCLUDED.minted_at,
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      nft.id,
      nft.accountId,
      nft.walletAddress,
      nft.title,
      nft.description,
      nft.imageCid,
      nft.imageGatewayUrl,
      nft.metadataCid,
      nft.metadataUri,
      JSON.stringify(nft.metadataJson || {}),
      nft.promptSource,
      nft.txHash,
      nft.nftTokenId,
      nft.selected === true,
      nft.generatedAt,
      nft.mintedAt,
    ]
  );
  return result.rows[0]?.id || "";
}

function parseJsonInput(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [];
}

function readSourceRows() {
  if (hasFlag("stdin")) {
    return parseJsonInput(readFileSync(0, "utf8"));
  }
  const sourceJson = argValue("source-json");
  if (!sourceJson) return [];
  return parseJsonInput(readFileSync(sourceJson, "utf8"));
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    usage();
    return;
  }

  const accountId = safeText(argValue("account-id"), 180);
  const walletAddress = safeText(argValue("wallet"), 120);
  const execute = hasFlag("execute");
  const dryRun = hasFlag("dry-run") || !execute;
  const gatewayBase = safeText(argValue("gateway-base", defaultGatewayBase), 500) || defaultGatewayBase;
  if (!accountId || !walletAddress) {
    usage();
    throw new Error("account_id_and_wallet_required");
  }

  const rows = readSourceRows();
  const imports = rows
    .map((row) => normalizePftasksNftRow(row, { accountId, walletAddress, gatewayBase }))
    .filter(Boolean);
  const skipped = rows.length - imports.length;

  if (!execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: dryRun ? "dry_run" : "preview",
      sourceRows: rows.length,
      importableRows: imports.length,
      skippedRows: skipped,
      firstFive: imports.slice(0, 5).map((nft) => ({
        id: nft.id,
        walletAddress: nft.walletAddress,
        title: nft.title,
        imageCid: nft.imageCid,
        metadataCid: nft.metadataCid,
        txHash: nft.txHash,
        nftTokenId: nft.nftTokenId,
        mintedAt: nft.mintedAt,
      })),
    }, null, 2));
    return;
  }

  const importedIds = [];
  for (const nft of imports) {
    importedIds.push(await upsertImportedProfileNft(nft));
  }
  await closePool();
  console.log(JSON.stringify({
    ok: true,
    mode: "execute",
    sourceRows: rows.length,
    importableRows: imports.length,
    skippedRows: skipped,
    importedCount: importedIds.filter(Boolean).length,
    importedIds: importedIds.filter(Boolean),
  }, null, 2));
}

main().catch(async (error) => {
  await closePool().catch(() => null);
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
