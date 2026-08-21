import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPftBalance } from "../server/pftl-balance.js";
import { sendPftInitiationGift } from "../server/pftl-faucet.js";
import { getTasknodeEncryptionPubkey } from "../server/context-publish.js";
import { pinContextIpfsJson } from "../server/context-ipfs.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "../server/pftl-pointer.js";
import {
  preparePftPointerTransaction,
  submitSignedPftTransaction,
} from "../server/pftl-submit.js";
import {
  deriveTaskNodePublicKey,
  deriveWalletSummary,
  encryptTaskNodePayload,
  normalizeMnemonic,
  signPreparedPftlTransaction,
} from "../src/wallet-core.js";
import { sanitizeContextHtml } from "../shared/context-html.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    seedFile: process.env.TASKNODE_CONTEXT_PUBLISH_SEED_FILE || "",
    envFile: process.env.TASKNODE_CONTEXT_PUBLISH_ENV_FILE || ".env.tasknodeofficial-dev",
    fundIfNeeded: false,
    title: "Task Node Context Live Publish Smoke",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--seed-file") args.seedFile = argv[++index] || "";
    else if (entry === "--env-file") args.envFile = argv[++index] || "";
    else if (entry === "--fund-if-needed") args.fundIfNeeded = true;
    else if (entry === "--title") args.title = argv[++index] || args.title;
  }
  return args;
}

function loadEnvFile(relativeOrAbsolutePath) {
  if (!relativeOrAbsolutePath) return;
  const envPath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(repoRoot, relativeOrAbsolutePath);
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function resolveSeedFile(seedFile) {
  const configured = seedFile || path.resolve(repoRoot, "..", "ga_seed2.txt");
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function readMnemonic(seedFile) {
  const text = fs.readFileSync(seedFile, "utf8");
  return normalizeMnemonic(text);
}

function configureLocalPftDefaults() {
  if (process.env.TASKNODE_CONTEXT_PUBLISH_WSS_URL) {
    process.env.PFTL_WSS_URL = process.env.TASKNODE_CONTEXT_PUBLISH_WSS_URL;
  } else if (!process.env.PFTL_WSS_URL || process.env.PFTL_WSS_URL.includes("178.156.143.199")) {
    process.env.PFTL_WSS_URL = "wss://127.0.0.1:6005";
  }
  if (!process.env.PFTL_WSS_REJECT_UNAUTHORIZED) process.env.PFTL_WSS_REJECT_UNAUTHORIZED = "false";
  if (!process.env.TASKNODE_ALLOW_INSECURE_LOCAL_PFTL_TLS) {
    process.env.TASKNODE_ALLOW_INSECURE_LOCAL_PFTL_TLS = "true";
  }
  if (!process.env.PFTL_SUBMIT_TIMEOUT_MS) process.env.PFTL_SUBMIT_TIMEOUT_MS = "10000";
  if (!process.env.PFT_BALANCE_TIMEOUT_MS) process.env.PFT_BALANCE_TIMEOUT_MS = "10000";
}

function buildContextPayload({ title, address }) {
  const now = new Date().toISOString();
  return {
    schema: "tasknode.context.v1",
    title,
    body: sanitizeContextHtml(`
      <h1>${title}</h1>
      <p>Live smoke publish generated at ${now} for ${address}.</p>
      <p>This verifies the Task Node context publish path writes an encrypted IPFS payload and a pf.ptr/v4 CONTEXT pointer to PFTL.</p>
    `),
    body_format: "html",
    revision: 1,
    published_at: now,
  };
}

async function fundIfNeeded({ address, enabled }) {
  const before = await fetchPftBalance(address, { force: true });
  if (before.ok && before.accountExists && BigInt(before.balanceDrops || "0") > 11_000_000n) {
    return { before, funded: null };
  }
  if (!enabled) return { before, funded: null };

  const funded = await sendPftInitiationGift({
    destination: address,
    memo: "Task Node context publish live smoke funding",
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return {
    before,
    funded,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.envFile);
  configureLocalPftDefaults();

  const seedFile = resolveSeedFile(args.seedFile);
  const mnemonic = readMnemonic(seedFile);
  const wallet = deriveWalletSummary(mnemonic);
  const funding = await fundIfNeeded({ address: wallet.address, enabled: args.fundIfNeeded });
  const tasknodeEncryptionPubkey = await getTasknodeEncryptionPubkey();
  if (!tasknodeEncryptionPubkey) {
    throw new Error("tasknode_encryption_key_missing");
  }

  const contextPayload = buildContextPayload({ title: args.title, address: wallet.address });
  const userPubkey = await deriveTaskNodePublicKey(mnemonic);
  const encryptedPayload = await encryptTaskNodePayload({
    plaintext: JSON.stringify(contextPayload),
    recipientPublicKeys: [userPubkey, tasknodeEncryptionPubkey],
  });
  const pin = await pinContextIpfsJson({
    payload: encryptedPayload,
    name: `tasknode-context-live-smoke-${Date.now()}`,
    keyvalues: {
      app: "tasknodeofficial",
      smoke: "context_publish_live",
      content_kind: "CONTEXT",
      wallet_address: wallet.address,
    },
  });
  const pointerMemo = buildPftPointerMemo({
    cid: pin.cid,
    kind: "CONTEXT",
    schema: 1,
    flags: POINTER_FLAGS.encrypted,
    contextId: `live-smoke-${Date.now()}`,
  });
  const prepared = await preparePftPointerTransaction({
    account: wallet.address,
    pointerMemo,
  });
  const signed = signPreparedPftlTransaction({
    mnemonic,
    txJson: prepared.txJson,
    expectedAddress: wallet.address,
  });
  const submitted = await submitSignedPftTransaction({
    signedTxBlob: signed.txBlob,
    expectedAccount: wallet.address,
  });
  const after = await fetchPftBalance(wallet.address, { force: true });

  console.log(JSON.stringify({
    ok: true,
    address: wallet.address,
    funded: funding.funded
      ? {
          txHash: funding.funded.txHash,
          amountDrops: funding.funded.amountDrops,
        }
      : null,
    beforeBalanceDrops: funding.before?.balanceDrops || null,
    afterBalanceDrops: after?.balanceDrops || null,
    cid: pin.cid,
    payloadSha256: pin.sha256,
    txHash: submitted.txHash,
    engineResult: submitted.engineResult,
    ledgerIndex: submitted.ledgerIndex,
    endpoint: submitted.endpoint,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.code || error?.message || "context_publish_live_smoke_failed",
    message: error?.message || String(error),
    attempts: error?.attempts || undefined,
  }, null, 2));
  process.exitCode = 1;
});
