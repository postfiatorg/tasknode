#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { HDNodeWallet, Mnemonic, Wallet, getAddress } from "ethers";

const defaultConfigPath = ".env.eth-deposit-xpub";
const defaultReceivePath = "m/44'/60'/0'/0";
const defaultIndex = 1;

function usage() {
  return [
    "Verify custody material against the Task Node Ethereum deposit xpub.",
    "",
    "The secret is read from stdin or hidden interactive input. Do not pass",
    "mnemonics, xprvs, or private keys as command arguments.",
    "",
    "Accepted secret inputs:",
    "  - mnemonic phrase",
    "  - receive xprv for m/44'/60'/0'/0",
    "  - child private key for a specific deposit index",
    "",
    "Usage:",
    "  npm run eth-deposit-verify",
    "  npm run eth-deposit-verify -- --index 0",
    "  node scripts/verify-eth-deposit-wallet.mjs --config .env.eth-deposit-xpub --index 0",
    "",
    "Options:",
    "  --config <path>    Xpub env file. Default: .env.eth-deposit-xpub",
    "  --index <number>   Deposit child index to verify. Default: 1",
    "  --help             Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    configPath: defaultConfigPath,
    index: defaultIndex,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--config") {
      options.configPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--index") {
      options.index = Number(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.configPath) throw new Error("--config requires a file path.");
  if (!Number.isSafeInteger(options.index) || options.index < 0) {
    throw new Error("--index must be a non-negative integer.");
  }

  return options;
}

function parseEnvFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) {
    throw new Error(`${resolved} does not exist. Generate or copy the xpub config first.`);
  }

  const values = {};
  const text = readFileSync(resolved, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*#?\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }

  if (!values.ETH_DEPOSIT_XPUB) {
    throw new Error(`${resolved} does not contain ETH_DEPOSIT_XPUB.`);
  }

  return {
    path: resolved,
    xpub: values.ETH_DEPOSIT_XPUB,
    receivePath: values.ETH_DEPOSIT_RECEIVE_PATH || defaultReceivePath,
    startIndex: Number(values.ETH_DEPOSIT_START_INDEX || defaultIndex),
    firstAddress: values.ETH_DEPOSIT_FIRST_ADDRESS || "",
  };
}

async function readSecret() {
  if (!process.stdin.isTTY) {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    return input.trim();
  }

  process.stdout.write("Paste mnemonic, receive xprv, or child private key. Input is hidden.\n> ");

  return new Promise((resolve, reject) => {
    let input = "";

    function cleanup() {
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    }

    function onData(chunk) {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Verification cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(input.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          input = input.slice(0, -1);
          continue;
        }
        input += char;
      }
    }

    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
  });
}

function xpubChildAddress(xpub, index) {
  return getAddress(HDNodeWallet.fromExtendedKey(xpub).deriveChild(index).address);
}

function detectAndVerify({ secret, config, index }) {
  const expectedChildAddress = xpubChildAddress(config.xpub, index);

  if (/^0x[0-9a-fA-F]{64}$/.test(secret)) {
    const wallet = new Wallet(secret);
    const address = getAddress(wallet.address);
    return {
      kind: "child_private_key",
      match: address === expectedChildAddress,
      address,
      expectedChildAddress,
      xpubMatches: null,
    };
  }

  if (/^[xtuv]prv/i.test(secret)) {
    const receiveNode = HDNodeWallet.fromExtendedKey(secret);
    const derivedXpub = receiveNode.neuter().extendedKey;
    const address = getAddress(receiveNode.deriveChild(index).address);
    return {
      kind: "receive_xprv",
      match: derivedXpub === config.xpub && address === expectedChildAddress,
      address,
      expectedChildAddress,
      xpubMatches: derivedXpub === config.xpub,
    };
  }

  const words = secret.trim().split(/\s+/);
  if (words.length >= 12) {
    const mnemonic = Mnemonic.fromPhrase(secret.trim().toLowerCase().replace(/\s+/g, " "));
    const receiveNode = HDNodeWallet.fromMnemonic(mnemonic, config.receivePath);
    const derivedXpub = receiveNode.neuter().extendedKey;
    const address = getAddress(receiveNode.deriveChild(index).address);
    return {
      kind: "mnemonic",
      match: derivedXpub === config.xpub && address === expectedChildAddress,
      address,
      expectedChildAddress,
      xpubMatches: derivedXpub === config.xpub,
    };
  }

  throw new Error("Input was not a mnemonic, receive xprv, or 0x-prefixed private key.");
}

function printResult({ result, config, index }) {
  console.log("");
  console.log(`Config: ${config.path}`);
  console.log(`Input type: ${result.kind}`);
  console.log(`Deposit index: ${index}`);
  console.log(`Expected address: ${result.expectedChildAddress}`);
  console.log(`Derived address:  ${result.address}`);
  if (result.xpubMatches !== null) {
    console.log(`Xpub match: ${result.xpubMatches ? "yes" : "no"}`);
  }
  console.log("");

  if (result.match) {
    console.log("MATCH: this custody material controls the configured deposit wallet/address.");
    return;
  }

  console.log("NO MATCH: this custody material does not match the configured deposit wallet/address.");
  process.exitCode = 2;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  const config = parseEnvFile(options.configPath);
  const secret = await readSecret();
  if (!secret) throw new Error("No secret input received.");
  const result = detectAndVerify({ secret, config, index: options.index });
  printResult({ result, config, index: options.index });
} catch (error) {
  console.error(error?.message || "Ethereum deposit wallet verification failed.");
  process.exitCode = process.exitCode || 1;
}
