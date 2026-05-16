#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HDNodeWallet, Mnemonic, randomBytes } from "ethers";

const defaultOutPath = ".env.eth-deposit-xpub";
const defaultReceivePath = "m/44'/60'/0'/0";
const defaultDepositStartIndex = 1;

function usage() {
  return [
    "Generate a fresh Ethereum HD wallet for Task Node deposits.",
    "",
    "Sensitive custody material is printed once to stdout and is not written to disk.",
    "Only the receive xpub/env config is written to the output file.",
    "",
    "Usage:",
    "  node scripts/generate-eth-deposit-wallet.mjs [--out .env.eth-deposit-xpub] [--force]",
    "",
    "Options:",
    "  --out <path>       File for xpub env lines. Default: .env.eth-deposit-xpub",
    "  --force            Overwrite the xpub output file if it exists",
    "  --help             Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    outPath: defaultOutPath,
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--out") {
      options.outPath = argv[index + 1] || "";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.outPath) {
    throw new Error("--out requires a file path.");
  }

  return options;
}

function writeXpubFile({ outPath, force, receivePath, xpub, firstAddress }) {
  const resolved = path.resolve(process.cwd(), outPath);
  if (existsSync(resolved) && !force) {
    throw new Error(`${resolved} already exists. Use --force to overwrite it.`);
  }

  mkdirSync(path.dirname(resolved), { recursive: true });
  const body = [
    "# Safe to paste into the Task Node app environment.",
    "# This file does not contain the mnemonic, xprv, or private keys.",
    `ETH_DEPOSIT_XPUB=${xpub}`,
    `ETH_DEPOSIT_RECEIVE_PATH=${receivePath}`,
    `ETH_DEPOSIT_START_INDEX=${defaultDepositStartIndex}`,
    "ETH_DEPOSIT_RPC_URL=https://ethereum.publicnode.com",
    "ETH_DEPOSIT_BALANCE_BLOCK_TAG=safe",
    `# ETH_DEPOSIT_FIRST_ADDRESS=${firstAddress}`,
    "",
  ].join("\n");

  writeFileSync(resolved, body, { mode: 0o600 });
  return resolved;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const mnemonic = Mnemonic.fromEntropy(randomBytes(32));
  const receiveNode = HDNodeWallet.fromMnemonic(mnemonic, defaultReceivePath);
  const operatorWallet = receiveNode.deriveChild(0);
  const firstDepositWallet = receiveNode.deriveChild(defaultDepositStartIndex);
  const xpub = receiveNode.neuter().extendedKey;
  const writtenPath = writeXpubFile({
    outPath: options.outPath,
    force: options.force,
    receivePath: defaultReceivePath,
    xpub,
    firstAddress: firstDepositWallet.address,
  });

  console.log("");
  console.log("NEW TASK NODE ETHEREUM DEPOSIT WALLET");
  console.log("");
  console.log("WRITE THESE DOWN NOW. They were NOT written to disk.");
  console.log("");
  console.log(`Mnemonic: ${mnemonic.phrase}`);
  console.log(`Receive xprv (${defaultReceivePath}): ${receiveNode.extendedKey}`);
  console.log("");
  console.log("The receive xprv can derive every operator and per-user deposit private key.");
  console.log("Index 0 is reserved for operator funding. App user deposit addresses start at index 1.");
  console.log("");
  console.log(`Reserved operator index 0 address: ${operatorWallet.address}`);
  console.log(`Reserved operator index 0 private key: ${operatorWallet.privateKey}`);
  console.log(`First user deposit index ${defaultDepositStartIndex} address: ${firstDepositWallet.address}`);
  console.log(`First user deposit index ${defaultDepositStartIndex} private key: ${firstDepositWallet.privateKey}`);
  console.log("");
  console.log("SAFE APP CONFIG WRITTEN");
  console.log("");
  console.log(`File: ${writtenPath}`);
  console.log(`ETH_DEPOSIT_XPUB=${xpub}`);
  console.log("");
}

try {
  main();
} catch (error) {
  console.error(error?.message || "Ethereum deposit wallet generation failed.");
  process.exitCode = 1;
}
