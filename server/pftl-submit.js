import https from "node:https";
import { Client, Wallet, decode, isValidClassicAddress, xrpToDrops } from "xrpl";

const DEFAULT_PFTL_NETWORK_ID = 2025;
const DEFAULT_TIMEOUT_MS = 15000;
const MIN_LAST_LEDGER_OFFSET = 120;

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
  const explicit = splitUrls(env.PFTL_WSS_URL || env.VITE_PFTL_WSS_URL).map(normalizeWssUrl);
  const fallback = splitUrls(env.PFTL_WSS_URL_FALLBACKS).map(normalizeWssUrl);
  const derived = splitUrls(env.PFTL_RPC_URL || env.PFTL_RPC_URL_FALLBACKS)
    .filter((url) => /^wss?:\/\//i.test(url))
    .map(normalizeWssUrl);
  return uniqueUrls([...explicit, ...fallback, ...derived]);
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

function txNetworkIdValid(txJson, networkId) {
  if (networkId === null || networkId === undefined) return true;
  return Number(txJson?.NetworkID) === Number(networkId);
}

function wssRejectUnauthorized(env, url) {
  const configured = String(env.PFTL_WSS_REJECT_UNAUTHORIZED || "").trim().toLowerCase();
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
  const options = { connectionTimeout: timeoutMs };
  const rejectUnauthorized = wssRejectUnauthorized(env, endpoint);
  if (!rejectUnauthorized) {
    options.rejectUnauthorized = false;
    options.agent = new https.Agent({ rejectUnauthorized: false });
  }
  const apiKey = String(env.PFTL_RPC_API_KEY || "").trim();
  if (index === 0 && apiKey) options.headers = { "X-Api-Key": apiKey };
  return options;
}

async function connectPftlClient({ env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const endpoints = endpointCandidates(env);
  if (endpoints.length === 0) {
    const error = new Error("pftl_wss_not_configured");
    error.status = 409;
    throw error;
  }

  const attempts = [];
  for (const [index, endpoint] of endpoints.entries()) {
    const client = new Client(endpoint, clientOptionsForEndpoint({ endpoint, index, env, timeoutMs }));
    try {
      await client.connect();
      return { client, endpoint };
    } catch (error) {
      attempts.push({ endpoint, error: error?.message || "pftl_connect_failed" });
      try {
        if (client.isConnected()) await client.disconnect();
      } catch {
        // Keep the connect error as the actionable failure.
      }
    }
  }

  const error = new Error(attempts.at(-1)?.error || "pftl_wss_connect_failed");
  error.status = 502;
  error.attempts = attempts;
  throw error;
}

function sourceWalletUnfunded(error) {
  const text = String(
    error?.data?.error ||
      error?.data?.error_message ||
      error?.error ||
      error?.message ||
      error ||
      ""
  ).toLowerCase();
  return text.includes("actnotfound") || text.includes("account not found");
}

function describeEngineResult(engineResult) {
  if (!engineResult) return "Transaction failed.";
  const friendly = {
    tecNO_DST_INSUF_XRP: "The destination account is not activated on PFTL.",
    tecNO_DST: "The destination account does not exist on PFTL.",
    tecUNFUNDED_PAYMENT: "Insufficient PFT balance to submit this pointer.",
    tecINSUFFICIENT_RESERVE: "This transaction would drop the wallet below the required network reserve.",
    tefPAST_SEQ: "This transaction has already been processed. Try again.",
    tefMAX_LEDGER: "Transaction expired before it could be validated. Try again.",
    terINSUF_FEE_B: "Insufficient balance to cover the transaction fee.",
  };
  return friendly[engineResult] || `Transaction failed: ${engineResult}`;
}

function applyLastLedgerBuffer(txJson, validatedLedgerSeq) {
  const seq = Number(validatedLedgerSeq);
  if (!txJson || !Number.isFinite(seq) || seq <= 0) return;
  const minimum = seq + MIN_LAST_LEDGER_OFFSET;
  const current = Number(txJson.LastLedgerSequence);
  if (!Number.isFinite(current) || current < minimum) txJson.LastLedgerSequence = minimum;
}

function faucetSeed(env = process.env) {
  return String(env.TASKNODE_PFT_FAUCET_SEED || env.FAUCET_SEED || "").trim();
}

export function resolvePftPointerDestination({ defaultAddress = "", env = process.env } = {}) {
  const explicit = String(env.PFTL_POINTER_DESTINATION || "").trim();
  if (explicit) return explicit;

  const seed = faucetSeed(env);
  if (seed) {
    try {
      return Wallet.fromSeed(seed).classicAddress;
    } catch {
      return String(defaultAddress || "").trim();
    }
  }
  return String(defaultAddress || "").trim();
}

export function pftlSubmitStatus(env = process.env) {
  return {
    wssConfigured: endpointCandidates(env).length > 0,
    networkId: configuredNetworkId(env),
  };
}

export async function preparePftPointerTransaction({
  account,
  pointerMemo,
  destination,
  amountDrops = "1",
  env = process.env,
} = {}) {
  const source = String(account || "").trim();
  if (!isValidClassicAddress(source)) {
    const error = new Error("source_wallet_invalid");
    error.status = 400;
    throw error;
  }

  const target = String(destination || resolvePftPointerDestination({ defaultAddress: source, env })).trim();
  if (!isValidClassicAddress(target)) {
    const error = new Error("pointer_destination_invalid");
    error.status = 409;
    throw error;
  }

  const drops = String(amountDrops || "1").trim();
  if (!/^\d+$/.test(drops) || BigInt(drops) <= 0n) {
    const error = new Error("pointer_amount_invalid");
    error.status = 400;
    throw error;
  }
  if (!pointerMemo?.memoTypeHex || !pointerMemo?.memoFormatHex || !pointerMemo?.memoDataHex) {
    const error = new Error("pointer_memo_invalid");
    error.status = 400;
    throw error;
  }

  const networkId = configuredNetworkId(env);
  const timeoutMs = Math.max(3000, Number(env.PFTL_SUBMIT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const { client, endpoint } = await connectPftlClient({ env, timeoutMs });

  try {
    const payment = applyNetworkId({
      TransactionType: "Payment",
      Account: source,
      Destination: target,
      Amount: drops,
      Memos: [{
        Memo: {
          MemoType: pointerMemo.memoTypeHex,
          MemoFormat: pointerMemo.memoFormatHex,
          MemoData: pointerMemo.memoDataHex,
        },
      }],
    }, networkId);

    let prepared;
    try {
      prepared = applyNetworkId(await client.autofill(payment), networkId);
    } catch (error) {
      if (sourceWalletUnfunded(error)) {
        const wrapped = new Error("Active wallet is not activated on PFTL.");
        wrapped.status = 400;
        wrapped.code = "source_wallet_unfunded";
        throw wrapped;
      }
      throw error;
    }

    const [accountInfo, serverInfo] = await Promise.all([
      client.request({ command: "account_info", account: source, ledger_index: "validated" }),
      client.request({ command: "server_info" }),
    ]);
    applyLastLedgerBuffer(prepared, serverInfo?.result?.info?.validated_ledger?.seq);

    const balanceDrops = accountInfo?.result?.account_data?.Balance || "0";
    const reserveBasePft = serverInfo?.result?.info?.validated_ledger?.reserve_base_xrp ?? 10;
    const reserveDrops = xrpToDrops(String(reserveBasePft));
    const feeDrops = prepared?.Fee || "0";
    const availableDrops = BigInt(balanceDrops) - BigInt(reserveDrops) - BigInt(feeDrops);
    if (availableDrops <= 0n || BigInt(drops) > availableDrops) {
      const error = new Error("Insufficient PFT balance to publish context.");
      error.status = 400;
      throw error;
    }

    return {
      txJson: prepared,
      fromAddress: source,
      destination: target,
      amountDrops: drops,
      feeDrops,
      balanceDrops,
      reserveDrops,
      availableDrops: availableDrops.toString(),
      endpoint,
      networkId,
    };
  } finally {
    try {
      if (client.isConnected()) await client.disconnect();
    } catch {
      // Disconnect errors are non-actionable after prepare.
    }
  }
}

export async function submitSignedPftTransaction({
  signedTxBlob,
  expectedAccount = "",
  env = process.env,
} = {}) {
  const blob = String(signedTxBlob || "").trim();
  if (!/^[A-Fa-f0-9]+$/.test(blob)) {
    const error = new Error("signed_transaction_blob_invalid");
    error.status = 400;
    throw error;
  }

  let decoded;
  try {
    decoded = decode(blob);
  } catch {
    const error = new Error("signed_transaction_blob_invalid");
    error.status = 400;
    throw error;
  }

  const networkId = configuredNetworkId(env);
  if (!txNetworkIdValid(decoded, networkId)) {
    const error = new Error(`Signed transaction must include NetworkID ${networkId}.`);
    error.status = 400;
    throw error;
  }

  const account = String(decoded?.Account || "").trim();
  if (!account || (expectedAccount && account !== expectedAccount)) {
    const error = new Error("Signed transaction does not match the linked wallet.");
    error.status = 400;
    throw error;
  }
  if (decoded?.TransactionType !== "Payment") {
    const error = new Error("Only PFTL payment pointer transactions can be submitted here.");
    error.status = 400;
    throw error;
  }

  const timeoutMs = Math.max(3000, Number(env.PFTL_SUBMIT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const { client, endpoint } = await connectPftlClient({ env, timeoutMs });
  try {
    const result = await client.submitAndWait(blob);
    const engineResult = result?.result?.meta?.TransactionResult || result?.result?.engine_result || "";
    if (engineResult && engineResult !== "tesSUCCESS") {
      const error = new Error(describeEngineResult(engineResult));
      error.status = 400;
      error.engineResult = engineResult;
      throw error;
    }

    return {
      ok: true,
      txHash: result?.result?.hash || result?.result?.tx_json?.hash || null,
      engineResult: engineResult || null,
      ledgerIndex: result?.result?.ledger_index || result?.result?.ledgerIndex || null,
      endpoint,
      networkId,
      account,
      destination: decoded.Destination || null,
    };
  } finally {
    try {
      if (client.isConnected()) await client.disconnect();
    } catch {
      // Keep the submit result/error as the actionable outcome.
    }
  }
}
