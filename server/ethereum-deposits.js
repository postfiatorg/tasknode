import {
  formatEther,
  formatUnits,
  getAddress,
  HDNodeWallet,
  id as keccakId,
  zeroPadValue,
} from "ethers";
import {
  completeWalletInitiationGrant,
  failWalletInitiationGrant,
  reserveWalletInitiationGrant,
  resolveWalletInitiationGrantStatus,
} from "./runtime-store.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";
import {
  getEthereumDepositAccount,
  getOrCreateEthereumDepositAccount,
  retireEthereumDepositAccount,
  updateEthereumDepositSync,
} from "./repositories/ethereum-deposit-accounts.js";
import {
  appendUsageCredit,
  hasUsageCreditForSource,
  usageLedger,
  usageSummary,
} from "./repositories/chat-billing.js";
import {
  pftInitiationFaucetStatus,
  sendPftInitiationGift,
} from "./pftl-faucet.js";

const defaultEthereumRpcUrl = "https://ethereum.publicnode.com";
const ethereumMainnetChainId = 1;
const defaultReceivePath = "m/44'/60'/0'/0";
const defaultDepositStartIndex = 1;
const defaultBalanceBlockTag = "latest";
const defaultUsdcTopUpGrantThresholdUsd = 10;
const balanceBlockTag = process.env.ETH_DEPOSIT_BALANCE_BLOCK_TAG || defaultBalanceBlockTag;
const pendingBalanceBlockTag = process.env.ETH_DEPOSIT_PENDING_BLOCK_TAG || "latest";
const balanceOfSelector = keccakId("balanceOf(address)").slice(0, 10);

export const ethereumDepositAssets = [
  {
    symbol: "ETH",
    label: "Ether",
    decimals: 18,
    kind: "native",
    contractAddress: null,
    creditPolicy: "ETH is converted to USD using the price available when the configured balance sync credits the deposit.",
  },
  {
    symbol: "USDC",
    label: "USD Coin",
    decimals: 6,
    kind: "erc20",
    contractAddress: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    creditPolicy: "Credited 1:1 as USD after the configured token balance increases.",
  },
  {
    symbol: "USDT",
    label: "Tether USD",
    decimals: 6,
    kind: "erc20",
    contractAddress: getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
    creditPolicy: "Credited 1:1 as USD after the configured token balance increases.",
  },
];

function ethereumDepositXpub() {
  return String(process.env.ETH_DEPOSIT_XPUB || process.env.ETHEREUM_DEPOSIT_XPUB || "").trim();
}

function ethereumRpcUrl() {
  return String(process.env.ETH_DEPOSIT_RPC_URL || process.env.ETHEREUM_RPC_URL || defaultEthereumRpcUrl).trim();
}

function receivePathPrefix() {
  return String(process.env.ETH_DEPOSIT_RECEIVE_PATH || defaultReceivePath).trim();
}

function depositStartIndex() {
  const value = Number(process.env.ETH_DEPOSIT_START_INDEX || defaultDepositStartIndex);
  return Number.isSafeInteger(value) && value >= 0 ? value : defaultDepositStartIndex;
}

export function usdcTopUpGrantThresholdUsd() {
  const value = Number(process.env.TASKNODE_USDC_TOPUP_PFT_GRANT_THRESHOLD_USD || defaultUsdcTopUpGrantThresholdUsd);
  return Number.isFinite(value) && value >= 0 ? value : defaultUsdcTopUpGrantThresholdUsd;
}

export function ethereumDepositConfigStatus() {
  const xpub = ethereumDepositXpub();
  const rpcUrl = ethereumRpcUrl();
  return {
    configured: Boolean(xpub),
    enabled: Boolean(xpub),
    status: xpub ? "ready" : "missing_config",
    chainId: ethereumMainnetChainId,
    network: "Ethereum mainnet",
    rpcConfigured: Boolean(rpcUrl),
    blockTag: balanceBlockTag,
    depositStartIndex: depositStartIndex(),
    supportedAssets: ethereumDepositAssets,
    actionRequired: xpub
      ? "Use /api/usage/top-up/start to allocate the account deposit address."
      : "Configure ETH_DEPOSIT_XPUB with the Ethereum receive xpub for m/44'/60'/0'/0 before showing live deposit addresses.",
  };
}

