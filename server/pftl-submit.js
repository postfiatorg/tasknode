import https from "node:https";
import { Client, Wallet, decode, isValidClassicAddress, xrpToDrops } from "xrpl";
import { pftlWssRejectUnauthorized } from "./pftl-wss-tls.js";

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

function endpointHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "configured-endpoint";
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
  return pftlWssRejectUnauthorized({ env, url });
}

function sanitizePftlConnectError(error) {
  const code = String(error?.code || error?.data?.error || "").trim();
  const tlsCodes = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED",
  ]);
  if (tlsCodes.has(code)) return "pftl_tls_certificate_rejected";
  if (code === "ETIMEDOUT" || code === "ERR_SOCKET_CONNECTION_TIMEOUT") return "pftl_wss_connect_timeout";
  if (code === "ECONNREFUSED") return "pftl_wss_connection_refused";
  if (code === "ENOTFOUND") return "pftl_wss_host_not_found";
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "pftl_wss_connect_timeout";
  return "pftl_connect_failed";
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
      attempts.push({ endpointHost: endpointHost(endpoint), error: sanitizePftlConnectError(error) });
      try {
        if (client.isConnected()) await client.disconnect();
      } catch {
        // Keep the connect error as the actionable failure.
      }
    }
  }

  const error = new Error("PFTL websocket endpoint could not be reached.");
  error.status = 502;
  error.code = "pftl_wss_connect_failed";
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

function normalizeTokenIdValue(value) {
  const text = String(value || "").trim();
  return /^[A-Fa-f0-9]{32,256}$/.test(text) ? text.toUpperCase() : "";
}

function decodeHexToUtf8(value) {
  const text = String(value || "").trim();
  if (!text || text.length % 2 !== 0 || !/^[A-Fa-f0-9]+$/.test(text)) return "";
  try {
    return Buffer.from(text, "hex").toString("utf8");
  } catch {
    return "";
  }
}

function extractMintTokenIdFromMeta(meta) {
  const directTokenId = normalizeTokenIdValue(meta?.nftoken_id || meta?.NFTokenID);
  if (directTokenId) return directTokenId;

  const affectedNodes = Array.isArray(meta?.AffectedNodes) ? meta.AffectedNodes : [];
  for (const entry of affectedNodes) {
    const node = entry?.CreatedNode || entry?.ModifiedNode || entry?.DeletedNode || null;
    if (!node || node.LedgerEntryType !== "NFTokenPage") continue;
    const fieldSets = [node.NewFields, node.FinalFields, node.PreviousFields];
    for (const fields of fieldSets) {
      const tokens = Array.isArray(fields?.NFTokens) ? fields.NFTokens : [];
      for (const tokenEntry of tokens) {
        const token = tokenEntry?.NFToken || tokenEntry || null;
        const tokenId = normalizeTokenIdValue(token?.NFTokenID || token?.nftoken_id);
        if (tokenId) return tokenId;
      }
    }
  }
  return "";
}

async function resolveMintTokenIdByAccountNfts({ client, walletAddress = "", expectedUriHex = "", maxPages = 8 } = {}) {
  const account = String(walletAddress || "").trim();
  const uriHex = String(expectedUriHex || "").trim().toUpperCase();
  const expectedUri = decodeHexToUtf8(uriHex).trim().toLowerCase();
  if (!account || !expectedUri) return "";

  let marker;
  for (let page = 0; page < maxPages; page += 1) {
    const request = {
      command: "account_nfts",
      account,
      ledger_index: "validated",
      limit: 400,
    };
    if (marker) request.marker = marker;
    const response = await client.request(request);
    const nfts = Array.isArray(response?.result?.account_nfts) ? response.result.account_nfts : [];
    for (const nft of nfts) {
      const nftUri = decodeHexToUtf8(nft?.URI || "").trim().toLowerCase();
      if (nftUri !== expectedUri) continue;
      const tokenId = normalizeTokenIdValue(nft?.NFTokenID || nft?.nftoken_id);
      if (tokenId) return tokenId;
    }
    marker = response?.result?.marker;
    if (!marker) break;
  }
  return "";
}

