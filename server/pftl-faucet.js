import https from "node:https";
import { Client, Wallet, isValidClassicAddress } from "xrpl";

const DEFAULT_PFTL_NETWORK_ID = 2025;
const DEFAULT_TIMEOUT_MS = 15000;

function splitUrls(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function normalizeWssUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function endpointCandidates(env = process.env) {
  const explicit = splitUrls(env.PFTL_FAUCET_WSS_URL || env.PFTL_WSS_URL || env.VITE_PFTL_WSS_URL);
  const fallback = splitUrls(env.PFTL_FAUCET_WSS_URL_FALLBACKS || env.PFTL_WSS_URL_FALLBACKS);
  const derived = splitUrls(env.PFTL_RPC_URL || env.PFTL_RPC_URL_FALLBACKS)
    .filter((url) => /^wss?:\/\//i.test(url))
    .map(normalizeWssUrl);
  return uniqueUrls([...explicit.map(normalizeWssUrl), ...fallback.map(normalizeWssUrl), ...derived]);
}

function wssRejectUnauthorized(env, url) {
  const configured = String(env.PFTL_FAUCET_WSS_REJECT_UNAUTHORIZED || env.PFTL_WSS_REJECT_UNAUTHORIZED || "")
    .trim()
    .toLowerCase();
  if (["true", "1", "yes"].includes(configured)) return true;

  try {
    const hostname = new URL(url).hostname;
    const localOnly = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    const explicitlyAllowed =
      ["false", "0", "no"].includes(configured) &&
      env.TASKNODE_ALLOW_INSECURE_LOCAL_PFTL_TLS === "true";
    return !(localOnly && explicitlyAllowed);
  } catch {
    return true;
  }
}

function clientOptionsForEndpoint({ endpoint, index, env, timeoutMs }) {
  const options = {
    connectionTimeout: timeoutMs,
  };
  const rejectUnauthorized = wssRejectUnauthorized(env, endpoint);
  if (!rejectUnauthorized) {
    options.rejectUnauthorized = false;
    options.agent = new https.Agent({ rejectUnauthorized: false });
  }
  const apiKey = String(env.PFTL_FAUCET_WSS_API_KEY || env.PFTL_RPC_API_KEY || "").trim();
  if (index === 0 && apiKey) {
    options.headers = { "X-Api-Key": apiKey };
  }
  return options;
}

function pftToDrops(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "12000000";
  return String(Math.round(Math.min(amount, 100) * 1_000_000));
}

function configuredNetworkId(env = process.env) {
  const raw = env.PFTL_NETWORK_ID || env.TASKNODE_PFTL_NETWORK_ID || DEFAULT_PFTL_NETWORK_ID;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error("pftl_network_id_invalid");
  }
  return parsed;
}

function applyNetworkId(txJson, networkId) {
  if (networkId > 0) txJson.NetworkID = networkId;
  return txJson;
}

function faucetSeed(env = process.env) {
  return String(env.TASKNODE_PFT_FAUCET_SEED || env.FAUCET_SEED || "").trim();
}

export function pftInitiationFaucetStatus(env = process.env) {
  const seed = faucetSeed(env);
  const endpoints = endpointCandidates(env);
  const amountPft = Number(env.TASKNODE_WALLET_INITIATION_PFT || 12);
  let faucetAddress = null;
  try {
    faucetAddress = seed ? Wallet.fromSeed(seed).classicAddress : null;
  } catch {
    faucetAddress = null;
  }

  return {
    configured: Boolean(seed && endpoints.length > 0 && faucetAddress),
    status: seed && endpoints.length > 0 && faucetAddress ? "ready" : "missing_config",
    amountPft: Number.isFinite(amountPft) && amountPft > 0 ? Math.min(amountPft, 100) : 12,
    amountDrops: pftToDrops(amountPft),
    faucetAddress,
    endpointsConfigured: endpoints.length,
    networkId: configuredNetworkId(env),
    actionRequired:
      seed && endpoints.length > 0 && faucetAddress
        ? "Create-wallet initiation grants can be paid from the configured PFTL faucet."
        : "Configure TASKNODE_PFT_FAUCET_SEED or FAUCET_SEED plus PFTL_WSS_URL before paying create-wallet initiation grants.",
  };
}

export async function sendPftInitiationGift({
  destination,
  amountDrops = "",
  memo = "Task Node wallet initiation gift",
  env = process.env,
} = {}) {
  const address = String(destination || "").trim();
  if (!isValidClassicAddress(address)) {
    const error = new Error("destination_wallet_invalid");
    error.status = 400;
    throw error;
  }

  const seed = faucetSeed(env);
  if (!seed) {
    const error = new Error("pft_faucet_seed_missing");
    error.status = 409;
    throw error;
  }

  const endpoints = endpointCandidates(env);
  if (endpoints.length === 0) {
    const error = new Error("pft_faucet_wss_missing");
    error.status = 409;
    throw error;
  }

  const faucetWallet = Wallet.fromSeed(seed);
  const drops = String(amountDrops || pftToDrops(env.TASKNODE_WALLET_INITIATION_PFT || 12));
  if (!/^\d+$/.test(drops) || BigInt(drops) <= 0n) {
    const error = new Error("pft_faucet_amount_invalid");
    error.status = 409;
    throw error;
  }

  const networkId = configuredNetworkId(env);
  const timeoutMs = Math.max(3000, Number(env.PFTL_FAUCET_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const attempts = [];

  for (const [index, endpoint] of endpoints.entries()) {
    const client = new Client(endpoint, clientOptionsForEndpoint({ endpoint, index, env, timeoutMs }));
    try {
      await client.connect();
      const payment = applyNetworkId({
        TransactionType: "Payment",
        Account: faucetWallet.classicAddress,
        Destination: address,
        Amount: drops,
        Memos: [{
          Memo: {
            MemoType: Buffer.from("tasknode.wallet_initiation", "utf8").toString("hex").toUpperCase(),
            MemoData: Buffer.from(String(memo || ""), "utf8").toString("hex").toUpperCase(),
          },
        }],
      }, networkId);
      const prepared = applyNetworkId(await client.autofill(payment), networkId);
      const signed = faucetWallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      const engineResult = result?.result?.meta?.TransactionResult || result?.result?.engine_result;
      if (engineResult && engineResult !== "tesSUCCESS") {
        throw new Error(`pft_faucet_tx_failed:${engineResult}`);
      }

      return {
        ok: true,
        txHash: result?.result?.hash || result?.result?.tx_json?.hash || signed.hash || null,
        amountDrops: drops,
        amountPft: Number((Number(drops) / 1_000_000).toFixed(6)),
        faucetAddress: faucetWallet.classicAddress,
        destination: address,
        endpoint,
        networkId,
      };
    } catch (error) {
      attempts.push({ endpoint, error: error?.message || "pft_faucet_attempt_failed" });
    } finally {
      try {
        if (client.isConnected()) await client.disconnect();
      } catch {
        // Keep the faucet submit error as the actionable failure.
      }
    }
  }

  const error = new Error(attempts.at(-1)?.error || "pft_faucet_submit_failed");
  error.status = 502;
  error.attempts = attempts;
  throw error;
}