export function deriveEthereumDepositAddress(index) {
  const xpub = ethereumDepositXpub();
  if (!xpub) {
    throw new Error("eth_deposit_xpub_missing");
  }

  const normalizedIndex = Math.max(0, Number(index) || 0);
  const receiveNode = HDNodeWallet.fromExtendedKey(xpub);
  const child = receiveNode.deriveChild(normalizedIndex);
  return {
    address: getAddress(child.address),
    derivationIndex: normalizedIndex,
    derivationPath: `${receivePathPrefix()}/${normalizedIndex}`,
  };
}

export async function getOrCreateEthereumTopUpAccount({ accountId = "" } = {}) {
  const status = ethereumDepositConfigStatus();
  if (!accountId) {
    return { ok: false, status: 401, error: "deposit_login_required" };
  }
  if (!status.enabled) {
    return { ok: false, status: 409, error: "eth_deposit_not_configured", config: status };
  }

  const result = await getOrCreateEthereumDepositAccount({
    accountId,
    deriveAddress: deriveEthereumDepositAddress,
    assets: ethereumDepositAssets.map(({ symbol }) => symbol),
    chainId: ethereumMainnetChainId,
    network: "Ethereum mainnet",
    startIndex: depositStartIndex(),
  });

  if (!result.ok) return result;
  return {
    ok: true,
    created: result.created,
    depositAccount: publicDepositAccount(result.account),
    config: status,
  };
}

export async function getOrCreateVerifiedEthereumTopUpAccount({ accountId = "" } = {}) {
  const status = ethereumDepositConfigStatus();
  if (!accountId) {
    return { ok: false, status: 401, error: "deposit_login_required" };
  }
  if (!status.enabled) {
    return { ok: false, status: 409, error: "eth_deposit_not_configured", config: status };
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await getOrCreateEthereumTopUpAccount({ accountId });
    if (!result.ok) return result;

    const account = await getEthereumDepositAccount({ accountId });
    const hasDepositCredit = await accountHasDepositCredit(account);
    const syncedBefore = Boolean(account?.lastSyncAt || Object.keys(account?.observedBalances || {}).length > 0);
    const baselineOnly = syncedBefore && hasStoredPositiveBalance(account) && !hasDepositCredit;
    if (syncedBefore && !baselineOnly) return result;

    const probe = await readAddressBalances(account.address);
    if (probe.errors.length > 0) {
      return {
        ok: false,
        status: 503,
        error: "deposit_balance_probe_failed",
        message: "Could not verify deposit address balances. Retry when Ethereum RPC is available.",
        actionRequired: "Retry top-up after the Ethereum balance RPC is healthy. Operators should check ETH_DEPOSIT_RPC_URL before exposing deposit addresses again.",
        config: status,
      };
    }

    if (probe.positiveSymbols.length > 0 || baselineOnly) {
      const symbols = probe.positiveSymbols.length > 0
        ? probe.positiveSymbols.join(",")
        : positiveBalanceSymbols(account?.observedBalances).join(",");
      await retireEthereumDepositAccount({
        accountId,
        status: "retired_prefunded",
        reason: `prefunded_before_assignment:${symbols || "unknown"}`,
      });
      continue;
    }

    const updated = await updateEthereumDepositSync({
      accountId,
      observedBalances: probe.observedBalances,
      pendingBalances: Object.fromEntries(ethereumDepositAssets.map((asset) => [asset.symbol, null])),
      creditedBalances: {},
      syncStatus: probe.errors.length > 0 ? "partial" : "ready",
      syncError: probe.errors.join("; "),
      blockTag: balanceBlockTag,
      creditedEntries: [],
    });

    return {
      ...result,
      depositAccount: publicDepositAccount(updated || account),
      syncErrors: probe.errors,
    };
  }

  return { ok: false, status: 409, error: "deposit_clean_address_unavailable", config: status };
}