export function pftUriToHex(uri = "") {
  const text = String(uri || "").trim();
  if (!text) {
    const error = new Error("nft_uri_required");
    error.status = 400;
    throw error;
  }
  return Buffer.from(text, "utf8").toString("hex").toUpperCase();
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

export async function preparePftPaymentTransaction({
  account,
  destination,
  amountPft,
  amountDrops,
  env = process.env,
} = {}) {
  const source = String(account || "").trim();
  if (!isValidClassicAddress(source)) {
    const error = new Error("source_wallet_invalid");
    error.status = 400;
    throw error;
  }

  const target = String(destination || "").trim();
  if (!isValidClassicAddress(target)) {
    const error = new Error("destination_wallet_invalid");
    error.status = 400;
    throw error;
  }

  let drops = String(amountDrops || "").trim();
  if (!drops) {
    const amountText = String(amountPft || "").trim();
    if (!amountText || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amountText)) {
      const error = new Error("payment_amount_invalid");
      error.status = 400;
      throw error;
    }
    try {
      drops = xrpToDrops(amountText);
    } catch {
      const error = new Error("payment_amount_invalid");
      error.status = 400;
      throw error;
    }
  }

  if (!/^\d+$/.test(drops) || BigInt(drops) <= 0n) {
    const error = new Error("payment_amount_invalid");
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
      const error = new Error("Insufficient PFT balance to send this payment.");
      error.status = 400;
      error.code = "payment_insufficient_balance";
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

export async function preparePftNftMintTransaction({
  account,
  uriHex,
  flags = 9,
  taxon = 0,
  transferFee = 0,
  env = process.env,
} = {}) {
  const source = String(account || "").trim();
  if (!isValidClassicAddress(source)) {
    const error = new Error("source_wallet_invalid");
    error.status = 400;
    throw error;
  }

  const normalizedUriHex = String(uriHex || "").trim().toUpperCase();
  if (!normalizedUriHex || normalizedUriHex.length % 2 !== 0 || !/^[A-F0-9]+$/.test(normalizedUriHex)) {
    const error = new Error("nft_uri_hex_invalid");
    error.status = 400;
    throw error;
  }

  const networkId = configuredNetworkId(env);
  const timeoutMs = Math.max(3000, Number(env.PFTL_SUBMIT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const { client, endpoint } = await connectPftlClient({ env, timeoutMs });

  try {
    const mintTx = applyNetworkId({
      TransactionType: "NFTokenMint",
      Account: source,
      URI: normalizedUriHex,
      Flags: Number(flags || 0),
      NFTokenTaxon: Number(taxon || 0),
      TransferFee: Number(transferFee || 0),
    }, networkId);

    let prepared;
    try {
      prepared = applyNetworkId(await client.autofill(mintTx), networkId);
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

    return {
      txJson: prepared,
      fromAddress: source,
      feeDrops: prepared?.Fee || "0",
      balanceDrops: accountInfo?.result?.account_data?.Balance || "0",
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
  expectedDestination = "",
  expectedAmountDrops = "",
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
    const error = new Error("Only PFTL Payment transactions can be submitted here.");
    error.status = 400;
    throw error;
  }
  const destination = String(decoded?.Destination || "").trim();
  if (expectedDestination && destination !== String(expectedDestination).trim()) {
    const error = new Error("Signed transaction destination does not match the prepared payment.");
    error.status = 400;
    throw error;
  }
  const amount = typeof decoded?.Amount === "string" ? decoded.Amount : "";
  if (expectedAmountDrops && amount !== String(expectedAmountDrops).trim()) {
    const error = new Error("Signed transaction amount does not match the prepared payment.");
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

export async function submitSignedPftNftMintTransaction({
  signedTxBlob,
  expectedAccount = "",
  expectedUriHex = "",
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
  if (decoded?.TransactionType !== "NFTokenMint") {
    const error = new Error("Only PFTL NFT mint transactions can be submitted here.");
    error.status = 400;
    throw error;
  }

  const normalizedExpectedUriHex = String(expectedUriHex || "").trim().toUpperCase();
  if (normalizedExpectedUriHex && String(decoded.URI || "").trim().toUpperCase() !== normalizedExpectedUriHex) {
    const error = new Error("Signed transaction URI does not match the prepared NFT metadata.");
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

    const txHash = result?.result?.hash || result?.result?.tx_json?.hash || null;
    const nftTokenId =
      extractMintTokenIdFromMeta(result?.result?.meta) ||
      await resolveMintTokenIdByAccountNfts({
        client,
        walletAddress: account,
        expectedUriHex: decoded.URI,
      });

    return {
      ok: true,
      txHash,
      nftTokenId,
      engineResult: engineResult || null,
      ledgerIndex: result?.result?.ledger_index || result?.result?.ledgerIndex || null,
      endpoint,
      networkId,
      account,
    };
  } finally {
    try {
      if (client.isConnected()) await client.disconnect();
    } catch {
      // Keep the submit result/error as the actionable outcome.
    }
  }
}
