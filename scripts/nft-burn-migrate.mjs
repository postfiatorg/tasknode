#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { generateMlDsa65Keypair } from "../server/l1/message-protocol.js";
import { DEFAULT_L1_CHAIN_ID, DEFAULT_OFFICIAL_COLLECTION_ID } from "../server/l1/nft-inventory.js";
import { FileMigrationLedgerStore, createBurnFirstNftMigrator } from "../server/l1/nft-burn-migrator.js";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  console.log([
    "Usage:",
    "  node scripts/nft-burn-migrate.mjs --allowlist <allowlist.json> --ledger <ledger.json>",
    "    [--new-owner <pfAddr>] [--target-chain-id postfiat-wan-devnet-2]",
    "    [--collection-id TASKNODE-PROFILE-V1] [--mode burn_first|pin_only]",
    "    [--dry-run | --execute] [--pretty]",
    "",
    "Pillar 4 Burn-First Idempotent Batch NFT Migrator.",
    "Defaults to --dry-run. In --execute mode, signs & pins pf.nft.claim.v1 BEFORE burning,",
    "verifies the validated old-chain burn (burn_tx.account == old_owner & claim_hash memo),",
    "guards against duplicates via persistent used_nft_serials tombstones, and mints on postfiatl1v2",
    "with official Task Node policy (ISSUER_BURNABLE=false, TRANSFERABLE=true, fee=0).",
  ].join("\n"));
}

function keypairFromSeedHexOrEnv(envVarName, fallbackLabel) {
  const raw = String(process.env[envVarName] || "").trim();
  if (!raw) {
    if (fallbackLabel) {
      return generateMlDsa65Keypair(createHash("sha256").update(fallbackLabel, "utf8").digest());
    }
    throw new Error(`missing_required_env:${envVarName}`);
  }
  const seed = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : createHash("sha256").update(raw, "utf8").digest();
  return generateMlDsa65Keypair(seed);
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    usage();
    return;
  }

  const allowlistPath = argValue("allowlist", "");
  const ledgerPath = argValue("ledger", "");
  const mode = argValue("mode", "burn_first");
  const execute = hasFlag("execute");
  const dryRun = hasFlag("dry-run") || !execute;
  const pretty = hasFlag("pretty");

  if (!allowlistPath) {
    usage();
    throw new Error("allowlist_file_required");
  }
  if (!["burn_first", "pin_only"].includes(mode)) {
    throw new Error(`unsupported_migration_mode:${mode}`);
  }

  const loaded = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const allowlist = loaded.allowlist || loaded;
  const allowlistCid = loaded.allowlistCid || null;
  const targetChainId = argValue("target-chain-id", allowlist.targetChainId || DEFAULT_L1_CHAIN_ID);
  const targetCollectionId = argValue("collection-id", allowlist.targetCollectionId || DEFAULT_OFFICIAL_COLLECTION_ID);

  if (!dryRun) {
    throw new Error(
      "live_chain_execute_requires_injected_rpc_and_wallet_signers: pass --dry-run to preview or invoke createBurnFirstNftMigrator() with live old-chain burn + postfiatl1v2 mint transports"
    );
  }

  const ledgerStore = new FileMigrationLedgerStore(ledgerPath);
  const migrationIssuerSigner = keypairFromSeedHexOrEnv("TASKNODE_NFT_MIGRATION_ISSUER_SEED", "dry-run-migration-issuer");
  const claimantSigner = keypairFromSeedHexOrEnv("TASKNODE_NFT_CLAIMANT_SEED", "dry-run-claimant");
  const newOwnerAccount = argValue("new-owner", claimantSigner.account);

  const migrator = createBurnFirstNftMigrator({
    allowlist,
    allowlistCid,
    ledgerStore,
    targetChainId,
    targetCollectionId,
    migrationIssuerSigner,
    claimantSigner,
    newOwnerAccount: newOwnerAccount === claimantSigner.account ? newOwnerAccount : claimantSigner.account,
  });

  const report = await migrator.migrateBatch(null, { mode, dryRun: true });
  console.log(JSON.stringify(report, null, pretty ? 2 : 0));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