export function publicDepositAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    accountId: account.accountId,
    chainId: account.chainId || ethereumMainnetChainId,
    network: account.network || "Ethereum mainnet",
    address: account.address,
    derivationIndex: account.derivationIndex,
    derivationPath: account.derivationPath,
    status: account.status || "active",
    custody: account.custody || "tasknode_deposit_only",
    withdrawalsEnabled: account.withdrawalsEnabled === true,
    sweepStatus: account.sweepStatus || "deferred",
    observedBalances: account.observedBalances || {},
    pendingBalances: account.pendingBalances || {},
    creditedBalances: account.creditedBalances || {},
    lastSyncAt: account.lastSyncAt || null,
    lastSyncStatus: account.lastSyncStatus || "not_synced",
    lastSyncError: account.lastSyncError || "",
    assets: ethereumDepositAssets,
  };
}

function positiveBalanceSymbols(balances = {}) {
  return Object.entries(balances)
    .filter(([, balance]) => {
      try {
        return BigInt(balance?.raw || "0") > 0n;
      } catch {
        return Number(balance?.amount || 0) > 0;
      }
    })
    .map(([symbol]) => symbol);
}

function hasStoredPositiveBalance(account) {
  return positiveBalanceSymbols(account?.observedBalances).length > 0 ||
    positiveBalanceSymbols(account?.creditedBalances).length > 0;
}

