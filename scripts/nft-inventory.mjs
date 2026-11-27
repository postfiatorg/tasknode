#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import {
  DEFAULT_L1_CHAIN_ID,
  DEFAULT_OFFICIAL_COLLECTION_ID,
  LEGACY_SOURCE_CHAIN,
  freezeEligibilityAllowlist,
  scanFounderNftInventory,
} from "../server/l1/nft-inventory.js";

function argValues(name) {
  const values = [];
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg.startsWith(prefix)) {
      values.push(...arg.slice(prefix.length).split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg === `--${name}` && process.argv[i + 1]) {
      values.push(...process.argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
      i += 1;
    }
  }
  return values;
}

function argValue(name, fallback = "") {
  const values = argValues(name);
  return values.length ? values[values.length - 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  console.log([
    "Usage:",
    "  node scripts/nft-inventory.mjs --wallet <rAddr> [--wallet <rAddr2>] [--cutoff-ledger <n>]",
    "    [--target-chain-id postfiat-wan-devnet-2] [--collection-id TASKNODE-PROFILE-V1]",
    "    [--migration-issuer <pfAddr>] [--profile-nfts-json <path>] [--pftasks-json <path>]",
    "    [--founder-approved-json <path>] [--include-db] [--no-metadata] [--allow-unmatched]",
    "    [--out <report.json>] [--freeze-allowlist <allowlist.json>] [--pretty]",
    "",
    "Read-only Pillar 4 Founder NFT Inventory scanner.",
    "Scans old Post Fiat chain wallets, joins Task Node & PFTasks records, applies pre-cutoff eligibility,",
    "and optionally freezes an allowlist artifact before any burn-first migration runs.",
  ].join("\n"));
}

function readJsonList(filePath = "") {
  if (!filePath) return [];
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.nfts)) return parsed.nfts;
  if (Array.isArray(parsed?.records)) return parsed.records;
  if (Array.isArray(parsed?.tokenIds)) return parsed.tokenIds;
  return [];
}

async function loadProfileNftsFromDb(wallets = []) {
  if (!databaseEnabled() || !wallets.length) return [];
  const res = await query(
    `SELECT id, account_id, wallet_address, title, description, image_cid, metadata_cid,
            metadata_uri, tx_hash, nft_token_id, minted_at
       FROM profile_nfts
      WHERE wallet_address = ANY($1::text[])
      ORDER BY created_at DESC`,
    [wallets]
  );
  return res.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    walletAddress: row.wallet_address,
    title: row.title,
    description: row.description,
    imageCid: row.image_cid,
    metadataCid: row.metadata_cid,
    metadataUri: row.metadata_uri,
    txHash: row.tx_hash,
    nftTokenId: row.nft_token_id,
    mintedAt: row.minted_at,
  }));
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    usage();
    return;
  }

  const wallets = argValues("wallet");
  if (!wallets.length) {
    usage();
    throw new Error("nft_inventory_wallet_required");
  }

  const cutoffLedgerIndex = Number(argValue("cutoff-ledger", "0")) || 0;
  const targetChainId = argValue("target-chain-id", DEFAULT_L1_CHAIN_ID);
  const targetCollectionId = argValue("collection-id", DEFAULT_OFFICIAL_COLLECTION_ID);
  const migrationIssuerAccount = argValue("migration-issuer", process.env.TASKNODE_NFT_MIGRATION_ISSUER || "");
  const sourceChain = argValue("source-chain", LEGACY_SOURCE_CHAIN);
  const fetchMetadata = !hasFlag("no-metadata");
  const requireSourceRecord = !hasFlag("allow-unmatched");
  const pretty = hasFlag("pretty");
  const outPath = argValue("out", "");
  const freezePath = argValue("freeze-allowlist", "");

  let tasknodeRecords = readJsonList(argValue("profile-nfts-json", ""));
  if (hasFlag("include-db")) {
    const dbRows = await loadProfileNftsFromDb(wallets);
    tasknodeRecords = [...tasknodeRecords, ...dbRows];
  }
  const pftasksRecords = readJsonList(argValue("pftasks-json", ""));
  const founderApprovedTokenIds = readJsonList(argValue("founder-approved-json", ""));

  const report = await scanFounderNftInventory({
    wallets,
    sourceChain,
    targetChainId,
    targetCollectionId,
    migrationIssuerAccount,
    cutoffLedgerIndex,
    tasknodeRecords,
    pftasksRecords,
    founderApprovedTokenIds,
    requireSourceRecord,
    fetchMetadata,
  });

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  let frozen = null;
  if (freezePath) {
    frozen = freezeEligibilityAllowlist({ inventoryReport: report });
    writeFileSync(freezePath, `${JSON.stringify(frozen, null, 2)}\n`, "utf8");
  }

  const output = frozen ? { ...report, frozenAllowlistCid: frozen.allowlistCid } : report;
  console.log(JSON.stringify(output, null, pretty ? 2 : 0));
}

main()
  .catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => null);
  });