async function accountHasDepositCredit(account) {
  if ((account?.lastCreditedLedgerIds || []).length > 0) return true;
  return hasUsageCreditForSource({
    accountId: account?.accountId || "",
    source: "ethereum_deposit",
    metadata: { depositAccountId: account?.id || "" },
    uniqueKeyPrefix: account?.id ? `ethereum_deposit:${account.id}:` : "",
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcCall(method, params = []) {
  const response = await fetchWithTimeout(ethereumRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });
  const body = await response.json();
  if (!response.ok || body?.error) {
    const error = new Error(body?.error?.message || `Ethereum RPC ${method} failed`);
    error.status = response.status || 502;
    throw error;
  }
  return body.result;
}

async function ethUsdPrice() {
  const configured = Number(process.env.ETH_DEPOSIT_ETH_USD_PRICE || process.env.ETH_USD_PRICE || 0);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const response = await fetchWithTimeout(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    { headers: { accept: "application/json" } },
    8000
  );
  const body = await response.json();
  const price = Number(body?.ethereum?.usd || 0);
  if (!response.ok || !Number.isFinite(price) || price <= 0) {
    throw new Error("eth_usd_price_unavailable");
  }
  return price;
}

function balanceOfCalldata(address) {
  return `${balanceOfSelector}${zeroPadValue(address, 32).slice(2)}`;
}

function rawHexToBigInt(value) {
  const text = String(value || "0x0");
  if (!/^0x[0-9a-f]*$/i.test(text)) return 0n;
  return BigInt(text || "0x0");
}

async function readAssetBalance(asset, address, blockTag = balanceBlockTag) {
  if (asset.kind === "native") {
    const raw = rawHexToBigInt(await rpcCall("eth_getBalance", [address, blockTag]));
    return {
      symbol: asset.symbol,
      raw,
      amount: formatEther(raw),
      decimals: asset.decimals,
    };
  }

  const raw = rawHexToBigInt(await rpcCall("eth_call", [
    {
      to: asset.contractAddress,
      data: balanceOfCalldata(address),
    },
    blockTag,
  ]));
  return {
    symbol: asset.symbol,
    raw,
    amount: formatUnits(raw, asset.decimals),
    decimals: asset.decimals,
  };
}

async function readAddressBalances(address, blockTag = balanceBlockTag) {
  const observedBalances = {};
  const errors = [];
  for (const asset of ethereumDepositAssets) {
    try {
      const balance = await readAssetBalance(asset, address, blockTag);
      observedBalances[asset.symbol] = formattedBalance(balance, blockTag);
    } catch (error) {
      errors.push(`${asset.symbol}: ${error?.message || "balance_unavailable"}`);
    }
  }
  return {
    observedBalances,
    positiveSymbols: positiveBalanceSymbols(observedBalances),
    errors,
  };
}

function formattedBalance(balance, blockTag = balanceBlockTag) {
  return {
    raw: balance.raw.toString(),
    amount: balance.amount,
    decimals: balance.decimals,
    syncedAt: new Date().toISOString(),
    blockTag,
  };
}

function decimalAmount(raw, decimals) {
  return Number(formatUnits(raw, decimals));
}

function hasSyncedAssetBalance(account, symbol) {
  return Boolean(
    account?.observedBalances?.[symbol] ||
    account?.creditedBalances?.[symbol]
  );
}

async function creditDelta({ account, asset, currentRaw, creditedRaw }) {
  const deltaRaw = currentRaw - creditedRaw;
  if (deltaRaw <= 0n) return null;

  const assetAmount = decimalAmount(deltaRaw, asset.decimals);
  let amountUsd = assetAmount;
  const metadata = {
    chain: "ethereum",
    chainId: ethereumMainnetChainId,
    network: "Ethereum mainnet",
    asset: asset.symbol,
    decimals: asset.decimals,
    depositAddress: account.address,
    depositAccountId: account.id,
    rawAmount: deltaRaw.toString(),
    creditedBalanceRaw: currentRaw.toString(),
    blockTag: balanceBlockTag,
  };

  if (asset.symbol === "ETH") {
    const price = await ethUsdPrice();
    amountUsd = assetAmount * price;
    metadata.ethUsdPrice = price;
  }

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;

  return appendUsageCredit({
    accountId: account.accountId,
    amountUsd,
    source: "ethereum_deposit",
    note: `${assetAmount.toFixed(asset.symbol === "ETH" ? 8 : 2)} ${asset.symbol} deposit`,
    createdBy: "ethereum_deposit_sync",
    uniqueKey: `ethereum_deposit:${account.id}:${asset.symbol}:${currentRaw.toString()}`,
    metadata,
  });
}

function parseUsdAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function usdcTopUpGrantThresholdMet(totalUsd) {
  return parseUsdAmount(totalUsd) > usdcTopUpGrantThresholdUsd();
}

function usdcCreditedUsdFromDepositAccount(account) {
  return parseUsdAmount(account?.creditedBalances?.USDC?.amount);
}

async function totalUsdcDepositCreditUsd({ accountId = "", depositAccount = null } = {}) {
  const account = depositAccount || await getEthereumDepositAccount({ accountId });
  const normalizedAccountId = String(account?.accountId || accountId || "").trim();
  if (!normalizedAccountId) return 0;

  const fromDeposit = usdcCreditedUsdFromDepositAccount(account);
  const ledger = await usageLedger({ accountId: normalizedAccountId, limit: 200 });
  let ledgerTotal = 0;
  for (const entry of ledger.entries || []) {
    if (entry?.source !== "ethereum_deposit") continue;
    if (String(entry?.metadata?.asset || "").toUpperCase() !== "USDC") continue;
    ledgerTotal += parseUsdAmount(entry.amountUsd);
  }

  return Number(Math.max(fromDeposit, ledgerTotal).toFixed(6));
}

async function findLatestUsdcDepositLedgerEntry(accountId = "") {
  const ledger = await usageLedger({ accountId, limit: 200 });
  return (ledger.entries || []).find((entry) => (
    entry?.source === "ethereum_deposit" &&
    String(entry?.metadata?.asset || "").toUpperCase() === "USDC"
  )) || null;
}

function buildUsdcTopUpGrantTrigger({ account, entry = null, totalUsd = 0 } = {}) {
  const normalizedTotalUsd = Number(parseUsdAmount(totalUsd).toFixed(6));
  if (entry) {
    return {
      asset: "USDC",
      amountUsd: Number(parseUsdAmount(entry.amountUsd).toFixed(6)),
      totalCreditedUsd: normalizedTotalUsd,
      ledgerEntryId: String(entry.id || "").slice(0, 180),
      depositAccountId: String(account.id || "").slice(0, 180),
      topUpUniqueKey: String(entry.uniqueKey || "").slice(0, 180),
    };
  }

  return {
    asset: "USDC",
    amountUsd: normalizedTotalUsd,
    totalCreditedUsd: normalizedTotalUsd,
    depositAccountId: String(account.id || "").slice(0, 180),
    source: "usdc_balance_threshold",
  };
}

async function resolveUsdcTopUpGrantQualification({ account, entry = null } = {}) {
  if (!account?.accountId) return null;

  const totalUsd = await totalUsdcDepositCreditUsd({
    accountId: account.accountId,
    depositAccount: account,
  });
  if (entry && qualifyingUsdcTopUpEntry(entry)) {
    return {
      totalUsd: Number(Math.max(totalUsd, parseUsdAmount(entry.amountUsd)).toFixed(6)),
      entry,
    };
  }
  if (!usdcTopUpGrantThresholdMet(totalUsd)) return null;

  const ledgerEntry = entry && !entry.idempotentReplay
    ? entry
    : await findLatestUsdcDepositLedgerEntry(account.accountId);
  return { totalUsd, entry: ledgerEntry };
}

function qualifyingUsdcTopUpEntry(entry) {
  const thresholdUsd = usdcTopUpGrantThresholdUsd();
  const amountUsd = Number(entry?.amountUsd || 0);
  if (entry?.idempotentReplay) return false;
  if (entry?.source !== "ethereum_deposit") return false;
  if (String(entry?.metadata?.asset || "").toUpperCase() !== "USDC") return false;
  if (Number.isFinite(amountUsd) && amountUsd > thresholdUsd) return true;
  try {
    const rawTotal = BigInt(String(entry?.metadata?.creditedBalanceRaw || "0"));
    const decimals = Number(entry?.metadata?.decimals || 6);
    const creditedUsd = Number(formatUnits(rawTotal, Number.isSafeInteger(decimals) ? decimals : 6));
    return Number.isFinite(creditedUsd) && creditedUsd > thresholdUsd;
  } catch {
    return false;
  }
}

function publicTopUpGrantResult(result, extra = {}) {
  if (!result) return null;
  return {
    ok: Boolean(result.ok),
    status: result.status || (result.ok ? "completed" : "not_eligible"),
    reason: result.reason || null,
    amountPft: result.amountPft,
    amountDrops: result.amountDrops,
    txHash: result.txHash || null,
    faucetAddress: result.faucetAddress || null,
    message: result.message || "",
    actionRequired: result.actionRequired || undefined,
    grant: result.grant || null,
    thresholdUsd: usdcTopUpGrantThresholdUsd(),
    ...extra,
  };
}

function formatTopUpGrantUsd(value) {
  const amount = Number(value || 0);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  return `$${safeAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function usdcTopUpGrantProgressMessage({ account = null, pftGrant = null } = {}) {
  if (pftGrant) return "";
  const creditedUsdc = Number(account?.creditedBalances?.USDC?.amount || 0);
  if (!Number.isFinite(creditedUsdc) || creditedUsdc <= 0) return "";
  const thresholdUsd = usdcTopUpGrantThresholdUsd();
  if (creditedUsdc > thresholdUsd) return "";

  const remainingUsd = Math.max(0, thresholdUsd - creditedUsdc);
  const addInstruction = remainingUsd === 0
    ? "Add any USDC amount above $0.00"
    : `Add more than ${formatTopUpGrantUsd(remainingUsd)} USDC`;
  return [
    `PFT grant requires more than ${formatTopUpGrantUsd(thresholdUsd)} USDC credited.`,
    `Current credited USDC: ${formatTopUpGrantUsd(creditedUsdc)}.`,
    `${addInstruction}, then unlock the matching local seed vault from Wallet to send the grant.`,
  ].join(" ");
}

async function claimUsdcTopUpInitiationGift({ account = null, entry = null, accountId = "" } = {}) {
  const depositAccount = account || await getEthereumDepositAccount({ accountId });
  if (!depositAccount?.accountId) return null;

  const qualification = await resolveUsdcTopUpGrantQualification({ account: depositAccount, entry });
  if (!qualification) return null;

  const linkedWallet = await getLinkedWallet({ accountId: depositAccount.accountId });
  if (linkedWallet.status !== "linked" || !linkedWallet.address) return null;
  if (!linkedWallet.walletCreatedInAccount) return null;

  const eligibility = await resolveWalletInitiationGrantStatus({
    accountId: depositAccount.accountId,
    walletAddress: linkedWallet.address,
    source: "usdc_top_up",
  });

  if (!eligibility.eligible) {
    if (["account_registered", "wallet_registered"].includes(eligibility.reason)) return null;
    return publicTopUpGrantResult({
      ok: false,
      status: "not_eligible",
      reason: eligibility.reason || "usdc_top_up_grant_not_eligible",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: eligibility.message,
      grant: eligibility.grant || null,
    });
  }

  const faucet = pftInitiationFaucetStatus();
  if (!faucet.configured) {
    return publicTopUpGrantResult({
      ok: false,
      status: "not_configured",
      reason: "faucet_not_configured",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: `USDC top-up qualifies for a ${eligibility.amountPft.toLocaleString("en-US")} PFT grant, but the PFT faucet is not configured.`,
      actionRequired: faucet.actionRequired,
    });
  }

  const trigger = buildUsdcTopUpGrantTrigger({
    account: depositAccount,
    entry: qualification.entry,
    totalUsd: qualification.totalUsd,
  });

  const reserved = await reserveWalletInitiationGrant({
    accountId: depositAccount.accountId,
    walletAddress: linkedWallet.address,
    amountDrops: eligibility.amountDrops,
    amountPft: eligibility.amountPft,
    source: "usdc_top_up",
    trigger,
  });
  if (!reserved.ok) {
    const status = reserved.eligibility || {};
    if (["account_registered", "wallet_registered"].includes(status.reason)) return null;
    return publicTopUpGrantResult({
      ok: false,
      status: "not_eligible",
      reason: reserved.error || status.reason || "usdc_top_up_grant_not_eligible",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: status.message || "USDC top-up PFT grant is not eligible.",
      grant: status.grant || null,
    });
  }

  try {
    const sent = await sendPftInitiationGift({
      destination: linkedWallet.address,
      amountDrops: eligibility.amountDrops,
      memo: `Task Node USDC top-up grant for ${depositAccount.accountId}`,
    });
    const completed = await completeWalletInitiationGrant({
      grantId: reserved.internalGrant.id,
      txHash: sent.txHash,
      faucetAddress: sent.faucetAddress,
    });
    return publicTopUpGrantResult({
      ok: true,
      status: "completed",
      amountPft: sent.amountPft,
      amountDrops: sent.amountDrops,
      txHash: sent.txHash,
      faucetAddress: sent.faucetAddress,
      message: `${sent.amountPft.toLocaleString("en-US")} PFT USDC top-up grant sent.`,
      grant: completed.grant || reserved.grant,
    });
  } catch (error) {
    const failed = await failWalletInitiationGrant({
      grantId: reserved.internalGrant.id,
      error: error?.message || "usdc_top_up_grant_failed",
      unknown: Boolean(error?.submitted),
    });
    return publicTopUpGrantResult({
      ok: false,
      status: failed.grant?.status || "failed",
      reason: error?.message || "usdc_top_up_grant_failed",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: "USDC top-up credited, but the PFT grant could not be sent yet.",
      grant: failed.grant || reserved.grant,
    });
  }
}

async function resolveUsdcTopUpInitiationGiftStatus({ account = null, entry = null, accountId = "" } = {}) {
  const depositAccount = account || await getEthereumDepositAccount({ accountId });
  if (!depositAccount?.accountId) return null;

  const qualification = await resolveUsdcTopUpGrantQualification({ account: depositAccount, entry });
  if (!qualification) return null;

  const linkedWallet = await getLinkedWallet({ accountId: depositAccount.accountId });
  if (linkedWallet.status !== "linked" || !linkedWallet.address) return null;
  if (!linkedWallet.walletCreatedInAccount) return null;

  const eligibility = await resolveWalletInitiationGrantStatus({
    accountId: depositAccount.accountId,
    walletAddress: linkedWallet.address,
    source: "usdc_top_up",
  });

  if (!eligibility.eligible) {
    if (["account_registered", "wallet_registered"].includes(eligibility.reason)) return null;
    return publicTopUpGrantResult({
      ok: false,
      status: "not_eligible",
      reason: eligibility.reason || "usdc_top_up_grant_not_eligible",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: eligibility.message,
      grant: eligibility.grant || null,
    });
  }

  return publicTopUpGrantResult({
    ok: false,
    status: "local_vault_required",
    reason: "local_vault_required",
    amountPft: eligibility.amountPft,
    amountDrops: eligibility.amountDrops,
    message: `${eligibility.amountPft.toLocaleString("en-US")} PFT USDC top-up grant is ready after the matching local seed vault is unlocked.`,
  });
}

export async function maybeClaimUsdcTopUpInitiationGift({ accountId = "" } = {}) {
  return claimUsdcTopUpInitiationGift({ accountId });
}

function topUpSyncMessage({ account, creditedEntries, pendingSymbols, syncErrors, pftGrant }) {
  const depositMessage = creditedEntries.length > 0
    ? "Deposit credit recorded."
    : pendingSymbols.length > 0
      ? `${pendingSymbols.join(", ")} deposit detected. Waiting for the configured confirmation policy before crediting.`
      : syncErrors.length > 0
        ? "Deposit sync completed with partial data."
        : "No new deposit balance found.";
  const progressMessage = usdcTopUpGrantProgressMessage({ account, pftGrant });

  if (!pftGrant) return [depositMessage, progressMessage].filter(Boolean).join(" ");
  if (pftGrant.ok) return `${depositMessage} ${pftGrant.message}`;
  if (pftGrant.status === "local_vault_required") return `${depositMessage} ${pftGrant.message}`;
  if (pftGrant.status === "not_configured") return `${depositMessage} ${pftGrant.message}`;
  if (pftGrant.status === "failed" || pftGrant.status === "unknown") return `${depositMessage} ${pftGrant.message}`;
  return [depositMessage, progressMessage].filter(Boolean).join(" ");
}

export async function syncEthereumTopUpAccount({ accountId = "" } = {}) {
  const setup = await getOrCreateVerifiedEthereumTopUpAccount({ accountId });
  if (!setup.ok) return setup;

  const account = await getEthereumDepositAccount({ accountId });
  const observedBalances = {};
  const pendingBalances = {};
  const creditedBalances = {};
  const creditedEntries = [];
  const syncErrors = [];

  try {
    for (const asset of ethereumDepositAssets) {
      let balance = null;
      let pendingBalance = null;
      try {
        balance = await readAssetBalance(asset, account.address, balanceBlockTag);
        observedBalances[asset.symbol] = formattedBalance(balance, balanceBlockTag);
      } catch (error) {
        syncErrors.push(`${asset.symbol}: ${error?.message || "balance_unavailable"}`);
        continue;
      }
      try {
        pendingBalance = await readAssetBalance(asset, account.address, pendingBalanceBlockTag);
        if (pendingBalance.raw > balance.raw) {
          pendingBalances[asset.symbol] = {
            ...formattedBalance(pendingBalance, pendingBalanceBlockTag),
            blockTag: pendingBalanceBlockTag,
            creditedRaw: balance.raw.toString(),
            creditedAmount: balance.amount,
            creditedBlockTag: balanceBlockTag,
          };
        } else {
          pendingBalances[asset.symbol] = null;
        }
      } catch {
        pendingBalance = null;
      }

      const firstAssetSync = !hasSyncedAssetBalance(account, asset.symbol);
      const creditedRaw = BigInt(account.creditedBalances?.[asset.symbol]?.raw || "0");
      if (firstAssetSync && balance.raw > 0n) {
        creditedBalances[asset.symbol] = formattedBalance(balance);
        continue;
      }

      let entry = null;
      try {
        entry = await creditDelta({
          account,
          asset,
          currentRaw: balance.raw,
          creditedRaw,
        });
        if (entry) creditedEntries.push(entry);
      } catch (error) {
        syncErrors.push(`${asset.symbol}: ${error?.message || "credit_unavailable"}`);
      }

      if (balance.raw > creditedRaw && (asset.symbol !== "ETH" || entry)) {
        creditedBalances[asset.symbol] = formattedBalance(balance);
      }
    }

    if (Object.keys(observedBalances).length === 0 && syncErrors.length > 0) {
      throw new Error(syncErrors.join("; "));
    }

    const updated = await updateEthereumDepositSync({
      accountId,
      observedBalances,
      pendingBalances,
      creditedBalances,
      syncStatus: syncErrors.length > 0
        ? "partial"
        : Object.values(pendingBalances).some(Boolean)
          ? "pending"
          : "ready",
      syncError: syncErrors.join("; "),
      blockTag: balanceBlockTag,
      creditedEntries,
    });
    const usage = await usageSummary({ accountId });
    const pendingSymbols = Object.entries(pendingBalances)
      .filter(([, balance]) => balance?.amount && Number(balance.amount) > 0)
      .map(([symbol]) => symbol);
    const usdcEntry = creditedEntries.find((entry) => String(entry?.metadata?.asset || "").toUpperCase() === "USDC") || null;
    const pftGrant = await resolveUsdcTopUpInitiationGiftStatus({ account: updated || account, entry: usdcEntry });
    const pftGrants = pftGrant ? [pftGrant] : [];
    return {
      ok: true,
      action: "top_up_sync",
      message: topUpSyncMessage({
        account: updated || account,
        creditedEntries,
        pendingSymbols,
        syncErrors,
        pftGrant,
      }),
      depositAccount: publicDepositAccount(updated || account),
      creditedEntries,
      pftGrant,
      pftGrants,
      syncErrors,
      pendingBalances,
      usage: {
        billingModel: "usage_based",
        currency: "USD",
        currentSpendUsd: usage.currentSpendUsd,
        currentCreditUsd: usage.currentCreditUsd,
        availableCreditUsd: usage.availableCreditUsd,
      },
    };
  } catch (error) {
    const updated = await updateEthereumDepositSync({
      accountId,
      observedBalances,
      pendingBalances,
      syncStatus: "error",
      syncError: error?.message || "ethereum_deposit_sync_failed",
      blockTag: balanceBlockTag,
      creditedEntries,
    });
    return {
      ok: false,
      status: error?.status || 502,
      error: error?.message || "ethereum_deposit_sync_failed",
      action: "top_up_sync",
      message: "Ethereum deposit sync could not complete.",
      depositAccount: publicDepositAccount(updated || account),
    };
  }
}
